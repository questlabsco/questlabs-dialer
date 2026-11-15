// telnyx-webhook: receives Telnyx Call Control (API v2) webhooks for the dialer's Voice API app and
// its WebRTC credential connection, verifies the Ed25519 signature, and turns them into
// telephony_events rows that each caller's app receives over Supabase Realtime.
//
// MUST be deployed without Supabase JWT verification (Telnyx cannot send one):
//   supabase functions deploy telnyx-webhook --no-verify-jwt
// Authentication is the Telnyx signature: Ed25519 over `${telnyx-timestamp}|${raw body}`.
import {
  agentSessionIdOf,
  base64ToBytes,
  encodeClientState,
  hangupToEndReason,
  isFreshTimestamp,
  normalizeTelnyxNumber,
  parseWebhook,
  POLITE_MISSED_MESSAGE,
  POLITE_VOICE,
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
  liveAgentSession,
  loadConfig,
  loadSettings,
  telnyx,
  type TelephonyConfig,
} from '../_shared/telnyx.ts';

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

interface CallRow {
  id: string;
  caller_id: string | null;
  lead_id: string | null;
  direction: 'outbound' | 'inbound';
  from_number: string;
  to_number: string;
  status: string;
  call_control_id: string | null;
  call_leg_id: string | null;
  agent_session_id: string | null;
  record: boolean;
  recording_id: string | null;
  machine: boolean;
  local_end_reason: EndReason | null;
  created_at: string;
  answered_at: string | null;
}

async function findCall(w: ParsedWebhook): Promise<CallRow | null> {
  const db = adminClient();
  const cs = w.clientState;
  if (cs && (cs.k === 'out' || cs.k === 'in')) {
    const { data } = await db.from('telephony_calls').select('*').eq('id', cs.id).maybeSingle();
    if (data) return data as CallRow;
  }
  if (w.callControlId) {
    const { data } = await db.from('telephony_calls').select('*').eq('call_control_id', w.callControlId).maybeSingle();
    if (data) return data as CallRow;
  }
  if (w.callLegId) {
    const { data } = await db.from('telephony_calls').select('*').eq('call_leg_id', w.callLegId).maybeSingle();
    if (data) return data as CallRow;
  }
  return null;
}

