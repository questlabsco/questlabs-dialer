/**
 * Pure, dependency-free Telnyx translation logic shared by the Edge Functions (Deno) and the app's
 * unit tests (vitest). No imports, no Deno or DOM APIs beyond btoa/atob/TextEncoder/TextDecoder,
 * which exist in Deno, Node 18+ and browsers.
 *
 * Sources (read 2026-11): Telnyx OpenAPI spec (team-telnyx/openapi spec3.json) for webhook payload
 * enums and command bodies; developers.telnyx.com for the outbound-dialer pattern, AMD and webhook
 * signing ("{timestamp}|{raw body}", Ed25519, base64 signature in `telnyx-signature-ed25519`).
 */

// ---------------------------------------------------------------------------
// Our event vocabulary (mirrors src/telephony/Telephony.ts; kept local so this file has no imports)
// ---------------------------------------------------------------------------

export type EndReason = 'no_answer' | 'busy' | 'failed' | 'bad_number' | 'hangup_local' | 'hangup_remote';

export type TelephonyEventType = 'ringing' | 'answered' | 'machine' | 'ended' | 'incoming' | 'error';

/** A row of `telephony_events` as the app receives it. */
export interface TelephonyEventRow {
  id: number;
  caller_id: string;
  call_id: string | null;
  type: TelephonyEventType;
  reason: EndReason | null;
  from_number: string | null;
  to_number: string | null;
  message: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Names of the resources the dialer creates in the Telnyx account (and only ever touches)
// ---------------------------------------------------------------------------

export const DIALER_NAMES = {
  voiceApp: 'Quest Labs Dialer - Voice App',
  credentialConnection: 'Quest Labs Dialer - WebRTC',
  /** Reused if it exists (never edited). */
  preferredOutboundProfile: 'Quest Labs - US Outbound',
  /** Created only when the preferred profile does not exist. */
  ownOutboundProfile: 'Quest Labs Dialer - US Outbound',
  credentialTag: 'quest-labs-dialer',
} as const;

/** Custom SIP header the WebRTC client adds to its agent-leg INVITE (fallback to client_state). */
export const AGENT_SESSION_HEADER = 'X-Quest-Agent-Session';

/** Destination the WebRTC client "dials" for its agent leg; the leg is parked, so it is never routed. */
export const AGENT_LEG_DESTINATION = 'quest-agent';

/** Custom SIP header on the leg the server rings a signed-in caller's app with (value: our offer id). */
export const OFFER_HEADER = 'X-Quest-Offer';

/** `message` of an `incoming` event whose call rings the app itself (answer it with the SDK). */
export const INCOMING_ON_DEVICE = 'device';

/** Offer id carried by an SDK call the server rang the app with (custom header, else client_state). */
export function offerIdOfSdkCall(opts: { customHeaders?: { name?: string; value?: string }[] | null; clientState?: string | null } | null | undefined): string | null {
  const h = opts?.customHeaders?.find((x) => String(x?.name ?? '').toLowerCase() === OFFER_HEADER.toLowerCase());
  if (h && typeof h.value === 'string' && ID_RE.test(h.value)) return h.value;
  const cs = decodeClientState(opts?.clientState);
  return cs?.k === 'ring' ? cs.id : null;
}

/**
 * What a person calling back hears when nobody takes the call (speak command). One place for the
 * text and the voice.
 *
 * Voice: Azure "Ava" Dragon HD, the most natural-sounding voice the Telnyx speak docs list, used
 * here with the exact identifier from those docs
 * (developers.telnyx.com/api-reference/call-commands/gather-using-speak, voice parameter:
 * `Azure.en-US-Ava:DragonHDLatestNeural`). Azure voices need no `voice_settings` unless you bring
 * your own Azure key. If Telnyx refuses it (for example, the account cannot use it), the webhook
 * retries once with `fallbackVoice` (Amazon Polly neural), so the caller still hears the message.
 */
export const MISSED_CALLBACK_SPEECH = {
  text: "Thanks for calling back. Sorry we missed you. We'll try you again shortly.",
  voice: 'Azure.en-US-Ava:DragonHDLatestNeural',
  fallbackVoice: 'AWS.Polly.Joanna-Neural',
  language: 'en-US',
} as const;

/** Body for POST /calls/{id}/actions/speak with the missed-callback message. */
export function missedCallbackSpeakBody(clientState: string, useFallbackVoice = false): Record<string, unknown> {
  return {
    payload: MISSED_CALLBACK_SPEECH.text,
    payload_type: 'text',
    voice: useFallbackVoice ? MISSED_CALLBACK_SPEECH.fallbackVoice : MISSED_CALLBACK_SPEECH.voice,
    language: MISSED_CALLBACK_SPEECH.language,
    client_state: clientState,
  };
}

/** How long the caller who last called the number gets the callback to themselves. */
export const INBOUND_FIRST_OFFER_SECONDS = 15;

/** After this long with nobody answering, the caller hears MISSED_CALLBACK_SPEECH. */
export const INBOUND_TOTAL_RING_SECONDS = 30;

/** App-side backstop: an offer still ringing this long is declined by the app (the server normally ends it first). */
export const INBOUND_RING_SECONDS = 35;

/**
 * Backstop on the Voice API app: Telnyx hangs up inbound calls that get no command in this time.
 * Longer than INBOUND_TOTAL_RING_SECONDS so the missed-call message can always be played.
 */
export const FIRST_COMMAND_TIMEOUT_SECS = 45;

// ---------------------------------------------------------------------------
// client_state (Base64 JSON carried on every Telnyx command and echoed on every webhook)
// ---------------------------------------------------------------------------

export type ClientState =
  /** An outbound lead leg placed by telnyx-dial. `id` = our call id (telephony_calls.id). */
  | { v: 1; k: 'out'; id: string }
  /**
   * An inbound leg. `st` = what to do on the next `call.answered`: 'bridge' to the agent leg, or
   * 'polite' (speak the missed-call message, then hang up).
   */
  | { v: 1; k: 'in'; id: string; st?: 'bridge' | 'polite' }
  /** The caller's long-lived WebRTC agent leg. `sid` = agent_sessions.id. */
  | { v: 1; k: 'agent'; sid: string }
  /**
   * A leg the server rings a signed-in caller's app with, to offer them an inbound call.
   * `id` = the offer (telephony_calls.id of the offer row), `p` = the inbound call (parent row).
   */
  | { v: 1; k: 'ring'; id: string; p: string };

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeClientState(state: ClientState): string {
  return utf8ToBase64(JSON.stringify(state));
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Returns null for anything that is not one of our states (foreign apps, garbage, tampering). */
export function decodeClientState(raw: unknown): ClientState | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64ToUtf8(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (o.k === 'out' && typeof o.id === 'string' && ID_RE.test(o.id)) return { v: 1, k: 'out', id: o.id };
  if (o.k === 'in' && typeof o.id === 'string' && ID_RE.test(o.id)) {
    if (o.st === undefined) return { v: 1, k: 'in', id: o.id };
    if (o.st === 'bridge' || o.st === 'polite') return { v: 1, k: 'in', id: o.id, st: o.st };
    return null;
  }
  if (o.k === 'agent' && typeof o.sid === 'string' && ID_RE.test(o.sid)) return { v: 1, k: 'agent', sid: o.sid };
  if (o.k === 'ring' && typeof o.id === 'string' && ID_RE.test(o.id) && typeof o.p === 'string' && ID_RE.test(o.p)) {
    return { v: 1, k: 'ring', id: o.id, p: o.p };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inbound call routing (callbacks)
// ---------------------------------------------------------------------------
//
// One inbound call (the PSTN leg) is one "parent" telephony_calls row. Each caller it is offered to
// gets an "offer" row of their own (direction 'inbound', caller_id = that caller), because the app
// identifies a call by an id only it sees events for. Offer rows carry `call_session_id =
// offerTag(parentId)`. Ids are derived deterministically so an offer can never be created twice.

/** Deterministic uuid-shaped id from `parts` (not a secret; only used to make inserts idempotent). */
export function derivedId(...parts: string[]): string {
  const text = parts.join('\u0001');
  // cyrb128: four 32-bit lanes.
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
  // Shape as a version-4 / RFC 4122 variant uuid so every uuid parser accepts it.
  const v = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** The offer row id of inbound call `parentId` for `callerId`. */
export function offerIdFor(parentId: string, callerId: string): string {
  return derivedId('offer', parentId, callerId);
}

/** The agent_sessions id used when an offer rings the caller's app directly (no live dialing line). */
export function ringSessionIdFor(offerId: string): string {
  return derivedId('ring-session', offerId);
}

const OFFER_TAG_PREFIX = 'offer:';

/** Stored in the offer row's call_session_id: links it to its parent. */
export function offerTag(parentId: string): string {
  return OFFER_TAG_PREFIX + parentId;
}

/** Parent id of an offer row (from its call_session_id), or null when the row is not an offer. */
export function parentOfOfferTag(callSessionId: unknown): string | null {
  if (typeof callSessionId !== 'string' || !callSessionId.startsWith(OFFER_TAG_PREFIX)) return null;
  const id = callSessionId.slice(OFFER_TAG_PREFIX.length);
  return ID_RE.test(id) ? id : null;
}

/** SIP URI of a caller's registered WebRTC client (the telephony credential's sip_username). */
export function sipUriForUsername(sipUsername: string): string {
  return `sip:${sipUsername}@sip.telnyx.com`;
}

export type PresenceStatusLite = 'offline' | 'idle' | 'dialing' | 'on_call' | 'wrap_up' | 'paused';

/** Presence older than this is offline (matches list_presence in 0001_core.sql). */
export const PRESENCE_STALE_MS = 90_000;

export interface InboundCandidate {
  callerId: string;
  /** presence.status, or null when there is no row. */
  presence: PresenceStatusLite | null;
  /** presence.updated_at (ISO), or null. */
  presenceUpdatedAt: string | null;
  /** A live agent session (the caller is dialing / paused with an open line), or null. */
  liveAgentSessionId: string | null;
  /** sip_username of the caller's telephony credential, or null (never logged in to calling). */
  sipUsername: string | null;
  /** Already on an inbound/outbound call that is answered or being answered, or ringing with another offer. */
  busy: boolean;
}

export type InboundOffer =
  /** The caller is dialing / paused: offer through the app; answering bridges to their open line. */
  | { callerId: string; via: 'agent_leg'; agentSessionId: string }
  /** The caller is signed in but not dialing: ring their registered app directly. */
  | { callerId: string; via: 'sip'; sipUsername: string };

/** How a candidate can be offered a call right now, or null if they cannot take one. */
export function offerFor(c: InboundCandidate, nowMs: number): InboundOffer | null {
  if (c.busy || !c.presence || !c.presenceUpdatedAt) return null;
  const at = Date.parse(c.presenceUpdatedAt);
  if (!Number.isFinite(at) || nowMs - at > PRESENCE_STALE_MS) return null;
  if (c.presence !== 'idle' && c.presence !== 'paused' && c.presence !== 'dialing') return null;
  if (c.liveAgentSessionId) return { callerId: c.callerId, via: 'agent_leg', agentSessionId: c.liveAgentSessionId };
  if (c.sipUsername) return { callerId: c.callerId, via: 'sip', sipUsername: c.sipUsername };
  return null;
}

export interface InboundPlan {
  /** The caller who last called this number, alone, when free (rule: they get it first). */
  first: InboundOffer[];
  /** Everyone else who is free (offered together; the first to answer gets the call). */
  others: InboundOffer[];
}

export function planInboundRouting(input: {
  preferredCallerId: string | null;
  candidates: InboundCandidate[];
  nowMs: number;
  /** Callers already offered this call (never offered twice). */
  alreadyOffered?: ReadonlySet<string>;
}): InboundPlan {
  const done = input.alreadyOffered ?? new Set<string>();
  const seen = new Set<string>();
  const first: InboundOffer[] = [];
  const others: InboundOffer[] = [];
  const sorted = [...input.candidates].sort((a, b) => (a.callerId < b.callerId ? -1 : a.callerId > b.callerId ? 1 : 0));
  for (const c of sorted) {
    if (seen.has(c.callerId) || done.has(c.callerId)) continue;
    seen.add(c.callerId);
    const o = offerFor(c, input.nowMs);
    if (!o) continue;
    if (c.callerId === input.preferredCallerId) first.push(o);
    else others.push(o);
  }
  return { first, others };
}

export type InboundStep = 'wait' | 'offer_others' | 'fallback';

/**
 * What to do next with an inbound call nobody has answered yet.
 * - Offers still ringing: wait.
 * - The "everyone else" round has not happened and there is time left: offer the others.
 * - Otherwise: play the missed-call message.
 */
export function nextInboundStep(p: { elapsedMs: number; othersOffered: boolean; ringingOffers: number }): InboundStep {
  if (p.ringingOffers > 0) return 'wait';
  if (!p.othersOffered && p.elapsedMs < (INBOUND_TOTAL_RING_SECONDS - 5) * 1000) return 'offer_others';
  return 'fallback';
}

/** Ring time for the "everyone else" round: what is left of INBOUND_TOTAL_RING_SECONDS (min 5 s). */
export function othersRingSeconds(elapsedMs: number): number {
  return Math.max(5, Math.round(INBOUND_TOTAL_RING_SECONDS - elapsedMs / 1000));
}

/** Body for POST /v2/calls ringing a caller's registered app with an inbound offer. */
export function buildRingBody(i: {
  voiceAppId: string;
  sipUsername: string;
  /** Our number the person called (always a valid caller id on the account). */
  from: string;
  offerId: string;
  parentId: string;
  ringSeconds: number;
}): Record<string, unknown> {
  return {
    connection_id: i.voiceAppId,
    to: sipUriForUsername(i.sipUsername),
    from: i.from,
    timeout_secs: clampRingSeconds(i.ringSeconds, INBOUND_FIRST_OFFER_SECONDS),
    time_limit_secs: 3600,
    custom_headers: [{ name: OFFER_HEADER, value: i.offerId }],
    client_state: encodeClientState({ v: 1, k: 'ring', id: i.offerId, p: i.parentId }),
    command_id: `ring-${i.offerId}`,
  };
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** US/NANP E.164: +1, area code and exchange not starting with 0/1. */
export function isUsE164(n: unknown): n is string {
  return typeof n === 'string' && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(n);
}

/** Best effort E.164 for a Telnyx `from`/`to` (may be "+1214...", "1214...", "sip:+1214...@..."). */
export function normalizeTelnyxNumber(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const sip = /^sips?:([^@;]+)/i.exec(s);
  if (sip) s = sip[1];
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

// ---------------------------------------------------------------------------
// Hangup cause -> EndReason
// ---------------------------------------------------------------------------

/**
 * Telnyx `call.hangup` enums (OpenAPI CallHangup):
 *   hangup_cause: call_rejected | normal_clearing | originator_cancel | timeout | time_limit |
 *                 user_busy | not_found | no_answer | unspecified
 *   hangup_source: caller | callee | unknown
 *   sip_hangup_cause: SIP response code as a string, or 'unspecified'.
 */
export interface HangupInfo {
  cause: string | null;
  source: string | null;
  sipCode: number | null;
}

export interface HangupContext extends HangupInfo {
  /** Our direction for the leg: 'outbound' = we called the lead; 'inbound' = the lead called us. */
  direction: 'outbound' | 'inbound';
  /** The lead and the caller were connected (outbound: call.answered; inbound: bridged to the agent). */
  answered: boolean;
  /** We asked for this hangup (telnyx-call hangup/decline, or the dialer dropped the line). */
  localRequested: boolean;
}

export function parseSipCode(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 100 && n <= 699 ? n : null;
}

/** SIP codes that mean the number itself is bad. */
const BAD_NUMBER_SIP = new Set([404, 410, 484, 485, 604]);
/** SIP codes that mean busy. */
const BUSY_SIP = new Set([486, 600]);
/** SIP codes that mean the phone did not take the call (off, unreachable, declined) — treat as no answer. */
const NO_ANSWER_SIP = new Set([408, 480, 487, 603]);

export function hangupToEndReason(ctx: HangupContext): EndReason {
  if (ctx.localRequested) return 'hangup_local';
  if (ctx.answered) {
    // Outbound: we (Telnyx on our behalf) are the caller. Inbound: the lead is the caller.
    if (ctx.cause === 'time_limit') return 'hangup_local';
    const leadSide = ctx.direction === 'outbound' ? 'callee' : 'caller';
    const ourSide = ctx.direction === 'outbound' ? 'caller' : 'callee';
    if (ctx.source === leadSide) return 'hangup_remote';
    if (ctx.source === ourSide) return 'hangup_local';
    return 'hangup_remote';
  }
  if (ctx.direction === 'inbound') {
    // The lead called us and nobody took it.
    if (ctx.cause === 'timeout' || ctx.cause === 'no_answer') return 'no_answer';
    if (ctx.source === 'caller' || ctx.cause === 'originator_cancel') return 'hangup_remote';
    return 'no_answer';
  }
  const cause = ctx.cause ?? '';
  const sip = ctx.sipCode;
  if (cause === 'timeout' || cause === 'no_answer') return 'no_answer';
  if (cause === 'user_busy' || (sip !== null && BUSY_SIP.has(sip))) return 'busy';
  if (cause === 'not_found' || (sip !== null && BAD_NUMBER_SIP.has(sip))) return 'bad_number';
  if (cause === 'call_rejected' || (sip !== null && NO_ANSWER_SIP.has(sip))) return 'no_answer';
  return 'failed';
}

// ---------------------------------------------------------------------------
// Answering machine detection
// ---------------------------------------------------------------------------

/** AMD mode requested on Dial when detection is wanted. */
export const AMD_MODE = 'premium' as const;

/**
 * True when an AMD webhook means "not a human". Standard: call.machine.detection.ended result
 * human | machine | not_sure. Premium: call.machine.premium.detection.ended result human_residence |
 * human_business | machine | silence | fax_detected | not_sure. iOS screening (only with
 * premium_ios_call_screening_detection): call.machine.premium.call_screening.detected 'screening'.
 */
export function isMachineEvent(eventType: string, result: unknown): boolean {
  if (eventType === 'call.machine.detection.ended') return result === 'machine';
  if (eventType === 'call.machine.premium.detection.ended') return result === 'machine' || result === 'fax_detected';
  if (eventType === 'call.machine.premium.call_screening.detected') return result === 'screening';
  return false;
}

// ---------------------------------------------------------------------------
// Webhook envelope parsing
// ---------------------------------------------------------------------------

export type WebhookKind =
  | 'initiated'
  | 'answered'
  | 'bridged'
  | 'hangup'
  | 'machine'
  | 'recording_saved'
  | 'speak_ended'
  | 'other';

export interface ParsedWebhook {
  eventId: string;
  eventType: string;
  kind: WebhookKind;
  occurredAt: string | null;
  callControlId: string | null;
  callLegId: string | null;
  callSessionId: string | null;
  connectionId: string | null;
  clientState: ClientState | null;
  from: string | null;
  to: string | null;
  /** call.initiated only: 'incoming' | 'outgoing'. */
  direction: 'incoming' | 'outgoing' | null;
  /** call.initiated only: 'parked' | 'bridging'. */
  state: string | null;
  hangup: HangupInfo | null;
  /** True for AMD results that mean machine (kind 'machine'). */
  isMachine: boolean;
  machineResult: string | null;
  /** call.recording.saved: download URLs (valid ~10 minutes per Telnyx). */
  recordingUrls: { mp3: string | null; wav: string | null } | null;
  customHeaders: { name: string; value: string }[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Parses a Telnyx API v2 webhook body. Returns null when it is not a v2 call event envelope. */
export function parseWebhook(body: unknown): ParsedWebhook | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const eventType = str(d.event_type);
  const eventId = str(d.id);
  if (!eventType || !eventId) return null;
  const p = (d.payload && typeof d.payload === 'object' ? d.payload : {}) as Record<string, unknown>;

  let kind: WebhookKind = 'other';
  if (eventType === 'call.initiated') kind = 'initiated';
  else if (eventType === 'call.answered') kind = 'answered';
  else if (eventType === 'call.bridged') kind = 'bridged';
  else if (eventType === 'call.hangup') kind = 'hangup';
  else if (eventType.startsWith('call.machine.')) kind = 'machine';
  else if (eventType === 'call.recording.saved') kind = 'recording_saved';
  else if (eventType === 'call.speak.ended') kind = 'speak_ended';

  const dir = str(p.direction);
  const urls = p.recording_urls && typeof p.recording_urls === 'object' ? (p.recording_urls as Record<string, unknown>) : null;
  const headers = Array.isArray(p.custom_headers)
    ? (p.custom_headers as unknown[])
        .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
        .map((h) => ({ name: String(h.name ?? ''), value: String(h.value ?? '') }))
    : [];
  const machineResult = kind === 'machine' ? str(p.result) : null;

  return {
    eventId,
    eventType,
    kind,
    occurredAt: str(d.occurred_at),
    callControlId: str(p.call_control_id),
    callLegId: str(p.call_leg_id),
    callSessionId: str(p.call_session_id),
    connectionId: str(p.connection_id),
    clientState: decodeClientState(p.client_state),
    from: str(p.from),
    to: str(p.to),
    direction: dir === 'incoming' || dir === 'outgoing' ? dir : null,
    state: str(p.state),
    hangup:
      kind === 'hangup'
        ? { cause: str(p.hangup_cause), source: str(p.hangup_source), sipCode: parseSipCode(p.sip_hangup_cause) }
        : null,
    isMachine: kind === 'machine' && isMachineEvent(eventType, p.result),
    machineResult,
    recordingUrls: urls ? { mp3: str(urls.mp3), wav: str(urls.wav) } : null,
    customHeaders: headers,
  };
}

/** Agent session id from the agent leg's client_state, or from our custom SIP header. */
export function agentSessionIdOf(w: ParsedWebhook): string | null {
  if (w.clientState?.k === 'agent') return w.clientState.sid;
  const h = w.customHeaders.find((x) => x.name.toLowerCase() === AGENT_SESSION_HEADER.toLowerCase());
  return h && ID_RE.test(h.value) ? h.value : null;
}

// ---------------------------------------------------------------------------
// Webhook signature helpers (the crypto itself runs in the Edge Function with WebCrypto)
// ---------------------------------------------------------------------------

/** Telnyx signs `${telnyx-timestamp}|${raw body}`. */
export function signedMessage(timestamp: string, rawBody: string): string {
  return `${timestamp}|${rawBody}`;
}

/** Replay window check. `timestamp` is Unix seconds (header `telnyx-timestamp`). */
export function isFreshTimestamp(timestamp: string | null, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!timestamp || !/^\d{9,11}$/.test(timestamp)) return false;
  return Math.abs(nowSeconds - Number(timestamp)) <= toleranceSeconds;
}

const SPKI_ED25519_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

/**
 * Telnyx publishes the key base64-encoded. Their PHP sample treats it as the raw 32-byte key, their
 * Java sample as X.509 SubjectPublicKeyInfo; accept both and return the raw 32 bytes (or null).
 */
export function rawEd25519PublicKey(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | null {
  if (bytes.length === 32) return bytes;
  if (bytes.length === 44 && SPKI_ED25519_PREFIX.every((b, i) => bytes[i] === b)) return bytes.slice(12);
  return null;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

const RECORDING_PREFIX = 'telnyx-recording:';

/**
 * Telnyx recording URLs in `call.recording.saved` expire after 10 minutes, so `calls.recording_url`
 * stores this stable reference; playback asks the `telnyx-recording` function for a fresh URL.
 */
export function recordingRef(recordingId: string): string {
  return RECORDING_PREFIX + recordingId;
}

export function parseRecordingRef(url: unknown): string | null {
  if (typeof url !== 'string' || !url.startsWith(RECORDING_PREFIX)) return null;
  const id = url.slice(RECORDING_PREFIX.length);
  return ID_RE.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// Dial command body
// ---------------------------------------------------------------------------

export interface DialBodyInput {
  callId: string;
  voiceAppId: string;
  agentCallControlId: string;
  to: string;
  from: string;
  ringSeconds: number;
  detectMachine: boolean;
  record: boolean;
}

export function clampRingSeconds(s: unknown, fallback: number): number {
  const n = typeof s === 'number' && Number.isFinite(s) ? Math.round(s) : fallback;
  return Math.min(600, Math.max(5, n));
}

/** Body for POST /v2/calls (Dial). */
export function buildDialBody(i: DialBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    connection_id: i.voiceAppId,
    to: i.to,
    from: i.from,
    // Share the agent leg's session and bridge the instant the lead answers, without our webhook.
    link_to: i.agentCallControlId,
    bridge_on_answer: true,
    // A second pickup while the agent is already bridged is hung up instead of double-bridged.
    prevent_double_bridge: true,
    timeout_secs: clampRingSeconds(i.ringSeconds, 22),
    // With retry_on_timeout=false Telnyx does not try other routes after timeout_secs (cause no_answer).
    retry_on_timeout: false,
    time_limit_secs: 3600,
    client_state: encodeClientState({ v: 1, k: 'out', id: i.callId }),
    command_id: i.callId,
  };
  if (i.detectMachine) {
    body.answering_machine_detection = AMD_MODE;
  }
  if (i.record) {
    body.record = 'record-from-answer';
    body.record_channels = 'dual';
    body.record_format = 'mp3';
    body.record_trim = 'trim-silence';
  }
  return body;
}

// ---------------------------------------------------------------------------
// Phone number classification for telnyx-sync-numbers
// ---------------------------------------------------------------------------

export interface TelnyxNumberLite {
  id: string;
  phone_number: string;
  status?: string | null;
  connection_id?: string | null;
  connection_name?: string | null;
}

export interface ClassifiedNumbers {
  /** Attached to the dialer's own Voice API app. */
  dialer: { number: string; providerId: string }[];
  /** Attached to some other app/connection (e.g. Vapi). Never imported or reassigned automatically. */
  inUseElsewhere: { number: string; providerId: string; connectionId: string; connectionName: string | null }[];
  /** Attached to nothing; can be assigned to the dialer explicitly. */
  unassigned: { number: string; providerId: string }[];
}

export function classifyNumbers(list: TelnyxNumberLite[], voiceAppId: string | null): ClassifiedNumbers {
  const out: ClassifiedNumbers = { dialer: [], inUseElsewhere: [], unassigned: [] };
  for (const n of list) {
    if (n.status && n.status !== 'active') continue;
    const number = normalizeTelnyxNumber(n.phone_number);
    if (!number) continue;
    const conn = n.connection_id ? String(n.connection_id) : null;
    if (conn && voiceAppId && conn === voiceAppId) out.dialer.push({ number, providerId: n.id });
    else if (conn) out.inUseElsewhere.push({ number, providerId: n.id, connectionId: conn, connectionName: n.connection_name ?? null });
    else out.unassigned.push({ number, providerId: n.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup status checklist (telnyx-status)
// ---------------------------------------------------------------------------

export type StatusKey =
  | 'api_key'
  | 'voice_app'
  | 'voice_app_webhook'
  | 'voice_app_profile'
  | 'webrtc_connection'
  | 'webrtc_webhook'
  | 'webrtc_parking'
  | 'webrtc_inbound'
  | 'webrtc_profile'
  | 'webhook_public_key'
  | 'numbers';

export interface StatusItem {
  key: StatusKey;
  label: string;
  ok: boolean;
  /** What was found, plain English. */
  detail: string;
  /** What to do when !ok, plain English; null when ok. */
  hint: string | null;
}

export interface StatusFacts {
  apiKeyPresent: boolean;
  apiKeyAccepted: boolean;
  expectedWebhookUrl: string;
  voiceApp: { id: string; name: string; webhookUrl: string | null; apiVersion: string | null; profileId: string | null } | null;
  credentialConnection: {
    id: string;
    name: string;
    webhookUrl: string | null;
    apiVersion: string | null;
    parking: boolean;
    profileId: string | null;
    /** sip_uri_calling_preference: must be 'internal' (or 'unrestricted') so callbacks can ring the app. */
    sipUriCalling?: string | null;
  } | null;
  outboundProfile: { id: string; name: string } | null;
  publicKeyPresent: boolean;
  dialerNumbers: number;
}

const RUN_SETUP = 'Press "Set up Telnyx" (runs telnyx-setup) to fix this automatically.';

export function evaluateStatus(f: StatusFacts): StatusItem[] {
  const items: StatusItem[] = [];
  const add = (key: StatusKey, label: string, ok: boolean, detail: string, hint: string) =>
    items.push({ key, label, ok, detail, hint: ok ? null : hint });

  add(
    'api_key',
    'Telnyx API key',
    f.apiKeyPresent && f.apiKeyAccepted,
    !f.apiKeyPresent ? 'No API key is set.' : f.apiKeyAccepted ? 'Present and accepted by Telnyx.' : 'Present but Telnyx rejected it.',
    !f.apiKeyPresent
      ? 'Create an API key in the Telnyx portal (Account > API Keys) and save it as the TELNYX_API_KEY secret of this Supabase project.'
      : 'The key was rejected. Create a new API key in the Telnyx portal and replace the TELNYX_API_KEY secret.',
  );
  if (!f.apiKeyPresent || !f.apiKeyAccepted) return items;

  const va = f.voiceApp;
  add('voice_app', 'Dialer voice app', !!va, va ? `Found "${va.name}".` : 'Not found.', RUN_SETUP);
  if (va) {
    const ok = va.webhookUrl === f.expectedWebhookUrl && va.apiVersion === '2';
    add(
      'voice_app_webhook',
      'Voice app webhook',
      ok,
      ok ? 'Points at this project (API v2).' : `Points at ${va.webhookUrl ?? 'nothing'} (API v${va.apiVersion ?? '?'}).`,
      RUN_SETUP,
    );
    add(
      'voice_app_profile',
      'Voice app outbound profile',
      !!va.profileId,
      va.profileId ? `Attached (${f.outboundProfile?.name ?? va.profileId}).` : 'No outbound voice profile attached, so it cannot call out.',
      RUN_SETUP,
    );
  }

  const cc = f.credentialConnection;
  add('webrtc_connection', 'WebRTC connection', !!cc, cc ? `Found "${cc.name}".` : 'Not found.', RUN_SETUP);
  if (cc) {
    const ok = cc.webhookUrl === f.expectedWebhookUrl && cc.apiVersion === '2';
    add(
      'webrtc_webhook',
      'WebRTC connection webhook',
      ok,
      ok ? 'Points at this project (API v2).' : `Points at ${cc.webhookUrl ?? 'nothing'} (API v${cc.apiVersion ?? '?'}).`,
      RUN_SETUP,
    );
    add(
      'webrtc_parking',
      'WebRTC call parking',
      cc.parking,
      cc.parking ? 'Enabled.' : 'Disabled: the callers\' audio legs would not be held for bridging.',
      RUN_SETUP,
    );
    // Only judged when reported (telnyx-status always reports it; older callers of this function may not).
    if (cc.sipUriCalling !== undefined) {
      const inboundOk = cc.sipUriCalling === 'internal' || cc.sipUriCalling === 'unrestricted';
      add(
        'webrtc_inbound',
        'Callbacks ring the app',
        inboundOk,
        inboundOk
          ? 'On: people calling back ring callers who are signed in.'
          : 'Off: people calling back can only reach callers who are dialing.',
        RUN_SETUP,
      );
    }
    add(
      'webrtc_profile',
      'WebRTC outbound profile',
      !!cc.profileId,
      cc.profileId ? 'Attached.' : 'No outbound voice profile attached.',
      RUN_SETUP,
    );
  }

  add(
    'webhook_public_key',
    'Webhook signing key',
    f.publicKeyPresent,
    f.publicKeyPresent ? 'Stored; incoming webhooks are verified.' : 'Missing; webhooks will be rejected.',
    'Run setup again. If it still fails, copy the public key from the Telnyx portal (Account > Public Key) into the TELNYX_PUBLIC_KEY secret.',
  );

  add(
    'numbers',
    'Phone numbers for the dialer',
    f.dialerNumbers > 0,
    f.dialerNumbers === 1 ? '1 number is assigned to the dialer.' : `${f.dialerNumbers} numbers are assigned to the dialer.`,
    'Buy a local number in the Telnyx portal, then assign it to the dialer from the Numbers screen. Numbers used by other apps are not taken automatically.',
  );
  return items;
}
