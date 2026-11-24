// telnyx-webhook: receives Telnyx Call Control (API v2) webhooks for the dialer's Voice API app and
// its WebRTC credential connection, verifies the Ed25519 signature, and turns them into
// telephony_events rows that each caller's app receives over Supabase Realtime.
//
// MUST be deployed without Supabase JWT verification (Telnyx cannot send one):
//   supabase functions deploy telnyx-webhook --no-verify-jwt
// Authentication is the Telnyx signature: Ed25519 over `${telnyx-timestamp}|${raw body}`.
import {
  AGENT_LEG_DESTINATION,
  agentBridgeBody,
  agentSessionIdOf,
  amdOutcome,
  isPersonResult,
  screeningIntroSpeakBody,
  screeningIntroText,
  base64ToBytes,
  encodeClientState,
  hangupToEndReason,
  isFreshTimestamp,
  parentOfOfferTag,
  parseWebhook,
  rawEd25519PublicKey,
  recordingRef,
  signedMessage,
  type EndReason,
  type ParsedWebhook,
} from '../_shared/telnyxLogic.ts';
import {
  adminClient,
  callCommand,
  emitEvent,
  env,
  loadConfig,
  loadSettings,
  telnyx,
  type TelephonyConfig,
} from '../_shared/telnyx.ts';
import {
  bridgeInbound,
  claimInbound,
  closeOffersOnParentEnd,
  endOffer,
  isOfferRow,
  isRingOffer,
  loadCall,
  onRingLegEnded,
  speakMissed,
  startInbound,
  winnerOfferId,
  type InboundRow,
} from '../_shared/telnyxInbound.ts';

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

let cachedKey: { b64: string; key: CryptoKey } | null = null;

async function verifyKey(b64: string): Promise<CryptoKey | null> {
  if (cachedKey?.b64 === b64) return cachedKey.key;
  const bytes = base64ToBytes(b64);
  const raw = bytes ? rawEd25519PublicKey(bytes) : null;
  if (!raw) return null;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  cachedKey = { b64, key };
  return key;
}

