/**
 * Simulated telephony for demo mode. No audio and no microphone: every call is a set of timers
 * that emit the same events a real provider would, with realistic random outcomes.
 *
 * Per outbound dial (drawn with the injected `random`):
 * - ~10% a human answers after 3–14 s (~18% on a second ring to the same number within a minute);
 *   the person hangs up after 25–150 s unless we hang up first.
 * - ~22% voicemail answers at 15–25 s (if ringSeconds runs out first it is just `no_answer`);
 *   with detectMachine a `machine` event follows 1.2–2.5 s later; the greeting hangs up after ~20 s.
 * - ~3% busy (~1.5 s), ~2% bad number (~1 s), ~1% failed (~2 s).
 * - Otherwise it rings for ringSeconds and ends with `no_answer`; then there is a ~4% chance the
 *   number calls back 30–120 s later as an `incoming` call that rings ~20 s.
 *
 * Speed: `speed` option, else `localStorage['questlabs.sim.speed']`, else 1 (4 = four times faster).
 * Deterministic under fake timers with an injected `random`.
 */
import type { DialRequest, EndReason, Telephony, TelephonyEvent, TelephonyListener } from './Telephony';

export interface SimulatedTelephonyOptions {
  /** Random source in [0,1) so tests can be deterministic. Default Math.random. */
  random?: () => number;
  /** Time multiplier (2 = everything happens twice as fast). Overrides the localStorage setting. */
  speed?: number;
  /** Clock in ms (used to spot a re-dial within a minute). Default Date.now. */
  now?: () => number;
}

export const SIM_SPEED_STORAGE_KEY = 'questlabs.sim.speed';

/** Outcome probabilities per dial (the rest ring out as no answer). */
export const SIM_ODDS = {
  human: 0.1,
  humanRetry: 0.18,
  voicemail: 0.22,
  busy: 0.03,
  badNumber: 0.02,
  failed: 0.01,
  callback: 0.04,
} as const;

const DEFAULT_RING_SECONDS = 22;
const RETRY_WINDOW_MS = 60_000;

interface SimCall {
  id: string;
  state: 'ringing' | 'answered' | 'incoming';
  timers: Set<ReturnType<typeof setTimeout>>;
}

