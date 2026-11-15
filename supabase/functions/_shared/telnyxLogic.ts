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

/** Spoken to inbound callers nobody can take. */
export const POLITE_MISSED_MESSAGE =
  "Thanks for calling Quest Labs. We can't take your call right now, but we'll call you back shortly. Goodbye.";

export const POLITE_VOICE = 'AWS.Polly.Joanna-Neural';

/** Ringing time for an inbound call before the app declines it politely. */
export const INBOUND_RING_SECONDS = 20;

/** Backstop on the Voice API app: Telnyx hangs up inbound calls that get no command in this time. */
export const FIRST_COMMAND_TIMEOUT_SECS = 30;

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
  | { v: 1; k: 'agent'; sid: string };

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
  return null;
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