async function verifySignature(req: Request, rawBody: string, cfg: TelephonyConfig | null): Promise<boolean> {
  const sig = req.headers.get('telnyx-signature-ed25519');
  const ts = req.headers.get('telnyx-timestamp');
  if (!sig || !isFreshTimestamp(ts, Math.floor(Date.now() / 1000))) return false;
  const pub = env('TELNYX_PUBLIC_KEY') ?? cfg?.webhook_public_key ?? null;
  if (!pub) {
    console.error('No webhook public key configured; rejecting webhook. Run telnyx-setup.');
    return false;
  }
  const key = await verifyKey(pub);
  const sigBytes = base64ToBytes(sig);
  if (!key || !sigBytes) return false;
  return crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, new TextEncoder().encode(signedMessage(ts!, rawBody)));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 });
  const rawBody = await req.text();
  const cfg = await loadConfig().catch(() => null);
  if (!(await verifySignature(req, rawBody, cfg))) return new Response('invalid signature', { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const w = parseWebhook(body);
  if (!w) return new Response('ignored', { status: 200 });

  const db = adminClient();
  // De-duplicate deliveries by Telnyx event id.
  const { error: dupErr } = await db.from('telephony_webhook_events').insert({ event_id: w.eventId, event_type: w.eventType });
  if (dupErr) {
    if ((dupErr as { code?: string }).code === '23505') return new Response('duplicate', { status: 200 });
    return new Response('db error', { status: 500 });
  }

  try {
    await dispatch(w, cfg);
  } catch (e) {
    console.error(`webhook ${w.eventType} failed:`, e instanceof Error ? e.message : String(e));
    // Let Telnyx retry this event.
    await db.from('telephony_webhook_events').delete().eq('event_id', w.eventId);
    return new Response('error', { status: 500 });
  }
  return new Response('ok', { status: 200 });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** A telephony_calls row (outbound lead leg, inbound parent, or inbound offer). */
type CallRow = InboundRow & { machine: boolean; classify: boolean; wait_for_greeting:boolean; media_phase: string | null; has_screening: boolean; has_voicemail: boolean };

async function findCall(w: ParsedWebhook): Promise<CallRow | null> {
  const db = adminClient();
  const cs = w.clientState;
  if (cs && (cs.k === 'out' || cs.k === 'in' || cs.k === 'ring')) {
    const { data,error } = await db.from('telephony_calls').select('*').eq('id', cs.id).maybeSingle();
    if(error) throw error;
    if (data) return data as CallRow;
  }
  if (w.callControlId) {
    const { data,error } = await db.from('telephony_calls').select('*').eq('call_control_id', w.callControlId).maybeSingle();
    if(error) throw error;
    if (data) return data as CallRow;
  }
  if (w.callLegId) {
    const { data,error } = await db.from('telephony_calls').select('*').eq('call_leg_id', w.callLegId).maybeSingle();
    if(error) throw error;
    if (data) return data as CallRow;
  }
  return null;
}

async function dispatch(w: ParsedWebhook, cfg: TelephonyConfig | null): Promise<void> {
  const onCredentialConnection = !!cfg?.credential_connection_id && w.connectionId === cfg.credential_connection_id;
  // A ring leg's far side as seen by the credential connection (if Telnyx reports it): not ours to control.
  if (w.clientState?.k === 'ring' && onCredentialConnection) return;
  const isAgentLeg = w.clientState?.k === 'agent' || onCredentialConnection;
  if (isAgentLeg) return handleAgentLeg(w);

  const row = await findCall(w);
  if (row) {
    if (row.direction === 'outbound') return handleOutbound(w, row);
    if (isOfferRow(row)) return handleRingLeg(w, row);
    return handleInbound(w, row);
  }

  if (w.kind === 'initiated' && w.direction === 'incoming' && cfg?.voice_app_id && w.connectionId === cfg.voice_app_id) {
    return startInbound(w);
  }
  // Anything else (events for calls we do not know) is ignored.
}

// ---------------------------------------------------------------------------
// Agent leg (the caller's parked WebRTC call)
// ---------------------------------------------------------------------------

async function handleAgentLeg(w: ParsedWebhook): Promise<void> {
  const db = adminClient();
  const ccid = w.callControlId;
  if (w.kind === 'initiated') {
    const sid = agentSessionIdOf(w);
    const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: session } = sid
      ? await db
          .from('agent_sessions')
          .select('id, caller_id, status')
          .eq('id', sid)
          .eq('status', 'pending')
          .gte('created_at', fresh)
          .maybeSingle()
      : { data: null };
    if (!session || !ccid) {
      // Not one of our app's sessions: do not leave a parked leg around. Only the app's own
      // outgoing agent-leg attempts are hung up; a call ringing INTO a caller's app (a callback
      // offer, placed by the Voice API app) is left alone.
      const isAgentAttempt = sid !== null || (w.to ?? '').toLowerCase().includes(AGENT_LEG_DESTINATION) || w.state === 'parked';
      if (ccid && isAgentAttempt) await callCommand(ccid, 'hangup', {});
      return;
    }
    await db
      .from('agent_sessions')
      .update({ status: 'live', call_control_id: ccid, call_leg_id: w.callLegId, live_at: new Date().toISOString() })
      .eq('id', session.id);
    // Answer the parked leg so the caller's audio path is up while waiting for lead pickups.
    await callCommand(ccid, 'answer', {
      client_state: encodeClientState({ v: 1, k: 'agent', sid: session.id as string }),
      command_id: `agent-${session.id}`,
    });
    return;
  }
  if (w.kind === 'hangup' && ccid) {
    await db
      .from('agent_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('call_control_id', ccid)
      .neq('status', 'ended');
  }
}

// ---------------------------------------------------------------------------
// Outbound lead legs
// ---------------------------------------------------------------------------

export async function handleOutbound(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const callerId = row.caller_id;
  if (w.eventType === 'call.playback.ended' && row.media_phase === 'voicemail' && w.clientState?.k === 'out' && w.clientState.playback === 'voicemail' && w.callControlId) {
    await callCommand(w.callControlId,'hangup',{command_id:'vm-end-'+row.id});
    return;
  }
  switch (w.kind) {
    case 'initiated': {
      const patch: Record<string, unknown> = { status: 'ringing' };
      if (!row.call_control_id && w.callControlId) patch.call_control_id = w.callControlId;
      if (!row.call_leg_id && w.callLegId) patch.call_leg_id = w.callLegId;
      const { data } = await db.from('telephony_calls').update(patch).eq('id', row.id).eq('status', 'dialing').select('id');
      if (data?.length && callerId) await emitEvent({ callerId, callId: row.id, type: 'ringing' });
      return;
    }
    case 'answered':
      // Recorded messages or a screening intro need the greeting first, so the caller is joined only
      // once a person is confirmed. Otherwise the caller is joined the moment anyone picks up (no dead
      // air for a real person) and the voicemail check keeps running; voicemail is hung up by the app.
      if (row.classify && row.wait_for_greeting) {
        if (callerId && row.status !== 'ended') await emitEvent({callerId,callId:row.id,type:'checking'});
        return;
      }
      return answerOutbound(w, row);
    case 'bridged':
      if (callerId && row.status === 'answered' && !row.local_end_reason)
        await emitEvent({callerId,callId:row.id,type:'answered'});
      return;
    case 'machine':
      return onMachineEvent(w, row);
    case 'hangup':
      return endCall(w, row);
    case 'recording_saved':
      return attachRecording(w, row);
    default:
      return;
  }
}

/**
 * A lead picked up. telephony_answer_outbound marks the call answered, decides (under a lock on the
 * agent session) whether this pickup gets the caller, and writes the `answered` event. The winner
 * is bridged from the agent leg, which is parked again when the lead's call ends; a second pickup
 * or a pickup with no open audio line is hung up.
 */
async function answerOutbound(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const { data, error } = await db.rpc('telephony_answer_outbound', {
    p_call: row.id,
    p_at: w.occurredAt ?? new Date().toISOString(),
  });
  if (error) throw new Error(`answer_outbound: ${error.message}`);
  const res = (data ?? {}) as { result?: string; agent_call_control_id?: string | null };
  const leadCcid = w.callControlId ?? row.call_control_id;
  if (res.result === 'stale' || !leadCcid) return;

  const dropLead = async (reason: 'hangup_local' | 'failed') => {
    await db.from('telephony_calls').update({ local_end_reason: reason }).eq('id', row.id).is('local_end_reason', null);
    await callCommand(leadCcid, 'hangup', { command_id: `drop-${row.id}` });
  };

  if (res.result === 'won' && res.agent_call_control_id) {
    try {
      await callCommand(res.agent_call_control_id, 'bridge', agentBridgeBody(leadCcid, row.id), false);
    } catch (e) {
      console.error('bridge to the agent leg failed:', e instanceof Error ? e.message : String(e));
      await dropLead('failed');
    }
    return;
  }
  // 'lost' (another line already has the caller; the app also hangs up on it) or 'no_agent'.
  await dropLead(res.result === 'lost' ? 'hangup_local' : 'failed');
}

/**
 * Answering-machine detection on an answered lead call. Voicemail -> `machine` event (the app hangs
 * up). With a screening intro set, a first "machine" result is only a suspicion: iPhone call
 * screening also answers as a machine, so we wait for the greeting to end. If it was a screener, the
 * intro is spoken to it and the call stays up so the person can pick up; a voicemail beep (or no
 * beep) still hangs up.
 */
async function onMachineEvent(w: ParsedWebhook, row: CallRow): Promise<void> {
  const ccid = w.callControlId ?? row.call_control_id;
  if (!ccid || !row.caller_id || row.status === 'ended' || row.local_end_reason) return;
  const outcome = amdOutcome(w.eventType, w.machineResult);
  // Telnyx: treat "not sure" as a person. "Silence" is often a person waiting for us to speak.
  const person = isPersonResult(w.eventType, w.machineResult);
  if (!row.classify || !row.wait_for_greeting) {
    // The caller was joined at pickup: confirm a person (the app then drops its other lines) or
    // report voicemail (the app hangs up and keeps dialing).
    if (row.status !== 'answered') {
      if (person && row.classify) return answerOutbound(w, row);
      return;
    }
    if (person) {
      if (row.classify) await emitEvent({callerId:row.caller_id,callId:row.id,type:'human'});
      return;
    }
    if (outcome === 'voicemail' || outcome === 'suspect')
      await emitEvent({callerId:row.caller_id,callId:row.id,type:'machine'});
    return;
  }
  // Replaying the human result can finish an interrupted bridge command. Its command id is stable.
  if (person) return answerOutbound(w,row);
  if (row.status === 'answered') return;
  // A tone identifies the screener. Only the end of its question invites a response.
  const isPrompt = w.machineResult === 'prompt_ended';
  if (outcome === 'screening' && !isPrompt) {
    await emitEvent({callerId:row.caller_id,callId:row.id,type:'screening'});
    return;
  }
  if (!isPrompt && outcome !== 'voicemail' && !(outcome==='suspect' && !row.wait_for_greeting)) return;
  const phase = isPrompt ? 'screening' : 'voicemail';
  let update = adminClient().from('telephony_calls').update({media_phase:phase,machine:true})
    .eq('id',row.id).in('status',['dialing','ringing']).is('local_end_reason',null);
  if (isPrompt) update = update.or('media_phase.is.null,media_phase.eq.screening');
  const {data,error} = await update.select('id');
  if (error) throw error;
  if (!data?.length) return;
  await emitEvent({callerId:row.caller_id,callId:row.id,type:phase});
  if (isPrompt ? row.has_screening : row.has_voicemail && w.machineResult === 'beep_detected') {
    const {data:file,error:signError} = await adminClient().storage.from('caller-messages')
      .createSignedUrl(row.caller_id+'/'+phase+'.wav',300);
    if (signError) throw signError;
    await callCommand(ccid,'playback_start',{audio_url:file.signedUrl,command_id:phase+'-'+row.id,
      client_state:encodeClientState({v:1,k:'out',id:row.id,playback:phase})});
  } else if (isPrompt) {
    const settings = await loadSettings();
    const {data:who} = await adminClient().from('profiles').select('full_name').eq('id',row.caller_id).maybeSingle();
    const intro = screeningIntroText(settings.screening_intro,who?.full_name);
    if (intro) {
      try {await callCommand(ccid,'speak',screeningIntroSpeakBody(intro,row.id));}
      catch {await callCommand(ccid,'speak',screeningIntroSpeakBody(intro,row.id,true));}
    }
    else await callCommand(ccid,'hangup',{command_id:'no-intro-'+row.id});
  } else {
    await callCommand(ccid,'hangup',{command_id:'vm-end-'+row.id});
  }
}

async function endCall(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const h = w.hangup ?? { cause: null, source: null, sipCode: null };
  const answered = row.answered_at !== null;
  const reason: EndReason =
    row.local_end_reason && row.local_end_reason !== 'hangup_local'
      ? row.local_end_reason
      : hangupToEndReason({
          direction: row.direction,
          answered,
          localRequested: row.local_end_reason === 'hangup_local',
          ...h,
        });
  const endedAt = w.occurredAt ?? new Date().toISOString();
  const { data, error: endError } = await db
    .from('telephony_calls')
    .update({ status: 'ended', end_reason: reason, hangup_cause: h.cause, sip_code: h.sipCode, ended_at: endedAt })
    .eq('id', row.id)
    .neq('status', 'ended')
    .select('id');
  if (endError) throw endError;
  if (!data?.length) return; // already ended: exactly one `ended` per call
  if (row.direction === 'outbound') {
    if (row.caller_id) await emitEvent({ callerId: row.caller_id, callId: row.id, type: 'ended', reason });
  } else {
    // The app knows inbound calls only by their offer ids: end the winner's (or every ringing) offer.
    await closeOffersOnParentEnd(row, reason, answered);
  }

  if (row.direction === 'inbound' && !answered) {
    // Nobody took it (declined, timed out, no session, or the lead gave up): log a missed inbound.
    const { error } = await db.from('calls').insert({
      lead_id: row.lead_id,
      caller_id: row.caller_id,
      direction: 'inbound',
      from_number: row.from_number,
      to_number: row.to_number,
      ring: 1,
      started_at: row.created_at,
      answered_at: null,
      ended_at: endedAt,
      talk_seconds: 0,
      result: 'missed_inbound',
      provider_call_id: row.id,
    });
    if (error) console.error('missed_inbound insert failed:', error.message);
  }
}


async function attachRecording(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  let recordingId = row.recording_id;
  if (!recordingId && w.callLegId) {
    // Recordings started by record_start (inbound) are not returned by the command; look them up.
    const qs = new URLSearchParams({ 'filter[call_leg_id]': w.callLegId, 'page[size]': '5' });
    const res = await telnyx<{ data: { id: string; created_at?: string }[] }>('GET', `/recordings?${qs}`);
    recordingId = res.data?.[0]?.id ?? null;
  }
  if (!recordingId) {
    console.error('call.recording.saved without a resolvable recording id for call', row.id);
    return;
  }
  // An inbound call's CallRecord is created by the app with the winner's OFFER id as provider_call_id.
  const offerId = row.direction === 'inbound' ? winnerOfferId(row) : null;
  const ids = offerId ? [row.id, offerId] : [row.id];
  await db
    .from('telephony_calls')
    .update({ recording_id: recordingId, recording_saved_at: new Date().toISOString() })
    .in('id', ids);
  // If the app has already created the CallRecord, attach now; otherwise the calls trigger does it.
  await db.from('calls').update({ recording_url: recordingRef(recordingId) }).in('provider_call_id', ids).is('recording_url', null);
}

// ---------------------------------------------------------------------------
// Inbound calls: the PSTN leg (parent row). Routing lives in _shared/telnyxInbound.ts.
// ---------------------------------------------------------------------------

async function handleInbound(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const ccid = w.callControlId ?? row.call_control_id;
  const st = w.clientState?.k === 'in' ? w.clientState.st : undefined;
  switch (w.kind) {
    case 'answered': {
      if (!ccid) return;
      if (st === 'polite' || row.status === 'declining') {
        await speakMissed(ccid, row.id);
        return;
      }
      if (st === 'bridge' || row.status === 'answering') {
        const parent = (await loadCall(row.id)) ?? row;
        const result = await bridgeInbound(w, parent);
        if (result === 'no_agent') {
          // The winner's audio leg is gone: apologise instead of leaving the person in silence.
          await db.from('telephony_calls').update({ status: 'declining', local_end_reason: 'failed' }).eq('id', row.id);
          await closeOffersOnParentEnd(parent, 'failed', false);
          await speakMissed(ccid, row.id);
          return;
        }
        const { data } = await db
          .from('telephony_calls')
          .update({ status: 'answered', answered_at: w.occurredAt ?? new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'answering')
          .select('id');
        const offerId = winnerOfferId(parent);
        if (data?.length && parent.caller_id && offerId) {
          await emitEvent({ callerId: parent.caller_id, callId: offerId, type: 'answered' });
        }
        const settings = await loadSettings();
        if (settings.record_calls) {
          await db.from('telephony_calls').update({ record: true }).eq('id', row.id);
          await callCommand(ccid, 'record_start', {
            format: 'mp3',
            channels: 'dual',
            trim: 'trim-silence',
            client_state: encodeClientState({ v: 1, k: 'in', id: row.id }),
          }).catch((e) => console.error('record_start failed:', e instanceof Error ? e.message : String(e)));
        }
      }
      return;
    }
    case 'speak_ended': {
      if ((st === 'polite' || row.status === 'declining') && ccid) await callCommand(ccid, 'hangup', {});
      return;
    }
    case 'hangup':
      return endCall(w, row);
    case 'recording_saved':
      return attachRecording(w, row);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Ring legs: the Voice API app ringing a signed-in caller's app with a callback (offer rows).
// ---------------------------------------------------------------------------

async function handleRingLeg(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const offer = (await loadCall(row.id)) ?? row;
  const parentId = parentOfOfferTag(offer.call_session_id);
  if (!parentId || !isRingOffer(offer)) return;
  const ccid = w.callControlId ?? offer.call_control_id;
  switch (w.kind) {
    case 'initiated': {
      if (!offer.call_control_id && ccid) {
        await db.from('telephony_calls').update({ call_control_id: ccid, call_leg_id: w.callLegId }).eq('id', offer.id);
      }
      return;
    }
    case 'answered': {
      // The caller pressed Answer in the app.
      if (offer.status !== 'incoming' || !offer.caller_id || !ccid) {
        await endOffer({ ...offer, call_control_id: ccid }, 'hangup_remote');
        return;
      }
      await db
        .from('agent_sessions')
        .update({ status: 'live', call_control_id: ccid, live_at: new Date().toISOString() })
        .eq('id', offer.agent_session_id!)
        .neq('status', 'ended');
      const won = await claimInbound({ ...offer, call_control_id: ccid }, offer.agent_session_id!);
      if (!won) {
        // Someone else answered first, or the missed-call message has started.
        await endOffer({ ...offer, call_control_id: ccid }, 'hangup_remote');
      }
      return;
    }
    case 'hangup':
      return onRingLegEnded(offer);
    default:
      return;
  }
}