function readStoredSpeed(): number | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    const raw = localStorage.getItem(SIM_SPEED_STORAGE_KEY);
    if (!raw) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export class SimulatedTelephony implements Telephony {
  readonly kind = 'simulated' as const;
  private _connected = false;
  private listeners = new Set<TelephonyListener>();
  private calls = new Map<string, SimCall>();
  /** Timers not tied to a live call (scheduled call-backs). */
  private looseTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastDialAt = new Map<string, number>();
  private seq = 0;
  private muted = false;
  protected readonly random: () => number;
  private readonly fixedSpeed: number | null;
  private readonly now: () => number;

  constructor(opts: SimulatedTelephonyOptions = {}) {
    this.random = opts.random ?? Math.random;
    this.fixedSpeed = opts.speed !== undefined && Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : null;
    this.now = opts.now ?? (() => Date.now());
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Current time multiplier. */
  get speed(): number {
    return this.fixedSpeed ?? readStoredSpeed() ?? 1;
  }

  /** Whether the (simulated) microphone is muted. */
  get isMuted(): boolean {
    return this.muted;
  }

  protected emit(event: TelephonyEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* a listener failing must not break the simulation */
      }
    }
  }

  private ms(seconds: number): number {
    return Math.max(0, (seconds * 1000) / this.speed);
  }

  /** Runs `fn` after `seconds` (sim time) as long as the call is still live. */
  private after(call: SimCall, seconds: number, fn: () => void): void {
    const t = setTimeout(() => {
      call.timers.delete(t);
      if (this.calls.get(call.id) === call) fn();
    }, this.ms(seconds));
    call.timers.add(t);
  }

  private clearTimers(call: SimCall): void {
    for (const t of call.timers) clearTimeout(t);
    call.timers.clear();
  }

  /** Terminal event; at most once per call. */
  private finish(call: SimCall, reason: EndReason): void {
    if (this.calls.get(call.id) !== call) return;
    this.clearTimers(call);
    this.calls.delete(call.id);
    this.emit({ type: 'ended', callId: call.id, reason });
  }

  private newCall(state: SimCall['state']): SimCall {
    const call: SimCall = { id: `sim_${++this.seq}`, state, timers: new Set() };
    this.calls.set(call.id, call);
    return call;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.ms(0.3)));
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    for (const t of this.looseTimers) clearTimeout(t);
    this.looseTimers.clear();
    for (const call of [...this.calls.values()]) this.finish(call, 'hangup_local');
    this._connected = false;
    this.muted = false;
  }

  async dial(req: DialRequest): Promise<string> {
    if (!this._connected) throw new Error('Telephony is not connected.');
    const call = this.newCall('ringing');
    const ringSeconds = req.ringSeconds ?? DEFAULT_RING_SECONDS;
    const detectMachine = req.detectMachine ?? true;
    const nowMs = this.now();
    const last = this.lastDialAt.get(req.to);
    const retry = req.ring === 2 || (last !== undefined && nowMs - last < RETRY_WINDOW_MS);
    this.lastDialAt.set(req.to, nowMs);

    this.after(call, 0.3, () => this.emit({ type: 'ringing', callId: call.id }));

    const ringOut = () =>
      this.after(call, ringSeconds, () => {
        this.finish(call, 'no_answer');
        this.maybeCallBack(req);
      });

    const pHuman = retry ? SIM_ODDS.humanRetry : SIM_ODDS.human;
    const r = this.random();
    let edge = pHuman;
    if (r < edge) {
      const at = 3 + this.random() * 11;
      if (at >= ringSeconds) ringOut();
      else this.after(call, at, () => this.answerHuman(call));
      return call.id;
    }
    edge += SIM_ODDS.voicemail;
    if (r < edge) {
      const at = 15 + this.random() * 10;
      if (at >= ringSeconds) ringOut();
      else this.after(call, at, () => this.answerMachine(call, detectMachine));
      return call.id;
    }
    edge += SIM_ODDS.busy;
    if (r < edge) {
      this.after(call, 1.5, () => this.finish(call, 'busy'));
      return call.id;
    }
    edge += SIM_ODDS.badNumber;
    if (r < edge) {
      this.after(call, 1, () => this.finish(call, 'bad_number'));
      return call.id;
    }
    edge += SIM_ODDS.failed;
    if (r < edge) {
      this.after(call, 2, () => this.finish(call, 'failed'));
      return call.id;
    }
    ringOut();
    return call.id;
  }

  private answerHuman(call: SimCall): void {
    call.state = 'answered';
    this.emit({ type: 'answered', callId: call.id });
    const talk = 25 + this.random() * 125;
    this.after(call, talk, () => this.finish(call, 'hangup_remote'));
  }

  private answerMachine(call: SimCall, detectMachine: boolean): void {
    call.state = 'answered';
    this.emit({ type: 'answered', callId: call.id });
    if (detectMachine) {
      const delay = 1.2 + this.random() * 1.3;
      this.after(call, delay, () => this.emit({ type: 'machine', callId: call.id }));
    }
    this.after(call, 20, () => this.finish(call, 'hangup_remote'));
  }

  /** After a no-answer the lead sometimes calls back. */
  private maybeCallBack(req: DialRequest): void {
    if (this.random() >= SIM_ODDS.callback) return;
    const delay = 30 + this.random() * 90;
    const t = setTimeout(() => {
      this.looseTimers.delete(t);
      if (!this._connected) return;
      const call = this.newCall('incoming');
      this.emit({ type: 'incoming', callId: call.id, from: req.to, to: req.from });
      this.after(call, 20, () => this.finish(call, 'hangup_remote'));
    }, this.ms(delay));
    this.looseTimers.add(t);
  }

  async hangup(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call) this.finish(call, 'hangup_local');
  }

  async sendDigits(_callId: string, _digits: string): Promise<void> {}

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
  }

  async answerIncoming(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'incoming') return;
    this.clearTimers(call);
    call.state = 'answered';
    this.emit({ type: 'answered', callId });
    const talk = 25 + this.random() * 125;
    this.after(call, talk, () => this.finish(call, 'hangup_remote'));
  }

  async declineIncoming(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (call && call.state === 'incoming') this.finish(call, 'hangup_local');
  }

  on(listener: TelephonyListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
