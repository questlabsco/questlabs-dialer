/**
 * Telnyx implementation of `Telephony`.
 *
 * - Caller audio: a @telnyx/webrtc client logged in with a short-lived JWT (Api.getTelephonyToken
 *   -> telnyx-token) places ONE long-lived "agent leg" for the whole dialing session. The leg is
 *   parked on the dialer's credential connection and answered by telnyx-webhook.
 * - Dialing: telnyx-dial places each lead call server-side with AMD and links it to the agent leg
 *   (bridge_on_answer + prevent_double_bridge), returning our own call id at once.
 * - Events: telnyx-webhook writes telephony_events rows; we receive them over Supabase Realtime
 *   (filtered to our caller id), de-duplicate them, and emit TelephonyEvents. Missed rows are
 *   back-filled after every (re)subscription.
 * - Inbound (callbacks): `incoming` events ring here. Two kinds, chosen by the server:
 *     - while dialing / paused (agent leg open): answer / decline go through telnyx-call, which
 *       bridges the person to the agent leg;
 *     - on standby (signed in, no open leg; startStandby keeps the WebRTC client logged in and
 *       registered and the event subscription open): the server rings this client itself
 *       (event message INCOMING_ON_DEVICE); answering asks for the microphone and answers that
 *       SDK call; the server then bridges it to the person.
 *   If nothing happens within INBOUND_RING_SECONDS we decline ('timeout'); the server normally
 *   moves the call on well before that.
 * - Missed inbound calls are logged by the server (logsMissedInbound).
 */
import {
  encodeClientState,
  INBOUND_RING_SECONDS,
  INCOMING_ON_DEVICE,
  type TelephonyEventRow,
} from '../../supabase/functions/_shared/telnyxLogic';
import type { DialRequest, EndReason, Telephony, TelephonyEvent, TelephonyListener } from './Telephony';
import type { SubscriptionStatus, TelnyxBackend } from './telnyxBackend';
import type { RtcAgentCall, RtcClient, RtcFactory, RtcInboundCall } from './telnyxRtc';

export interface TelnyxTelephonyOptions {
  /** Returns a fresh login token (Api.getTelephonyToken). */
  getToken: () => Promise<string>;
  /** Supabase functions + realtime. Default: the app's Supabase client (loaded lazily). */
  backend?: TelnyxBackend;
  /** WebRTC client factory. Default: @telnyx/webrtc (loaded lazily). */
  rtc?: RtcFactory;
  /** Microphone check. Default: navigator.mediaDevices.getUserMedia({ audio: true }). */
  requestMicrophone?: () => Promise<void>;
  /** Timer functions (tests). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface KnownCall {
  direction: 'outbound' | 'inbound';
  answered: boolean;
  ended: boolean;
  /** Timers owned by this call (watchdog / inbound auto-decline / fallbacks). */
  timers: unknown[];
  /** Inbound call that rings this device (answered with the SDK, not via telnyx-call). */
  device?: boolean;
  /** The SDK call carrying the audio of a device call once answered. */
  sdk?: RtcInboundCall;
}

const AGENT_LEG_TIMEOUT_MS = 20_000;
/** How long answerIncoming waits for the device call's INVITE when the event came first. */
const DEVICE_CALL_WAIT_MS = 8_000;
/** Standby login retries (then every last value). */
const STANDBY_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const AGENT_RECOVERY_DELAYS_MS = [1_000, 3_000, 6_000];
const RESUBSCRIBE_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const PENDING_EVENT_TTL_MS = 60_000;
/** Extra time after ringSeconds before we assume an outbound call's webhooks were lost. */
const OUTBOUND_WATCHDOG_GRACE_MS = 25_000;
/** After asking the server to hang up, how long to wait for its `ended` before emitting our own. */
const LOCAL_END_FALLBACK_MS = 8_000;