async function dispatch(w: ParsedWebhook, cfg: TelephonyConfig | null): Promise<void> {
  const isAgentLeg =
    w.clientState?.k === 'agent' || (!!cfg?.credential_connection_id && w.connectionId === cfg.credential_connection_id);
  if (isAgentLeg) return handleAgentLeg(w);

  const row = await findCall(w);
  if (row) return row.direction === 'outbound' ? handleOutbound(w, row) : handleInbound(w, row);

  if (w.kind === 'initiated' && w.direction === 'incoming' && cfg?.voice_app_id && w.connectionId === cfg.voice_app_id) {
    return handleNewInbound(w);
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
      // Not one of our app's sessions: do not leave a parked leg around.
      if (ccid) await callCommand(ccid, 'hangup', {});
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

async function handleOutbound(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const callerId = row.caller_id;
  switch (w.kind) {
    case 'initiated': {
      const patch: Record<string, unknown> = { status: 'ringing' };
      if (!row.call_control_id && w.callControlId) patch.call_control_id = w.callControlId;
      if (!row.call_leg_id && w.callLegId) patch.call_leg_id = w.callLegId;
      const { data } = await db.from('telephony_calls').update(patch).eq('id', row.id).eq('status', 'dialing').select('id');
      if (data?.length && callerId) await emitEvent({ callerId, callId: row.id, type: 'ringing' });
      return;
    }
    case 'answered': {
      const { data } = await db
        .from('telephony_calls')
        .update({ status: 'answered', answered_at: w.occurredAt ?? new Date().toISOString() })
        .eq('id', row.id)
        .in('status', ['dialing', 'ringing'])
        .select('id');
      if (data?.length && callerId) await emitEvent({ callerId, callId: row.id, type: 'answered' });
      return;
    }
    case 'machine': {
      if (!w.isMachine) return;
      const { data } = await db
        .from('telephony_calls')
        .update({ machine: true })
        .eq('id', row.id)
        .eq('status', 'answered')
        .eq('machine', false)
        .select('id');
      if (data?.length && callerId) await emitEvent({ callerId, callId: row.id, type: 'machine' });
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
  const { data } = await db
    .from('telephony_calls')
    .update({ status: 'ended', end_reason: reason, hangup_cause: h.cause, sip_code: h.sipCode, ended_at: endedAt })
    .eq('id', row.id)
    .neq('status', 'ended')
    .select('id');
  if (!data?.length) return; // already ended: exactly one `ended` per call
  // Inbound calls only reached the app (an `incoming` event) when a live agent session was found.
  const appKnowsCall = row.direction === 'outbound' || row.agent_session_id !== null;
  if (row.caller_id && appKnowsCall) await emitEvent({ callerId: row.caller_id, callId: row.id, type: 'ended', reason });

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
  await db
    .from('telephony_calls')
    .update({ recording_id: recordingId, recording_saved_at: new Date().toISOString() })
    .eq('id', row.id);
  // If the app has already created the CallRecord, attach now; otherwise the calls trigger does it.
  await db.from('calls').update({ recording_url: recordingRef(recordingId) }).eq('provider_call_id', row.id).is('recording_url', null);
}

// ---------------------------------------------------------------------------
// Inbound calls
// ---------------------------------------------------------------------------

async function handleNewInbound(w: ParsedWebhook): Promise<void> {
  const db = adminClient();
  const from = normalizeTelnyxNumber(w.from) ?? w.from ?? 'unknown';
  const to = normalizeTelnyxNumber(w.to) ?? w.to ?? 'unknown';
  const id = crypto.randomUUID();

  const { data: lead } = await db
    .from('leads')
    .select('id, last_called_by')
    .contains('phones', [from])
    .order('last_called_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  let target: string | null = (lead?.last_called_by as string | null) ?? null;
  if (target) {
    const { data: prof } = await db.from('profiles').select('active').eq('id', target).maybeSingle();
    if (!prof?.active) target = null;
  }
  const session = target ? await liveAgentSession(target) : null;

  await db.from('telephony_calls').insert({
    id,
    caller_id: target,
    lead_id: (lead?.id as string | undefined) ?? null,
    direction: 'inbound',
    from_number: from,
    to_number: to,
    ring: 1,
    status: session ? 'incoming' : 'declining',
    call_control_id: w.callControlId,
    call_leg_id: w.callLegId,
    call_session_id: w.callSessionId,
    agent_session_id: session?.id ?? null,
    local_end_reason: session ? null : 'no_answer',
  });

  if (session && target) {
    // Ring the caller's app. The app answers / declines via telnyx-call, or declines politely after
    // INBOUND_RING_SECONDS; the Voice API app's first-command timeout is the server-side backstop.
    await emitEvent({ callerId: target, callId: id, type: 'incoming', from, to });
    return;
  }
  // Nobody can take it: answer, apologise, hang up.
  if (w.callControlId) {
    await callCommand(w.callControlId, 'answer', {
      client_state: encodeClientState({ v: 1, k: 'in', id, st: 'polite' }),
      command_id: `polite-${id}`,
    });
  }
}

async function handleInbound(w: ParsedWebhook, row: CallRow): Promise<void> {
  const db = adminClient();
  const ccid = w.callControlId ?? row.call_control_id;
  const st = w.clientState?.k === 'in' ? w.clientState.st : undefined;
  switch (w.kind) {
    case 'answered': {
      if (!ccid) return;
      if (st === 'polite' || row.status === 'declining') {
        await callCommand(ccid, 'speak', {
          payload: POLITE_MISSED_MESSAGE,
          voice: POLITE_VOICE,
          language: 'en-US',
          client_state: encodeClientState({ v: 1, k: 'in', id: row.id, st: 'polite' }),
        });
        return;
      }
      if (st === 'bridge' || row.status === 'answering') {
        const agent = row.caller_id ? await liveAgentSession(row.caller_id) : null;
        if (!agent) {
          await db.from('telephony_calls').update({ status: 'declining', local_end_reason: 'failed' }).eq('id', row.id);
          await callCommand(ccid, 'speak', {
            payload: POLITE_MISSED_MESSAGE,
            voice: POLITE_VOICE,
            language: 'en-US',
            client_state: encodeClientState({ v: 1, k: 'in', id: row.id, st: 'polite' }),
          });
          return;
        }
        // Bridge from the agent leg so that the AGENT leg is parked (not hung up) when the lead leaves.
        await callCommand(
          agent.call_control_id,
          'bridge',
          { call_control_id: ccid, park_after_unbridge: 'self', prevent_double_bridge: true, command_id: `bridge-${row.id}` },
          false,
        );
        const { data } = await db
          .from('telephony_calls')
          .update({ status: 'answered', answered_at: w.occurredAt ?? new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'answering')
          .select('id');
        if (data?.length && row.caller_id) await emitEvent({ callerId: row.caller_id, callId: row.id, type: 'answered' });
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
