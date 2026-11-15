// Inbound calls (people calling back) for telnyx-webhook and telnyx-call.
//
// Model (no schema change; see telnyxLogic.ts "Inbound call routing"):
// - The inbound PSTN leg is one PARENT telephony_calls row (direction 'inbound'). Its caller_id is
//   the caller who last dialed the number (rule 1a) until someone answers; then it is the winner.
// - Every caller the call is offered to gets an OFFER row (direction 'inbound', caller_id = them,
//   call_session_id = offerTag(parent id), id = offerIdFor(parent, caller)). The app only ever sees
//   offer ids: `incoming`, `answered` and `ended` events carry the offer id.
// - An offer reaches the app one of two ways:
//     'agent_leg' - the caller is dialing / paused and has a live agent leg: the app shows the
//                   banner and answers through telnyx-call; the PSTN leg is bridged to that leg.
//     'sip'       - the caller is only signed in (WebRTC client registered, no open call leg): the
//                   Voice API app dials sip:<sip_username>@sip.telnyx.com (Telnyx WebRTC
//                   "Pattern 2"); the app answers that call with the SDK; on its call.answered we
//                   answer the PSTN leg and bridge the two. An agent_sessions row (ringSessionIdFor)
//                   tracks that leg while it lasts.
// - Timing (server side, EdgeRuntime.waitUntil): the last dialer alone for INBOUND_FIRST_OFFER_SECONDS,
//   then everyone else who is free until INBOUND_TOTAL_RING_SECONDS, then MISSED_CALLBACK_SPEECH and a
//   missed_inbound CallRecord. Rings that end early (declined / not registered) advance at once.
import {
  buildRingBody,
  encodeClientState,
  INBOUND_FIRST_OFFER_SECONDS,
  INCOMING_ON_DEVICE,
  INBOUND_TOTAL_RING_SECONDS,
  missedCallbackSpeakBody,
  nextInboundStep,
  normalizeTelnyxNumber,
  offerIdFor,
  offerTag,
  othersRingSeconds,
  parentOfOfferTag,
  planInboundRouting,
  ringSessionIdFor,
  type EndReason,
  type InboundCandidate,
  type InboundOffer,
  type ParsedWebhook,
  type PresenceStatusLite,
} from './telnyxLogic.ts';
import { adminClient, callCommand, emitEvent, liveAgentSession, loadConfig, telnyx } from './telnyx.ts';

export interface InboundRow {
  id: string;
  caller_id: string | null;
  lead_id: string | null;
  direction: 'outbound' | 'inbound';
  from_number: string;
  to_number: string;
  status: string;
  call_control_id: string | null;
  call_leg_id: string | null;
  call_session_id: string | null;
  agent_session_id: string | null;
  record: boolean;
  recording_id: string | null;
  local_end_reason: EndReason | null;
  created_at: string;
  answered_at: string | null;
}

const RINGING = ['incoming', 'answering', 'declining'];

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True for an offer row (as opposed to a parent row or an outbound call). */
export function isOfferRow(row: { call_session_id: string | null }): boolean {
  return parentOfOfferTag(row.call_session_id) !== null;
}

/** An offer that rings the caller's app directly (has its own Telnyx leg). */
export function isRingOffer(offer: InboundRow): boolean {
  return offer.agent_session_id === ringSessionIdFor(offer.id);
}

export async function loadCall(id: string): Promise<InboundRow | null> {
  const { data } = await adminClient().from('telephony_calls').select('*').eq('id', id).maybeSingle();
  return (data as InboundRow | null) ?? null;
}

export async function loadOffers(parentId: string): Promise<InboundRow[]> {
  const { data } = await adminClient().from('telephony_calls').select('*').eq('call_session_id', offerTag(parentId));
  return (data ?? []) as InboundRow[];
}

