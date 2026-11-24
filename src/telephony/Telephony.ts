/**
 * Provider-neutral telephony contract driven by the dialer engine.
 *
 * Implementations: `simulated.ts` (demo) and `telnyx.ts` (real). In the real implementation the
 * SERVER places outbound calls (with answering-machine detection) and bridges them to the caller's
 * WebRTC leg, so every state change arrives asynchronously as a TelephonyEvent. The engine must
 * therefore never assume an event follows a method call synchronously.
 *
 * Call ids are provider ids (opaque strings), distinct from CallRecord ids.
 */

export interface DialRequest {
  /** Lead phone, E.164. */
  to: string;
  /** Our outbound number, E.164 (from Api.pickFromNumber). */
  from: string;
  leadId: string;
  /** 1 = first ring, 2 = double-ring retry. */
  ring: 1 | 2;
  /** How long to ring before giving up with `ended { reason: 'no_answer' }`. Defaults to Settings.ringSeconds. */
  ringSeconds?: number;
  /** Ask the provider to run answering-machine detection (Settings.skipVoicemail). Default true. */
  detectMachine?: boolean;
  manual?: boolean;
  /** Ask the provider to record if answered (Settings.recordCalls). Default false. */
  record?: boolean;
}

export type EndReason =
  /** Rang out without pickup. */
  | 'no_answer'
  | 'voicemail'
  | 'busy'
  /** Network / carrier failure. */
  | 'failed'
  /** Invalid or disconnected number. */
  | 'bad_number'
  /** We hung up (hangup() or declineIncoming()). */
  | 'hangup_local'
  /** The other party hung up. */
  | 'hangup_remote';

export type TelephonyEvent =
  /** The far end is ringing. */
  | { type: 'ringing'; callId: string }
  | { type: 'checking' | 'screening' | 'voicemail'; callId: string }
  /** Someone picked up; audio is live to the caller immediately. */
  | { type: 'answered'; callId: string }
  /** The voicemail check confirmed a person on an answered call (see `confirmsPeople`). */
  | { type: 'human'; callId: string }
  /** Answering machine detected shortly after `answered`. The engine decides whether to hang up. */
  | { type: 'machine'; callId: string }
  /** Terminal event for a call; emitted exactly once per callId. */
  | { type: 'ended'; callId: string; reason: EndReason }
  /** Inbound call ringing for this caller. Answer with answerIncoming / declineIncoming. */
  | { type: 'incoming'; callId: string; from: string; to: string }
  /** Non-call-specific failure (lost connection, mic denied, ...). */
  | { type: 'error'; message: string };

export type TelephonyEventType = TelephonyEvent['type'];

export type TelephonyListener = (event: TelephonyEvent) => void;

export interface Telephony {
  readonly kind: 'simulated' | 'telnyx';
  /** True between a successful connect() and disconnect(). */
  readonly connected: boolean;
  /** Opens the caller's audio session (asks for the microphone). Rejects if the mic is denied. */
  connect(): Promise<void>;
  /** Hangs up everything and closes the audio session. */
  disconnect(): Promise<void>;
  /** Starts an outbound call; resolves with the provider callId as soon as it is accepted. */
  dial(req: DialRequest): Promise<string>;
  /** Ends a call (ringing or answered). Emits `ended { reason: 'hangup_local' }`. No-op for unknown ids. */
  hangup(callId: string): Promise<void>;
  /** DTMF on an answered call ('0'-'9', '*', '#'). */
  sendDigits(callId: string, digits: string): Promise<void>;
  /** Mutes / unmutes the caller's microphone on all calls. */
  setMuted(muted: boolean): Promise<void>;
  /** Accepts an `incoming` call; emits `answered` for it. Works while connected or on standby. */
  answerIncoming(callId: string): Promise<void>;
  /** Rejects an `incoming` call; emits `ended { reason: 'hangup_local' }`. */
  declineIncoming(callId: string): Promise<void>;
  /** Subscribe to all events. Returns unsubscribe. */
  on(listener: TelephonyListener): () => void;
  /**
   * Optional: stay reachable for `incoming` calls while signed in but not connected (no open call
   * leg, no microphone). Called by the engine for a signed-in caller; never rejects. Answering an
   * incoming call while only on standby asks for the microphone then.
   */
  startStandby?(): Promise<void>;
  /** Optional: undo startStandby (sign-out). */
  stopStandby?(): Promise<void>;
  /**
   * Optional: true when the provider records missed inbound calls itself (server side), so the
   * engine must not log them again.
   */
  readonly logsMissedInbound?: boolean;
  /**
   * Optional: true when an answered outbound call is followed by `human` once the voicemail check
   * confirms a person (or `machine`). The engine then keeps its other lines ringing until it knows.
   */
  readonly confirmsPeople?: boolean;
}