function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'Microphone access was denied. Allow microphone access for Quest Labs Dialer (on Windows: Settings > Privacy > Microphone; on Mac: System Settings > Privacy & Security > Microphone), then press Start again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found. Plug in a headset or microphone, then press Start again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is in use by another app. Close the other app, then press Start again.';
  }
  return `Could not open the microphone${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
}

async function defaultRequestMicrophone(): Promise<void> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.getUserMedia) throw new Error('This device cannot capture audio (no microphone support).');
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ audio: true, video: false });
  } catch (e) {
    throw new Error(micErrorMessage(e));
  }
  // The SDK opens its own stream; this was only the permission check.
  for (const t of stream.getTracks()) t.stop();
}

export class TelnyxTelephony implements Telephony {
  readonly kind = 'telnyx' as const;
  readonly logsMissedInbound = true;

  private _connected = false;
  private connecting: Promise<void> | null = null;
  private disconnecting = false;
  private listeners = new Set<TelephonyListener>();

  private backend: TelnyxBackend | null;
  private rtc: RtcClient | null = null;
  private agentCall: RtcAgentCall | null = null;
  private agentSessionId: string | null = null;
  private recoveringAgent = false;

  /** startStandby() was called and stopStandby() not yet. */
  private standbyWanted = false;
  /** The WebRTC client is logged in and the event subscription is open (standby or connected). */
  private baseReady = false;
  private baseStarting: Promise<void> | null = null;
  private standbyRetry = 0;
  private standbyTimer: unknown = null;
  /** SDK calls ringing this client, by offer id (or SDK id when they carry none). */
  private deviceCalls = new Map<string, RtcInboundCall>();

  private callerId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private subscriptionGen = 0;
  private resubscribeAttempt = 0;
  /** Highest event id processed (back-fill starts after it). */
  private lastEventId = 0;
  /** Highest event id that existed when connect() started. */
  private baselineEventId = 0;
  private seenEventIds = new Set<number>();

  private calls = new Map<string, KnownCall>();
  /** Events that arrived before dial() returned their call id. */
  private pending = new Map<string, { rows: TelephonyEventRow[]; at: number }>();
  /** `${callId}:${type}` already emitted (ended is tracked on KnownCall). */
  private emitted = new Set<string>();
  private muted = false;

  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(readonly options: TelnyxTelephonyOptions) {
    this.backend = options.backend ?? null;
    this.setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = options.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get connected(): boolean {
    return this._connected;
  }

  on(listener: TelephonyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TelephonyEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (e) {
        console.error('Telephony listener failed', e);
      }
    }
  }

  private emitError(message: string): void {
    this.emit({ type: 'error', message });
  }

  private async getBackend(): Promise<TelnyxBackend> {
    if (!this.backend) {
      const mod = await import('./telnyxBackend');
      this.backend = mod.createSupabaseTelnyxBackend();
    }
    return this.backend;
  }

  private async getRtcFactory(): Promise<RtcFactory> {
    if (this.options.rtc) return this.options.rtc;
    const mod = await import('./telnyxRtc');
    return mod.createTelnyxRtc;
  }

  // -------------------------------------------------------------------------
  // Standby (signed in, reachable for callbacks, no open call leg)
  // -------------------------------------------------------------------------

  async startStandby(): Promise<void> {
    this.standbyWanted = true;
    if (this.baseReady && !this._connected && !this.connecting) {
      // Still logged in for someone else (signed out and in again without a teardown): start over.
      const backend = await this.getBackend();
      const me = await backend.userId().catch(() => null);
      if (me === this.callerId) return;
      await this.teardownBase();
    }
    if (this.baseReady) return;
    if (!this._connected && !this.connecting) this.disconnecting = false;
    try {
      await this.ensureBase();
      this.standbyRetry = 0;
    } catch (e) {
      console.warn('[telnyx] standby login failed:', e instanceof Error ? e.message : String(e));
      if (!this._connected && !this.connecting) await this.teardownBase();
      this.scheduleStandbyRetry();
    }
  }

  async stopStandby(): Promise<void> {
    this.standbyWanted = false;
    if (this.standbyTimer) this.clearT(this.standbyTimer);
    this.standbyTimer = null;
    if (this._connected || this.connecting) return; // disconnect() tears the rest down
    for (const c of this.deviceCalls.values()) await c.hangup().catch(() => {});
    await this.teardownBase();
  }

  private scheduleStandbyRetry(): void {
    if (!this.standbyWanted || this.standbyTimer) return;
    const delay = STANDBY_RETRY_DELAYS_MS[Math.min(this.standbyRetry, STANDBY_RETRY_DELAYS_MS.length - 1)];
    this.standbyRetry++;
    this.standbyTimer = this.setT(() => {
      this.standbyTimer = null;
      if (this.standbyWanted && !this.baseReady) void this.startStandby();
    }, delay);
  }

  /** Logs the WebRTC client in and opens the event subscription (once; shared by standby and sessions). */
  private ensureBase(): Promise<void> {
    if (this.baseReady) return Promise.resolve();
    if (!this.baseStarting) {
      this.baseStarting = (async () => {
        const backend = await this.getBackend();
        this.callerId = await backend.userId();
        this.lastEventId = await backend.latestEventId(this.callerId);
        this.baselineEventId = this.lastEventId;
        this.subscribeEvents();
        await this.startRtc();
        this.baseReady = true;
      })().finally(() => {
        this.baseStarting = null;
      });
    }
    return this.baseStarting;
  }

  // -------------------------------------------------------------------------
  // connect / disconnect
  // -------------------------------------------------------------------------

  connect(): Promise<void> {
    if (this._connected) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    this.disconnecting = false;
    await (this.options.requestMicrophone ?? defaultRequestMicrophone)();
    try {
      await this.ensureBase();
      await this.startAgentLeg();
      this._connected = true;
    } catch (e) {
      await this.teardown();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private async startRtc(): Promise<void> {
    const factory = await this.getRtcFactory();
    const rtc = factory({
      onFatal: (message, kind) => void this.onRtcFatal(message, kind),
      onIncomingCall: (call) => this.onDeviceCall(call),
    });
    this.rtc = rtc;
    const token = await this.options.getToken();
    await rtc.connect(token);
  }

  private async startAgentLeg(): Promise<void> {
    const backend = await this.getBackend();
    const rtc = this.rtc;
    if (!rtc) throw new Error('Telnyx is not connected.');
    const { sessionId } = await backend.invoke<{ sessionId: string }>('telnyx-agent', { action: 'start' });
    this.agentSessionId = sessionId;
    const call = rtc.startAgentLeg({
      sessionId,
      clientState: encodeClientState({ v: 1, k: 'agent', sid: sessionId }),
      muted: this.muted,
      onEnded: (cause) => void this.onAgentLegEnded(cause),
    });
    this.agentCall = call;
    await this.waitForAgentLive(call, sessionId);
  }

  /** The leg is usable once the SDK reports it active OR the server reports the session live. */
  private waitForAgentLive(call: RtcAgentCall, sessionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        this.clearT(timeout);
        this.clearT(poll);
        if (err) reject(err);
        else resolve();
      };
      const timeout = this.setT(
        () => finish(new Error('Could not open your audio line (the phone service did not answer). Check the Phone setup, then press Start again.')),
        AGENT_LEG_TIMEOUT_MS,
      );
      let poll: unknown = null;
      const check = async () => {
        if (done) return;
        try {
          const backend = await this.getBackend();
          const { status } = await backend.invoke<{ status: string }>('telnyx-agent', { action: 'status', sessionId });
          if (status === 'live') return finish();
          if (status === 'ended') return finish(new Error('Your audio line was closed by the phone service.'));
        } catch {
          /* keep polling */
        }
        if (!done) poll = this.setT(() => void check(), 1_000);
      };
      call.active.then(() => finish(), (e: Error) => finish(e));
      poll = this.setT(() => void check(), 1_000);
    });
  }

  async disconnect(): Promise<void> {
    if (this.connecting) await this.connecting.catch(() => {});
    this.disconnecting = true;
    const open = [...this.calls.entries()].filter(([, c]) => !c.ended).map(([id]) => id);
    await Promise.all(open.map((id) => this.hangup(id).catch(() => {})));
    // Give the server's `ended` events a moment to arrive, then close out anything left.
    await this.waitUntil(() => open.every((id) => this.calls.get(id)?.ended !== false), 3_000);
    for (const id of open) this.emitEnded(id, 'hangup_local');
    await this.teardown();
  }

  /** Closes the session (agent leg, calls); keeps the standby login when standby is wanted. */
  private async teardown(): Promise<void> {
    this.disconnecting = true;
    this._connected = false;
    const backend = this.backend;
    const sessionId = this.agentSessionId;
    this.agentSessionId = null;
    const call = this.agentCall;
    this.agentCall = null;
    if (call) await call.hangup().catch(() => {});
    if (backend && sessionId) await backend.invoke('telnyx-agent', { action: 'stop', sessionId }).catch(() => {});
    for (const c of this.calls.values()) for (const t of c.timers) this.clearT(t);
    this.calls.clear();
    this.pending.clear();
    this.emitted.clear();
    if (this.standbyWanted && this.baseReady && this.rtc) {
      this.disconnecting = false;
      return;
    }
    await this.teardownBase();
  }

  private async teardownBase(): Promise<void> {
    this.baseReady = false;
    const rtc = this.rtc;
    this.rtc = null;
    if (rtc) await rtc.disconnect().catch(() => {});
    this.subscriptionGen++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const c of this.calls.values()) for (const t of c.timers) this.clearT(t);
    this.calls.clear();
    this.pending.clear();
    this.emitted.clear();
    this.seenEventIds.clear();
    this.deviceCalls.clear();
  }

  private waitUntil(pred: () => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (pred() || Date.now() - started >= ms) return resolve();
        this.setT(tick, 100);
      };
      tick();
    });
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  private async onAgentLegEnded(cause: string): Promise<void> {
    if (this.disconnecting || !this._connected || this.recoveringAgent) return;
    this.recoveringAgent = true;
    this.agentCall = null;
    try {
      for (const delay of AGENT_RECOVERY_DELAYS_MS) {
        await new Promise<void>((r) => this.setT(r, delay));
        if (this.disconnecting || !this._connected) return;
        try {
          await this.startAgentLeg();
          return;
        } catch {
          /* try again */
        }
      }
      this._connected = false;
      this.emitError(`Lost your audio line (${cause}) and could not reopen it. Press Start to reconnect.`);
    } finally {
      this.recoveringAgent = false;
    }
  }

  private async onRtcFatal(message: string, kind: 'auth' | 'network' | 'other'): Promise<void> {
    if (this.disconnecting) return;
    if (!this._connected) {
      // Standby only: log in again in the background.
      if (!this.standbyWanted || !this.baseReady) return;
      const old = this.rtc;
      this.rtc = null;
      this.baseReady = false;
      if (old) await old.disconnect().catch(() => {});
      try {
        await this.startRtc();
        this.baseReady = true;
      } catch {
        this.rtc = null;
        this.scheduleStandbyRetry();
      }
      return;
    }
    // Re-login once with a fresh token, then reopen the agent leg.
    try {
      const old = this.rtc;
      this.rtc = null;
      this.agentCall = null;
      if (old) await old.disconnect().catch(() => {});
      await this.startRtc();
      await this.startAgentLeg();
    } catch {
      this._connected = false;
      this.emitError(
        kind === 'auth'
          ? 'The phone service rejected your login. Press Start to sign in again.'
          : `Lost the connection to the phone service (${message}). Press Start to reconnect.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Calls ringing this device
  // -------------------------------------------------------------------------

  private onDeviceCall(call: RtcInboundCall): void {
    const key = call.offerId ?? `sdk:${call.id}`;
    this.deviceCalls.set(key, call);
    call.onEnded(() => {
      if (this.deviceCalls.get(key) === call) this.deviceCalls.delete(key);
      // The audio of an answered device call is gone; the server's `ended` normally follows at once.
      for (const [id, known] of this.calls) {
        if (known.sdk === call && !known.ended) {
          known.timers.push(this.setT(() => this.emitEnded(id, 'hangup_remote'), LOCAL_END_FALLBACK_MS));
        }
      }
    });
  }

  /** The SDK call for offer `callId`: by its header, else the only unmatched ringing call. */
  private findDeviceCall(callId: string): RtcInboundCall | null {
    const byId = this.deviceCalls.get(callId);
    if (byId && !byId.ended) return byId;
    const loose = [...this.deviceCalls.entries()].filter(([k, c]) => k.startsWith('sdk:') && !c.ended);
    return loose.length === 1 ? loose[0][1] : null;
  }

  private async waitForDeviceCall(callId: string, ms: number): Promise<RtcInboundCall | null> {
    let waited = 0;
    for (;;) {
      const c = this.findDeviceCall(callId);
      if (c) return c;
      const call = this.calls.get(callId);
      if (!call || call.ended || waited >= ms) return null;
      await new Promise<void>((r) => this.setT(r, 100));
      waited += 100;
    }
  }

  // -------------------------------------------------------------------------
  // Realtime events
  // -------------------------------------------------------------------------

  private subscribeEvents(): void {
    const backend = this.backend;
    const callerId = this.callerId;
    if (!backend || !callerId) return;
    const gen = ++this.subscriptionGen;
    this.unsubscribe?.();
    this.unsubscribe = backend.subscribe(
      callerId,
      (row) => {
        if (gen === this.subscriptionGen) this.handleRow(row);
      },
      (status) => {
        if (gen === this.subscriptionGen) void this.onSubscriptionStatus(status);
      },
    );
  }

  private async onSubscriptionStatus(status: SubscriptionStatus): Promise<void> {
    if (status === 'subscribed') {
      this.resubscribeAttempt = 0;
      await this.backfill();
      return;
    }
    if (this.disconnecting) return;
    const delay = RESUBSCRIBE_DELAYS_MS[Math.min(this.resubscribeAttempt, RESUBSCRIBE_DELAYS_MS.length - 1)];
    this.resubscribeAttempt++;
    if (this.resubscribeAttempt === 4) this.emitError('Live call updates are reconnecting...');
    const gen = this.subscriptionGen;
    this.setT(() => {
      if (gen === this.subscriptionGen && !this.disconnecting) this.subscribeEvents();
    }, delay);
  }

  private async backfill(): Promise<void> {
    const backend = this.backend;
    const callerId = this.callerId;
    if (!backend || !callerId) return;
    try {
      const rows = await backend.eventsSince(callerId, this.lastEventId);
      for (const r of rows) this.handleRow(r);
    } catch {
      /* the next (re)subscription back-fills again */
    }
  }

  /** Visible for tests. */
  handleRow(row: TelephonyEventRow): void {
    if (typeof row.id !== 'number' || this.seenEventIds.has(row.id)) return;
    this.seenEventIds.add(row.id);
    // Rows from before this session started (a previous run of the app) are ignored.
    if (row.id <= this.baselineEventId) return;
    if (row.id > this.lastEventId) this.lastEventId = row.id;

    if (row.type === 'error') {
      if (row.message) this.emitError(row.message);
      return;
    }
    const callId = row.call_id;
    if (!callId) return;

    if (row.type === 'incoming') {
      if (this.calls.has(callId)) return;
      const call: KnownCall = { direction: 'inbound', answered: false, ended: false, timers: [], device: row.message === INCOMING_ON_DEVICE };
      this.calls.set(callId, call);
      call.timers.push(
        this.setT(() => {
          if (!call.answered && !call.ended) void this.callAction('timeout', callId).catch(() => {});
        }, INBOUND_RING_SECONDS * 1000),
      );
      this.emit({ type: 'incoming', callId, from: row.from_number ?? '', to: row.to_number ?? '' });
      this.flushPending(callId);
      return;
    }

    if (!this.calls.has(callId)) {
      // dial() has not returned this id yet; keep it briefly.
      this.prunePending();
      const p = this.pending.get(callId) ?? { rows: [], at: Date.now() };
      p.rows.push(row);
      this.pending.set(callId, p);
      return;
    }
    this.applyCallRow(callId, row);
  }

  private applyCallRow(callId: string, row: TelephonyEventRow): void {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    switch (row.type) {
      case 'ringing':
      case 'machine': {
        if (call.answered && row.type === 'ringing') return;
        const key = `${callId}:${row.type}`;
        if (this.emitted.has(key)) return;
        this.emitted.add(key);
        this.emit({ type: row.type, callId });
        return;
      }
      case 'answered': {
        if (call.answered) return;
        call.answered = true;
        this.emit({ type: 'answered', callId });
        return;
      }
      case 'ended':
        this.emitEnded(callId, (row.reason as EndReason | null) ?? 'failed');
        return;
      default:
        return;
    }
  }

  private flushPending(callId: string): void {
    const p = this.pending.get(callId);
    if (!p) return;
    this.pending.delete(callId);
    for (const row of p.rows.sort((a, b) => a.id - b.id)) this.applyCallRow(callId, row);
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.at > PENDING_EVENT_TTL_MS) this.pending.delete(id);
  }

  /** Emits the terminal event exactly once per call. */
  private emitEnded(callId: string, reason: EndReason): void {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    call.ended = true;
    for (const t of call.timers) this.clearT(t);
    call.timers = [];
    if (call.direction === 'inbound') {
      // Stop any SDK call still ringing / open for it (normally Telnyx has ended it already).
      const sdk = call.sdk ?? this.deviceCalls.get(callId);
      if (sdk && !sdk.ended) void sdk.hangup().catch(() => {});
      this.deviceCalls.delete(callId);
    }
    this.emit({ type: 'ended', callId, reason });
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  async dial(req: DialRequest): Promise<string> {
    if (!this._connected) throw new Error('Telephony is not connected.');
    const backend = await this.getBackend();
    const { callId } = await backend.invoke<{ callId: string }>('telnyx-dial', {
      to: req.to,
      from: req.from,
      leadId: req.leadId,
      ring: req.ring,
      ...(req.ringSeconds !== undefined ? { ringSeconds: req.ringSeconds } : {}),
      ...(req.detectMachine !== undefined ? { detectMachine: req.detectMachine } : {}),
      ...(req.record !== undefined ? { record: req.record } : {}),
    });
    const call: KnownCall = { direction: 'outbound', answered: false, ended: false, timers: [] };
    this.calls.set(callId, call);
    // Watchdog: if the call neither answers nor ends long after its ring time, the webhooks were
    // lost; hang it up and close it locally so the dialer never stalls.
    const ringMs = (req.ringSeconds ?? 60) * 1000;
    call.timers.push(
      this.setT(() => {
        if (call.answered || call.ended) return;
        void this.callAction('hangup', callId).catch(() => {});
        call.timers.push(this.setT(() => this.emitEnded(callId, 'failed'), LOCAL_END_FALLBACK_MS));
      }, ringMs + OUTBOUND_WATCHDOG_GRACE_MS),
    );
    // Deliver events that raced ahead of the dial response (after the caller has the id).
    this.setT(() => this.flushPending(callId), 0);
    return callId;
  }

  private async callAction(action: 'hangup' | 'answer' | 'decline' | 'timeout', callId: string) {
    const backend = await this.getBackend();
    return backend.invoke<{ ok: boolean; alreadyEnded?: boolean }>('telnyx-call', { action, callId });
  }

  async hangup(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.ended) return;
    let res: { alreadyEnded?: boolean } | null = null;
    if (call.sdk) void call.sdk.hangup().catch(() => {});
    try {
      res = await this.callAction('hangup', callId);
    } catch {
      res = await this.callAction('hangup', callId).catch(() => null);
    }
    // The server's `ended` (hangup_local) normally arrives within a second; never leave the engine
    // waiting if it does not.
    if (!call.ended) {
      call.timers.push(
        this.setT(() => this.emitEnded(callId, 'hangup_local'), res?.alreadyEnded ? 3_000 : LOCAL_END_FALLBACK_MS),
      );
    }
  }

  async sendDigits(callId: string, digits: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.ended || !call.answered) return;
    const clean = digits.replace(/[^0-9*#]/g, '');
    if (!clean) return;
    // Device calls carry their own audio; otherwise DTMF from the agent leg passes through the bridge.
    if (call.sdk) call.sdk.dtmf(clean);
    else this.agentCall?.dtmf(clean);
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    this.agentCall?.setMuted(muted);
    for (const c of this.calls.values()) if (c.sdk && !c.ended) c.sdk.setMuted(muted);
  }

  async answerIncoming(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.direction !== 'inbound' || call.ended || call.answered) return;
    for (const t of call.timers) this.clearT(t);
    call.timers = [];
    if (call.device || !this._connected) {
      await this.answerOnDevice(callId, call);
      return;
    }
    try {
      const res = await this.callAction('answer', callId);
      if (res.alreadyEnded) call.timers.push(this.setT(() => this.emitEnded(callId, 'hangup_remote'), 3_000));
    } catch (e) {
      // The server rang this device after all (the line opened while it was being offered).
      if (this.findDeviceCall(callId)) {
        await this.answerOnDevice(callId, call);
        return;
      }
      // e.g. the lead already hung up; the server's `ended` follows.
      this.emitError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Answers a call that rings this device: microphone check (only when no line is open), then the
   * SDK answer; the server bridges it to the person on its call.answered. Rejects with a message
   * the caller can act on; the engine then declines the call.
   */
  private async answerOnDevice(callId: string, call: KnownCall): Promise<void> {
    if (!this._connected) await (this.options.requestMicrophone ?? defaultRequestMicrophone)();
    const sdk = await this.waitForDeviceCall(callId, DEVICE_CALL_WAIT_MS);
    if (!sdk) {
      if (call.ended) return; // gone meanwhile (someone else took it / the person hung up)
      throw new Error('The call could not be connected to this computer. Check your internet connection.');
    }
    call.sdk = sdk;
    this.deviceCalls.delete(callId);
    await sdk.answer(this.muted);
    // Server `answered` normally follows within a second or two; if the person already hung up the
    // server `ended` arrives instead.
  }

  async declineIncoming(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.direction !== 'inbound' || call.ended) return;
    for (const t of call.timers) this.clearT(t);
    call.timers = [];
    const sdk = call.sdk ?? this.deviceCalls.get(callId);
    if (sdk) await sdk.hangup().catch(() => {});
    await this.callAction('decline', callId).catch(() => null);
    if (!call.ended) call.timers.push(this.setT(() => this.emitEnded(callId, 'hangup_local'), LOCAL_END_FALLBACK_MS));
  }
}