/** The winner's offer id for an answered parent (null while nobody has it). */
export function winnerOfferId(parent: InboundRow): string | null {
  return parent.caller_id && parent.agent_session_id ? offerIdFor(parent.id, parent.caller_id) : null;
}

// ---------------------------------------------------------------------------
// Background timers
// ---------------------------------------------------------------------------

function background(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const safe = p.catch((e) => console.error('inbound timer failed:', errText(e)));
  if (rt?.waitUntil) rt.waitUntil(safe);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scheduleTimers(parentId: string, hasFirstRound: boolean): void {
  if (hasFirstRound) {
    background(sleep(INBOUND_FIRST_OFFER_SECONDS * 1000).then(() => advanceInbound(parentId, { cancel: 'first' })));
  }
  background(sleep(INBOUND_TOTAL_RING_SECONDS * 1000).then(() => advanceInbound(parentId, { cancel: 'all' })));
}

// ---------------------------------------------------------------------------
// New inbound call
// ---------------------------------------------------------------------------

export async function startInbound(w: ParsedWebhook): Promise<void> {
  const db = adminClient();
  const from = normalizeTelnyxNumber(w.from) ?? w.from ?? 'unknown';
  const to = normalizeTelnyxNumber(w.to) ?? w.to ?? 'unknown';
  const id = crypto.randomUUID();

  // Rule 1a: the caller who most recently called this number (lead or not).
  const { data: lastCall } = await db
    .from('calls')
    .select('caller_id, lead_id')
    .eq('direction', 'outbound')
    .eq('to_number', from)
    .not('caller_id', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let leadId = (lastCall?.lead_id as string | null | undefined) ?? null;
  let preferred = (lastCall?.caller_id as string | null | undefined) ?? null;
  if (!leadId || !preferred) {
    const { data: lead } = await db
      .from('leads')
      .select('id, last_called_by')
      .contains('phones', [from])
      .order('last_called_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    leadId = leadId ?? ((lead?.id as string | undefined) ?? null);
    preferred = preferred ?? ((lead?.last_called_by as string | null | undefined) ?? null);
  }

  const { error } = await db.from('telephony_calls').insert({
    id,
    caller_id: preferred,
    lead_id: leadId,
    direction: 'inbound',
    from_number: from,
    to_number: to,
    ring: 1,
    status: 'incoming',
    call_control_id: w.callControlId,
    call_leg_id: w.callLegId,
    call_session_id: w.callSessionId,
  });
  if (error) {
    // Same call delivered twice under a new event id: the first insert owns it.
    if ((error as { code?: string }).code === '23505') return;
    throw new Error(`inbound insert failed: ${error.message}`);
  }
  const parent = await loadCall(id);
  if (!parent) return;

  const plan = planInboundRouting({ preferredCallerId: preferred, candidates: await loadCandidates(), nowMs: Date.now() });
  if (plan.first.length) {
    await createOffers(parent, plan.first, INBOUND_FIRST_OFFER_SECONDS);
    scheduleTimers(id, true);
    // The ring may have failed at once (app not reachable): move on to everyone else now.
    await advanceInbound(id, {});
    return;
  }
  if (plan.others.length) {
    await createOffers(parent, plan.others, INBOUND_TOTAL_RING_SECONDS);
    scheduleTimers(id, false);
    // Every ring may have failed at once (nobody reachable).
    await advanceInbound(id, {});
    return;
  }
  await fallbackInbound(id);
}

/** Every active caller, with what we know about whether they can take a call now. */
async function loadCandidates(): Promise<InboundCandidate[]> {
  const db = adminClient();
  const { data: people } = await db.from('profiles').select('id').eq('role', 'caller').eq('active', true);
  const ids = (people ?? []).map((p) => p.id as string);
  if (!ids.length) return [];
  const since = new Date(Date.now() - 4 * 3600_000).toISOString();
  const recent = new Date(Date.now() - 2 * 60_000).toISOString();
  const [presence, creds, sessions, busyCalls, ringing] = await Promise.all([
    db.from('presence').select('caller_id, status, updated_at').in('caller_id', ids),
    db.from('telephony_credentials').select('profile_id, credential_id, connection_id, sip_username').in('profile_id', ids),
    db
      .from('agent_sessions')
      .select('id, caller_id, call_control_id, live_at')
      .in('caller_id', ids)
      .eq('status', 'live')
      .not('call_control_id', 'is', null)
      .order('live_at', { ascending: false }),
    db
      .from('telephony_calls')
      .select('caller_id')
      .in('caller_id', ids)
      .in('status', ['answering', 'answered'])
      .gte('created_at', since),
    // Only OFFERS count as "already ringing". The inbound call's own parent row is also 'incoming'
    // and carries the caller who last dialed the number, so counting it marked exactly the person
    // the call should go to as busy, and every callback fell straight through to the message.
    db
      .from('telephony_calls')
      .select('caller_id')
      .in('caller_id', ids)
      .eq('status', 'incoming')
      .like('call_session_id', `${offerTag('')}%`)
      .gte('created_at', recent),
  ]);
  const cfg = await loadConfig().catch(() => null);
  const busy = new Set<string>();
  for (const r of busyCalls.data ?? []) busy.add(r.caller_id as string);
  for (const r of ringing.data ?? []) busy.add(r.caller_id as string);
  const live = new Map<string, string>();
  for (const s of sessions.data ?? []) {
    // Ring sessions only exist during a callback (the caller is busy then anyway).
    if (!live.has(s.caller_id as string)) live.set(s.caller_id as string, s.id as string);
  }
  const pres = new Map((presence.data ?? []).map((p) => [p.caller_id as string, p]));
  const cred = new Map((creds.data ?? []).map((c) => [c.profile_id as string, c]));

  const out: InboundCandidate[] = [];
  for (const callerId of ids) {
    const p = pres.get(callerId);
    const c = cred.get(callerId);
    let sipUsername: string | null = null;
    if (c && (!cfg?.credential_connection_id || c.connection_id === cfg.credential_connection_id)) {
      sipUsername = (c.sip_username as string | null) ?? null;
      if (!sipUsername && p && p.status !== 'offline') sipUsername = await fetchSipUsername(callerId, c.credential_id as string);
    }
    out.push({
      callerId,
      presence: (p?.status as PresenceStatusLite | undefined) ?? null,
      presenceUpdatedAt: (p?.updated_at as string | undefined) ?? null,
      liveAgentSessionId: live.get(callerId) ?? null,
      sipUsername,
      busy: busy.has(callerId),
    });
  }
  return out;
}

/** Older credential rows may lack sip_username: read it from Telnyx once and keep it. */
async function fetchSipUsername(profileId: string, credentialId: string): Promise<string | null> {
  try {
    const res = await telnyx<{ data?: { sip_username?: string } }>('GET', `/telephony_credentials/${encodeURIComponent(credentialId)}`);
    const u = res.data?.sip_username ?? null;
    if (u) await adminClient().from('telephony_credentials').update({ sip_username: u }).eq('profile_id', profileId);
    return u;
  } catch (e) {
    console.error('could not read sip_username:', errText(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

async function createOffers(parent: InboundRow, offers: InboundOffer[], ringSeconds: number): Promise<void> {
  const cfg = await loadConfig().catch(() => null);
  for (const o of offers) {
    try {
      await createOffer(parent, o, ringSeconds, cfg?.voice_app_id ?? null);
    } catch (e) {
      console.error('offer failed:', errText(e));
    }
  }
}

async function createOffer(parent: InboundRow, o: InboundOffer, ringSeconds: number, voiceAppId: string | null): Promise<void> {
  const db = adminClient();
  const offerId = offerIdFor(parent.id, o.callerId);
  const sessionId = o.via === 'sip' ? ringSessionIdFor(offerId) : o.agentSessionId;
  if (o.via === 'sip') {
    if (!voiceAppId) return;
    const { error: sErr } = await db.from('agent_sessions').insert({ id: sessionId, caller_id: o.callerId, status: 'pending' });
    if (sErr) return; // already created by a concurrent round: that round owns this offer
  }
  const { error } = await db.from('telephony_calls').insert({
    id: offerId,
    caller_id: o.callerId,
    lead_id: parent.lead_id,
    direction: 'inbound',
    from_number: parent.from_number,
    to_number: parent.to_number,
    ring: 1,
    status: 'incoming',
    call_session_id: offerTag(parent.id),
    agent_session_id: sessionId,
  });
  if (error) return; // offered already (deterministic id)

  if (o.via === 'sip') {
    try {
      const res = await telnyx<{ data: { call_control_id: string; call_leg_id?: string } }>(
        'POST',
        '/calls',
        buildRingBody({
          voiceAppId: voiceAppId!,
          sipUsername: o.sipUsername,
          from: parent.to_number,
          offerId,
          parentId: parent.id,
          ringSeconds,
        }),
      );
      await db
        .from('telephony_calls')
        .update({ call_control_id: res.data.call_control_id, call_leg_id: res.data.call_leg_id ?? null })
        .eq('id', offerId);
      await db.from('agent_sessions').update({ call_control_id: res.data.call_control_id }).eq('id', sessionId);
    } catch (e) {
      console.error('ringing the app failed:', errText(e));
      await db.from('telephony_calls').update({ status: 'ended', end_reason: 'failed', ended_at: new Date().toISOString() }).eq('id', offerId);
      await db.from('agent_sessions').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', sessionId);
      return;
    }
  }
  await emitEvent({
    callerId: o.callerId,
    callId: offerId,
    type: 'incoming',
    from: parent.from_number,
    to: parent.to_number,
    // Tells the app to answer this one with the WebRTC SDK (it rings the device) rather than via telnyx-call.
    message: o.via === 'sip' ? INCOMING_ON_DEVICE : null,
  });
}

/**
 * Ends one offer (idempotent): tells that caller's app (`ended`), hangs up its ring leg and closes
 * its ring session. Never touches a dialing caller's own agent leg.
 */
export async function endOffer(offer: InboundRow, reason: EndReason, hangupLeg = true): Promise<void> {
  const db = adminClient();
  const { data } = await db
    .from('telephony_calls')
    .update({ status: 'ended', end_reason: reason, ended_at: new Date().toISOString() })
    .eq('id', offer.id)
    .neq('status', 'ended')
    .select('id');
  if (data?.length && offer.caller_id) await emitEvent({ callerId: offer.caller_id, callId: offer.id, type: 'ended', reason });
  if (isRingOffer(offer)) {
    if (hangupLeg && offer.call_control_id) {
      await callCommand(offer.call_control_id, 'hangup', {}).catch((e) => console.error('ring hangup failed:', errText(e)));
    }
    await db
      .from('agent_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', offer.agent_session_id!)
      .neq('status', 'ended');
  }
}

export async function endOffersExcept(parentId: string, keepOfferId: string | null, reason: EndReason, filter?: (o: InboundRow) => boolean): Promise<void> {
  for (const o of await loadOffers(parentId)) {
    if (o.id === keepOfferId || o.status === 'ended') continue;
    if (filter && !filter(o)) continue;
    await endOffer(o, reason);
  }
}

// ---------------------------------------------------------------------------
// Advancing / fallback
// ---------------------------------------------------------------------------

/**
 * Re-evaluates an unanswered inbound call: `cancel: 'first'` ends the first round's offers (15 s
 * timer), `cancel: 'all'` ends every offer (30 s timer). Then offers it to everyone else or plays
 * the missed-call message. No-op once someone is answering it or it has ended.
 */
export async function advanceInbound(parentId: string, opts: { cancel?: 'first' | 'all' }): Promise<void> {
  let parent = await loadCall(parentId);
  if (!parent || parent.status !== 'incoming') return;
  const preferred = parent.caller_id;
  if (opts.cancel) {
    const reason: EndReason = 'no_answer';
    await endOffersExcept(parentId, null, reason, (o) => o.status === 'incoming' && (opts.cancel === 'all' || o.caller_id === preferred));
    parent = await loadCall(parentId);
    if (!parent || parent.status !== 'incoming') return;
  }
  const offers = await loadOffers(parentId);
  const othersOffered = preferred === null || offers.some((o) => o.caller_id !== preferred);
  const step = nextInboundStep({
    elapsedMs: Date.now() - Date.parse(parent.created_at),
    othersOffered,
    ringingOffers: offers.filter((o) => RINGING.includes(o.status)).length,
  });
  if (step === 'wait') return;
  if (step === 'offer_others') {
    const plan = planInboundRouting({
      preferredCallerId: preferred,
      candidates: await loadCandidates(),
      nowMs: Date.now(),
      alreadyOffered: new Set(offers.map((o) => o.caller_id!).filter(Boolean)),
    });
    const next = [...plan.first, ...plan.others];
    if (next.length) {
      await createOffers(parent, next, othersRingSeconds(Date.now() - Date.parse(parent.created_at)));
      const after = await loadOffers(parentId);
      if (after.some((o) => RINGING.includes(o.status))) return;
    }
  }
  await fallbackInbound(parentId);
}

/** Nobody took it: answer, say MISSED_CALLBACK_SPEECH (on call.answered), hang up (on speak ended). */
export async function fallbackInbound(parentId: string): Promise<void> {
  const db = adminClient();
  const { data } = await db
    .from('telephony_calls')
    .update({ status: 'declining', local_end_reason: 'no_answer' })
    .eq('id', parentId)
    .eq('status', 'incoming')
    .select('call_control_id');
  if (!data?.length) return;
  await endOffersExcept(parentId, null, 'no_answer');
  const ccid = data[0].call_control_id as string | null;
  if (ccid) {
    await callCommand(ccid, 'answer', {
      client_state: encodeClientState({ v: 1, k: 'in', id: parentId, st: 'polite' }),
      command_id: `polite-${parentId}`,
    });
  }
}

/** Speaks the missed-call message; retries once with the standard voice if Telnyx refuses the HD one. */
export async function speakMissed(ccid: string, parentId: string): Promise<void> {
  const cs = encodeClientState({ v: 1, k: 'in', id: parentId, st: 'polite' });
  try {
    await callCommand(ccid, 'speak', missedCallbackSpeakBody(cs));
    return;
  } catch (e) {
    console.error('speak with the HD voice failed, using the standard voice:', errText(e));
  }
  try {
    await callCommand(ccid, 'speak', missedCallbackSpeakBody(cs, true));
  } catch (e) {
    console.error('speak failed, hanging up:', errText(e));
    await callCommand(ccid, 'hangup', {}).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/**
 * `offer`'s caller takes the call: claims the parent (first one wins), answers the PSTN leg (the
 * bridge follows on its call.answered) and stops every other offer. Returns false when someone
 * else (or the fallback) already has it.
 */
export async function claimInbound(offer: InboundRow, agentSessionId: string): Promise<boolean> {
  const db = adminClient();
  const parentId = parentOfOfferTag(offer.call_session_id);
  if (!parentId || !offer.caller_id) return false;
  const { data } = await db
    .from('telephony_calls')
    .update({ status: 'answering', caller_id: offer.caller_id, agent_session_id: agentSessionId })
    .eq('id', parentId)
    .eq('status', 'incoming')
    .select('call_control_id');
  if (!data?.length) return false;
  await db.from('telephony_calls').update({ status: 'answering' }).eq('id', offer.id).eq('status', 'incoming');
  await endOffersExcept(parentId, offer.id, 'hangup_remote');
  const ccid = data[0].call_control_id as string | null;
  const sent = ccid
    ? await callCommand(ccid, 'answer', {
        client_state: encodeClientState({ v: 1, k: 'in', id: parentId, st: 'bridge' }),
        command_id: `answer-${parentId}`,
      })
    : false;
  if (!sent) {
    // The person calling back has already hung up; their call.hangup closes everything.
    await endOffer(offer, 'hangup_remote');
  }
  return true;
}

/** call.answered on the PSTN leg after a claim: bridge it to the winner's audio leg. */
export async function bridgeInbound(w: ParsedWebhook, parent: InboundRow): Promise<'bridged' | 'no_agent'> {
  const db = adminClient();
  const ccid = w.callControlId ?? parent.call_control_id;
  const offerId = winnerOfferId(parent);
  const offer = offerId ? await loadCall(offerId) : null;
  if (!ccid || !offer || !parent.caller_id) return 'no_agent';
  if (isRingOffer(offer)) {
    if (!offer.call_control_id) return 'no_agent';
    // Bridge from the PSTN leg: either side hanging up ends both (no parking).
    try {
      await callCommand(ccid, 'bridge', { call_control_id: offer.call_control_id, command_id: `bridge-${parent.id}` }, false);
    } catch (e) {
      console.error('bridge to the app failed:', errText(e));
      return 'no_agent';
    }
  } else {
    const { data: s } = await db.from('agent_sessions').select('id, call_control_id, status').eq('id', parent.agent_session_id!).maybeSingle();
    const agent = s?.status === 'live' && s.call_control_id ? { call_control_id: s.call_control_id as string } : await liveAgentSession(parent.caller_id);
    if (!agent) return 'no_agent';
    // Bridge from the agent leg so that the AGENT leg is parked (not hung up) when the caller leaves.
    try {
      await callCommand(
        agent.call_control_id,
        'bridge',
        { call_control_id: ccid, park_after_unbridge: 'self', prevent_double_bridge: true, command_id: `bridge-${parent.id}` },
        false,
      );
    } catch (e) {
      console.error('bridge to the agent leg failed:', errText(e));
      return 'no_agent';
    }
  }
  const at = w.occurredAt ?? new Date().toISOString();
  await db.from('telephony_calls').update({ status: 'answered', answered_at: at }).eq('id', offer.id).in('status', ['incoming', 'answering']);
  return 'bridged';
}

/** The person hung up / was hung up: close the winner's offer or every offer (idempotent). */
export async function closeOffersOnParentEnd(parent: InboundRow, reason: EndReason, answered: boolean): Promise<void> {
  const offerId = winnerOfferId(parent);
  if (answered && offerId) {
    const offer = await loadCall(offerId);
    if (offer) await endOffer(offer, reason);
  }
  await endOffersExcept(parent.id, null, answered ? reason : 'hangup_remote');
}

/** Hangup / timeout / decline on a ring leg (the caller's app leg). */
export async function onRingLegEnded(offer: InboundRow): Promise<void> {
  const parentId = parentOfOfferTag(offer.call_session_id);
  if (!parentId) return;
  if (offer.status === 'answering' || offer.status === 'answered') {
    // The caller hung up in the app (or the bridge ended): hang up the person too.
    const parent = await loadCall(parentId);
    if (parent && parent.status !== 'ended') {
      await adminClient().from('telephony_calls').update({ local_end_reason: 'hangup_local' }).eq('id', parentId).is('local_end_reason', null);
      if (parent.call_control_id) await callCommand(parent.call_control_id, 'hangup', {}).catch(() => {});
    }
    await endOffer(offer, 'hangup_local', false);
    return;
  }
  // Rang out, rejected in the app, not registered, or cancelled by us (then already ended).
  if (offer.status !== 'ended') await endOffer(offer, offer.status === 'declining' ? 'hangup_local' : 'no_answer', false);
  await advanceInbound(parentId, {});
}

