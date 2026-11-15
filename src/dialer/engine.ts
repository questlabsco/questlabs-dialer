/**
 * The power-dialer state machine.
 *
 * - Rings `linesPerCaller` leads at once; the first human pickup is connected, every other line is
 *   hung up ("dropped") and its lead released back to the queue without counting a missed day.
 * - Double ring: a missed ring 1 is immediately re-rung as ring 2 from the same outbound number.
 * - Each lead has up to 3 phones, tried in order; once all are used the lead gets a missed day.
 * - Voicemail is detected on the active call and skipped like a missed ring.
 * - Inbound calls (leads calling back) are offered to the caller between calls.
 *
 * Every transition (control calls, telephony events, timers) runs through one promise queue, so
 * there are no interleaving races. Internal mutable bookkeeping (`slots`, `active`, `wrap`,
 * `pending`) is rendered into a fresh immutable `DialerState` on each `commit()`.
 *
 * No React here; see `useDialer.ts`.
 */
import { errorMessage, type Api } from '../api/Api';
import { DEFAULT_SETTINGS, type CallResult, type Lead, type PhoneNumber, type PresenceStatus, type Settings } from '../types';
import type { EndReason, Telephony, TelephonyEvent } from '../telephony/Telephony';
import {
  INITIAL_DIALER_STATE,
  type ActiveCall,
  type DialerControls,
  type DialerSessionStats,
  type DialerState,
  type IncomingCall,
  type LineState,
  type SubmitDispositionInput,
  type WrapUp,
} from './types';

export interface DialerEngineDeps {
  api: Api;
  telephony: Telephony;
  /** Clock in ms; injectable for tests. Default Date.now. */
  now?: () => number;
}

export type DialerListener = (state: DialerState) => void;

/** Extra time the engine waits past ringSeconds before hanging up a ring itself. */
export const RING_GRACE_MS = 3_000;
/** How often an empty queue is re-checked. */
export const QUEUE_POLL_MS = 20_000;
/** Talk time from which a call counts as a conversation (matches MetricsTotals). */
export const CONVERSATION_MIN_SECONDS = 20;

export const NO_CAPACITY_MESSAGE =
  'No outbound numbers have capacity left today. Ask your admin to add numbers or raise the daily caps.';

/** The next ring a lead on a line is waiting for. */
interface NextRing {
  ring: 1 | 2;
  phoneIdx: number;
  /** Fixed for ring 2 (same number as ring 1); null = pick a number. */
  fromNumber: string | null;
}

interface Slot {
  index: number;
  status: 'empty' | 'ringing' | 'answered';
  /** Set while the line holds a lead (ringing, answered, or waiting for its next ring). */
  lead: Lead | null;
  /** Snapshot of the lead's phones at claim time, in dialing order. */
  phones: string[];
  phoneIdx: number;
  ring: 1 | 2;
  fromNumber: string;
  callId: string | null;
  callRecordId: string | null;
  startedAtMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Lead is waiting to be rung (new rings are blocked, or about to start). */
  next: NextRing | null;
  /** At least one ring on this lead today ended without a human (not counting bad numbers). */
  anyMissed: boolean;
}

interface Active {
  callId: string;
  callRecordId: string;
  lead: Lead;
  /** Inbound caller with no matching lead (display-only lead, no wrap-up). */
  synthetic: boolean;
  answeredAtMs: number;
  direction: 'outbound' | 'inbound';
  fromNumber: string;
  toNumber: string;
  /** Slot index for outbound calls; null for inbound. */
  lineIndex: number | null;
  muted: boolean;
}

interface Pending {
  callId: string;
  from: string;
  to: string;
  lead: Lead | null;
  /** answerIncoming() was called; waiting for the `answered` event. */
  answering: boolean;
}

function emptySlot(index: number): Slot {
  return {
    index,
    status: 'empty',
    lead: null,
    phones: [],
    phoneIdx: 0,
    ring: 1,
    fromNumber: '',
    callId: null,
    callRecordId: null,
    startedAtMs: null,
    timer: null,
    next: null,
    anyMissed: false,
  };
}

function resultForEnd(reason: EndReason): CallResult {
  switch (reason) {
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'bad_number':
      return 'bad_number';
    case 'hangup_local':
      // We did not ask for this hangup (provider dropped it): count it as a failed ring.
      return 'failed';
    case 'no_answer':
    case 'hangup_remote':
    default:
      return 'no_answer';
  }
}

function warn(context: string, e: unknown): void {
  if (typeof console !== 'undefined') console.warn(`[dialer] ${context}:`, errorMessage(e));
}

export class DialerEngine implements DialerControls {
  protected readonly api: Api;
  protected readonly telephony: Telephony;
  protected readonly now: () => number;
  private state: DialerState = INITIAL_DIALER_STATE;
  private listeners = new Set<DialerListener>();

  private settings: Settings = DEFAULT_SETTINGS;
  private slots: Slot[] = [];
  private active: Active | null = null;
  private wrap: WrapUp | null = null;
  private pending: Pending | null = null;
  private stopRequested = false;
  /** Fatal error raised during a call; applied once the wrap-up is done. */
  private fatalAfterWrapUp: string | null = null;
  private telephonyMuted = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /**
   * Calls we hung up as `dropped` whose `ended` event has not arrived yet. If an `answered` event
   * for one of them is still in flight, that person picked up before our hangup: `dropped_pickup`.
   */
  private droppedCalls = new Map<string, string | null>();

  private queue: Promise<unknown> = Promise.resolve();
  private presenceChain: Promise<void> = Promise.resolve();
  private readonly unsubscribeTelephony: () => void;

  constructor(deps: DialerEngineDeps) {
    this.api = deps.api;
    this.telephony = deps.telephony;
    this.now = deps.now ?? (() => Date.now());
    this.unsubscribeTelephony = this.telephony.on((event) => {
      void this.run(() => this.handleEvent(event)).catch((e) => warn(`handling ${event.type}`, e));
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current immutable snapshot. A new object is created on every change. */
  getState(): DialerState {
    return this.state;
  }

  /** Called after every state change. Returns unsubscribe. */
  subscribe(listener: DialerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves once every queued transition (and anything they queued) has finished. */
  async settled(): Promise<void> {
    let last: Promise<unknown> | null = null;
    while (last !== this.queue) {
      last = this.queue;
      await last.catch(() => undefined);
    }
    await this.presenceChain;
  }

  /** Release resources (hang up, release locks, unsubscribe, timers). Called on sign-out. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.run(async () => {
      if (this.disposed) return;
      if (this.active) {
        const a = this.active;
        this.active = null;
        await this.hangupQuietly(a.callId);
        if (a.callRecordId) {
          const end = this.now();
          await this.safe('finalizing call', this.api.updateCall(a.callRecordId, {
            endedAt: this.iso(end),
            talkSeconds: Math.max(0, Math.round((end - a.answeredAtMs) / 1000)),
          }));
        }
      }
      if (this.wrap) {
        await this.release([this.wrap.lead.id]);
        this.wrap = null;
      }
      await this.finalStop();
      this.disposed = true;
    });
    this.unsubscribeTelephony();
    this.listeners.clear();
  }

  start(): Promise<void> {
    return this.control(async () => {
      if (this.state.phase !== 'idle' && this.state.phase !== 'error') return;
      this.resetInternals();
      this.commit({
        ...INITIAL_DIALER_STATE,
        phase: 'starting',
        session: { ...INITIAL_DIALER_STATE.session, startedAt: this.iso() },
      });
      try {
        this.settings = { ...DEFAULT_SETTINGS, ...(await this.api.getSettings()) };
      } catch (e) {
        this.commit({ phase: 'error', error: `Couldn't load settings: ${errorMessage(e)}` });
        return;
      }
      try {
        await this.telephony.connect();
      } catch (e) {
        this.commit({ phase: 'error', error: `Couldn't connect your audio: ${errorMessage(e)}` });
        return;
      }
      const n = Math.max(1, Math.min(10, Math.floor(this.settings.linesPerCaller || 2)));
      this.slots = Array.from({ length: n }, (_, i) => emptySlot(i));
      this.presence('dialing');
      this.commit({ phase: 'dialing' });
      await this.fill();
    });
  }

  pause(): Promise<void> {
    return this.control(async () => {
      const phase = this.state.phase;
      if (phase === 'connected' || phase === 'wrap_up') {
        this.commit({ pauseRequested: !this.state.pauseRequested });
      } else if (phase === 'dialing') {
        await this.enterPaused();
      }
    });
  }

  resume(): Promise<void> {
    return this.control(async () => {
      const phase = this.state.phase;
      if (phase === 'paused') {
        this.presence('dialing');
        this.commit({ phase: 'dialing', pauseRequested: false });
        await this.fill();
      } else if ((phase === 'connected' || phase === 'wrap_up') && this.state.pauseRequested) {
        this.commit({ pauseRequested: false });
      }
    });
  }

  stop(): Promise<void> {
    return this.control(async () => {
      const phase = this.state.phase;
      if (phase === 'idle') return;
      if (this.active) {
        this.stopRequested = true;
        const a = this.active;
        this.detach(a.callId);
        await this.hangupQuietly(a.callId);
        await this.endActive();
        return;
      }
      if (this.wrap) {
        // Keep the wrap-up so the outcome is not lost; go idle once it is submitted.
        this.stopRequested = true;
        this.commit();
        return;
      }
      await this.finalStop();
    });
  }

  hangUp(): Promise<void> {
    return this.control(async () => {
      const a = this.active;
      if (!a) return;
      this.detach(a.callId);
      await this.hangupQuietly(a.callId);
      await this.endActive();
    });
  }

  toggleMute(): Promise<void> {
    return this.control(async () => {
      const a = this.active;
      if (!a) return;
      const muted = !a.muted;
      try {
        await this.telephony.setMuted(muted);
      } catch (e) {
        warn('mute', e);
        return;
      }
      this.telephonyMuted = muted;
      a.muted = muted;
      this.commit();
    });
  }

  sendDigits(digits: string): Promise<void> {
    return this.control(async () => {
      const a = this.active;
      if (!a || !digits) return;
      try {
        await this.telephony.sendDigits(a.callId, digits);
      } catch (e) {
        warn('send digits', e);
      }
    });
  }

  /**
   * Saves the outcome. On API failure the wrap-up stays open, `state.error` is set and the promise
   * rejects (so the screen keeps the caller's notes).
   */
  submitDisposition(input: SubmitDispositionInput): Promise<void> {
    return this.control(async () => {
      const w = this.wrap;
      if (!w || this.state.phase !== 'wrap_up') return;
      try {
        await this.api.saveDisposition({
          callId: w.callRecordId,
          leadId: w.lead.id,
          disposition: input.disposition,
          notes: input.notes,
          callbackAt: input.callbackAt ?? null,
        });
      } catch (e) {
        this.commit({ error: `Couldn't save the outcome: ${errorMessage(e)}` });
        throw e;
      }
      this.wrap = null;
      const session = input.disposition === 'booked' ? { ...this.state.session, bookings: this.state.session.bookings + 1 } : this.state.session;
      this.commit({ session, error: this.fatalAfterWrapUp });
      await this.afterCallDone();
    });
  }

  answerIncoming(): Promise<void> {
    return this.control(async () => {
      const p = this.pending;
      if (!p || p.answering || this.active || this.wrap) return;
      const ids = await this.hangupLines();
      await this.release(ids);
      this.clearPoll();
      if (this.state.phase === 'paused') this.commit({ pauseRequested: true });
      p.answering = true;
      this.commit({ queueEmpty: false });
      try {
        await this.telephony.answerIncoming(p.callId);
      } catch (e) {
        warn('answer incoming', e);
        this.detach(p.callId);
        this.pending = null;
        await this.logMissedInbound(p);
        this.commit();
        await this.afterIncomingCleared();
      }
    });
  }

  declineIncoming(): Promise<void> {
    return this.control(async () => {
      const p = this.pending;
      if (!p || p.answering) return;
      this.detach(p.callId);
      this.pending = null;
      try {
        await this.telephony.declineIncoming(p.callId);
      } catch (e) {
        warn('decline incoming', e);
      }
      await this.logMissedInbound(p);
      this.commit();
      await this.afterIncomingCleared();
    });
  }

  // -------------------------------------------------------------------------
  // Queue & state plumbing
  // -------------------------------------------------------------------------

  /** Serializes `fn` after every previously queued transition. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private control(fn: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.run(async () => {
      if (this.disposed) return;
      await fn();
    });
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  private renderLine(s: Slot): LineState {
    if (s.status === 'empty' || !s.lead) {
      return { index: s.index, status: 'empty', lead: null, phone: '', fromNumber: '', ring: 1, callId: null, startedAt: null };
    }
    return {
      index: s.index,
      status: s.status,
      lead: s.lead,
      phone: s.phones[s.phoneIdx] ?? '',
      fromNumber: s.fromNumber,
      ring: s.ring,
      callId: s.callId,
      startedAt: s.startedAtMs === null ? null : this.iso(s.startedAtMs),
    };
  }

  private renderActive(): ActiveCall | null {
    const a = this.active;
    if (!a) return null;
    return {
      lead: a.lead,
      callId: a.callId,
      callRecordId: a.callRecordId,
      fromNumber: a.fromNumber,
      toNumber: a.toNumber,
      answeredAt: this.iso(a.answeredAtMs),
      muted: a.muted,
      direction: a.direction,
    };
  }

  private renderIncoming(): IncomingCall | null {
    const p = this.pending;
    return p ? { callId: p.callId, from: p.from, lead: p.lead } : null;
  }

  /** Publishes a new snapshot (internal bookkeeping + `patch`) and notifies subscribers once. */
  private commit(patch: Partial<DialerState> = {}): void {
    this.state = {
      ...this.state,
      ...patch,
      lines: this.slots.map((s) => this.renderLine(s)),
      activeCall: this.renderActive(),
      wrapUp: this.wrap ? { ...this.wrap } : null,
      incoming: this.renderIncoming(),
    };
    for (const l of [...this.listeners]) {
      try {
        l(this.state);
      } catch (e) {
        warn('listener', e);
      }
    }
  }

  private bumpSession(patch: Partial<DialerSessionStats>): DialerSessionStats {
    return { ...this.state.session, ...patch };
  }

  private resetInternals(): void {
    this.clearPoll();
    for (const s of this.slots) if (s.timer) clearTimeout(s.timer);
    this.slots = [];
    this.active = null;
    this.wrap = null;
    this.pending = null;
    this.stopRequested = false;
    this.fatalAfterWrapUp = null;
  }

  private presence(status: PresenceStatus, detail: string | null = null): void {
    this.presenceChain = this.presenceChain
      .then(() => this.api.setPresence(status, detail))
      .catch((e) => warn('presence', e));
  }

  private async safe<T>(context: string, p: Promise<T>): Promise<T | undefined> {
    try {
      return await p;
    } catch (e) {
      warn(context, e);
      return undefined;
    }
  }

  private async release(ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length) await this.safe('releasing leads', this.api.releaseLeads(unique));
  }

  private async hangupQuietly(callId: string): Promise<void> {
    await this.safe('hangup', this.telephony.hangup(callId));
  }

  /** Forget a call id so its later events (e.g. `ended { hangup_local }`) are ignored. */
  private detach(callId: string): void {
    for (const s of this.slots) {
      if (s.callId === callId) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
        s.callId = null;
      }
    }
  }

  private clearPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedulePoll(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.run(() => this.fill()).catch((e) => warn('poll', e));
    }, QUEUE_POLL_MS);
  }

  private heldLeadIds(): Set<string> {
    const ids = new Set<string>();
    for (const s of this.slots) if (s.lead) ids.add(s.lead.id);
    if (this.active && !this.active.synthetic) ids.add(this.active.lead.id);
    if (this.wrap) ids.add(this.wrap.lead.id);
    return ids;
  }

  private canStartRings(): boolean {
    return (
      this.state.phase === 'dialing' &&
      !this.active &&
      !this.wrap &&
      !this.pending &&
      !this.state.pauseRequested &&
      !this.stopRequested &&
      !this.disposed
    );
  }

  private slotForCall(callId: string): Slot | undefined {
    return this.slots.find((s) => s.callId === callId);
  }

  // -------------------------------------------------------------------------
  // Dialing
  // -------------------------------------------------------------------------

  /** Claims leads for empty lines and starts ringing them. */
  private async fill(): Promise<void> {
    if (!this.canStartRings()) return;
    // Lines waiting for their next ring first.
    for (const s of this.slots) {
      if (s.lead && s.next && s.status === 'empty') {
        if (!(await this.ringNext(s))) return;
        if (!this.canStartRings()) return;
      }
    }
    const empty = this.slots.filter((s) => !s.lead);
    if (empty.length === 0) return;
    const held = this.heldLeadIds();
    let claimed: Lead[];
    try {
      claimed = await this.api.claimNextLeads(Math.min(10, empty.length + held.size));
    } catch (e) {
      await this.enterFatal(`Couldn't load leads: ${errorMessage(e)}`);
      return;
    }
    // claimNextLeads may return leads we already hold on another line.
    const fresh = claimed.filter((l) => !held.has(l.id));
    const usable = fresh.filter((l) => l.phones.length > 0);
    const use = usable.slice(0, empty.length);
    const surplus = fresh.filter((l) => !use.includes(l));
    await this.release(surplus.map((l) => l.id));
    if (!this.canStartRings()) {
      await this.release(use.map((l) => l.id));
      return;
    }

    if (use.length === 0) {
      const busy = this.slots.some((s) => s.lead);
      if (!busy && !this.state.queueEmpty) this.commit({ queueEmpty: true });
      this.schedulePoll();
      return;
    }
    this.clearPoll();
    if (this.state.queueEmpty) this.commit({ queueEmpty: false });

    // Reserve every slot first so a failure part-way releases all of them.
    use.forEach((lead, i) => {
      const s = empty[i];
      Object.assign(s, emptySlot(s.index), {
        lead,
        phones: [...lead.phones],
        next: { ring: 1, phoneIdx: 0, fromNumber: null } satisfies NextRing,
      });
    });
    for (const s of empty) {
      if (!s.lead || !s.next) continue;
      if (!(await this.ringNext(s))) return;
      if (!this.canStartRings()) return;
    }
  }

  /** Rings `slot.next`. Returns false when a fatal error stopped the dialer. */
  private async ringNext(slot: Slot): Promise<boolean> {
    const next = slot.next;
    const lead = slot.lead;
    if (!next || !lead) return true;
    if (!this.canStartRings()) {
      this.commit();
      return true;
    }
    const phone = slot.phones[next.phoneIdx];
    let from = next.fromNumber;
    if (!from) {
      let num: PhoneNumber | null;
      try {
        num = await this.api.pickFromNumber(phone);
      } catch (e) {
        await this.enterFatal(`Couldn't pick an outbound number: ${errorMessage(e)}`);
        return false;
      }
      if (!num) {
        await this.enterFatal(NO_CAPACITY_MESSAGE);
        return false;
      }
      from = num.number;
    }

    let callId: string;
    try {
      callId = await this.telephony.dial({
        to: phone,
        from,
        leadId: lead.id,
        ring: next.ring,
        ringSeconds: this.settings.ringSeconds,
        detectMachine: this.settings.skipVoicemail,
        record: this.settings.recordCalls,
      });
    } catch (e) {
      await this.enterFatal(`Couldn't place the call: ${errorMessage(e)}`);
      return false;
    }

    const startedAtMs = this.now();
    let recordId: string;
    try {
      const rec = await this.api.createCall({
        leadId: lead.id,
        direction: 'outbound',
        fromNumber: from,
        toNumber: phone,
        ring: next.ring,
        startedAt: this.iso(startedAtMs),
        providerCallId: callId,
      });
      recordId = rec.id;
    } catch (e) {
      await this.hangupQuietly(callId);
      await this.enterFatal(`Couldn't log the call: ${errorMessage(e)}`);
      return false;
    }

    slot.status = 'ringing';
    slot.phoneIdx = next.phoneIdx;
    slot.ring = next.ring;
    slot.fromNumber = from;
    slot.callId = callId;
    slot.callRecordId = recordId;
    slot.startedAtMs = startedAtMs;
    slot.next = null;
    const ringMs = Math.max(1, this.settings.ringSeconds) * 1000 + RING_GRACE_MS;
    slot.timer = setTimeout(() => {
      void this.run(() => this.onRingTimeout(slot.index, callId)).catch((e) => warn('ring timeout', e));
    }, ringMs);
    this.commit({ session: this.bumpSession({ dials: this.state.session.dials + 1 }) });
    return true;
  }

  /**
   * A ring on `slot` ended without a connected human. Decides the next ring (double ring, next
   * phone) or finishes the lead (missed day). Starts the next ring now if allowed, else parks it.
   */
  private async missedRing(slot: Slot, result: CallResult): Promise<void> {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.callId = null;
    slot.callRecordId = null;
    slot.startedAtMs = null;
    slot.status = 'empty';
    if (!slot.lead) return;
    if (result !== 'bad_number') slot.anyMissed = true;

    let next: NextRing | null = null;
    if (result !== 'bad_number' && slot.ring === 1 && this.settings.doubleRing) {
      next = { ring: 2, phoneIdx: slot.phoneIdx, fromNumber: slot.fromNumber };
    } else if (slot.phoneIdx + 1 < slot.phones.length) {
      next = { ring: 1, phoneIdx: slot.phoneIdx + 1, fromNumber: null };
    }

    if (!next) {
      await this.finishLead(slot);
      return;
    }
    slot.next = next;
    if (this.canStartRings()) await this.ringNext(slot);
    else this.commit();
  }

  /** Every phone on the slot's lead is used up: missed day (or nothing, if all were bad numbers). */
  private async finishLead(slot: Slot): Promise<void> {
    const lead = slot.lead;
    const missed = slot.anyMissed;
    Object.assign(slot, emptySlot(slot.index));
    this.commit();
    if (!lead) return;
    if (missed) {
      const ok = await this.safe('reporting missed day', this.api.reportMissedDay(lead.id));
      if (!ok) await this.release([lead.id]);
    } else {
      await this.release([lead.id]);
    }
  }

  /**
   * Hangs up every ringing line (result `dropped`) and empties lines waiting for a ring.
   * Returns the lead ids to release (no missed day is counted).
   */
  private async hangupLines(except?: Slot, result: CallResult = 'dropped'): Promise<string[]> {
    const ids: string[] = [];
    const updates: Promise<unknown>[] = [];
    const endedAt = this.iso();
    for (const s of this.slots) {
      if (s === except || !s.lead) continue;
      if (s.status === 'answered') continue;
      const callId = s.callId;
      const recordId = s.callRecordId;
      ids.push(s.lead.id);
      if (s.timer) clearTimeout(s.timer);
      Object.assign(s, emptySlot(s.index));
      if (callId) {
        if (result === 'dropped') this.rememberDropped(callId, recordId);
        await this.hangupQuietly(callId);
        if (recordId) updates.push(this.safe('dropping line', this.api.updateCall(recordId, { endedAt, result })));
      }
    }
    if (ids.length) this.commit();
    await Promise.all(updates);
    return ids;
  }

  private rememberDropped(callId: string, recordId: string | null): void {
    this.droppedCalls.set(callId, recordId);
    if (this.droppedCalls.size > 50) {
      const oldest = this.droppedCalls.keys().next().value;
      if (oldest !== undefined) this.droppedCalls.delete(oldest);
    }
  }

  private async onRingTimeout(index: number, callId: string): Promise<void> {
    const slot = this.slots[index];
    if (!slot || slot.callId !== callId || slot.status !== 'ringing') return;
    const recordId = slot.callRecordId;
    this.detach(callId);
    await this.hangupQuietly(callId);
    if (recordId) await this.safe('ring timeout', this.api.updateCall(recordId, { endedAt: this.iso(), result: 'no_answer' }));
    await this.missedRing(slot, 'no_answer');
    await this.fill();
  }

  // -------------------------------------------------------------------------
  // Telephony events
  // -------------------------------------------------------------------------

  private async handleEvent(e: TelephonyEvent): Promise<void> {
    if (this.disposed) return;
    switch (e.type) {
      case 'ringing':
        return;
      case 'answered':
        return this.onAnswered(e.callId);
      case 'machine':
        return this.onMachine(e.callId);
      case 'ended':
        return this.onEnded(e.callId, e.reason);
      case 'incoming':
        return this.onIncoming(e.callId, e.from, e.to);
      case 'error':
        return this.enterFatal(e.message || 'The phone connection failed.');
    }
  }

  private async onAnswered(callId: string): Promise<void> {
    const p = this.pending;
    if (p && p.callId === callId) {
      if (p.answering) await this.connectInbound(p);
      return;
    }
    if (this.droppedCalls.has(callId)) {
      // Picked up while we were already hanging up on them (another line won).
      const recordId = this.droppedCalls.get(callId) ?? null;
      this.droppedCalls.delete(callId);
      const at = this.iso();
      if (recordId) await this.safe('dropped pickup', this.api.updateCall(recordId, { answeredAt: at, endedAt: at, result: 'dropped_pickup' }));
      return;
    }
    const slot = this.slotForCall(callId);
    if (!slot || slot.status !== 'ringing' || !slot.lead) return;

    if (this.active || this.wrap || this.state.phase !== 'dialing') {
      // Second pickup race: someone else already got the caller.
      const lead = slot.lead;
      const recordId = slot.callRecordId;
      this.detach(callId);
      Object.assign(slot, emptySlot(slot.index));
      this.commit();
      await this.hangupQuietly(callId);
      const at = this.iso();
      if (recordId) await this.safe('dropped pickup', this.api.updateCall(recordId, { answeredAt: at, endedAt: at, result: 'dropped_pickup' }));
      await this.release([lead.id]);
      return;
    }

    // First pickup wins.
    const answeredAtMs = this.now();
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.status = 'answered';
    this.active = {
      callId,
      callRecordId: slot.callRecordId ?? '',
      lead: slot.lead,
      synthetic: false,
      answeredAtMs,
      direction: 'outbound',
      fromNumber: slot.fromNumber,
      toNumber: slot.phones[slot.phoneIdx] ?? '',
      lineIndex: slot.index,
      muted: false,
    };
    this.clearPoll();
    this.presence('on_call', slot.lead.businessName);
    this.commit({ phase: 'connected', queueEmpty: false, session: this.bumpSession({ pickups: this.state.session.pickups + 1 }) });
    await this.unmuteForNewCall();

    const dropped = await this.hangupLines(slot);
    const p2 = this.pending;
    if (p2 && !p2.answering) {
      this.detach(p2.callId);
      this.pending = null;
      await this.safe('decline incoming', this.telephony.declineIncoming(p2.callId));
      await this.logMissedInbound(p2);
      this.commit();
    }
    if (slot.callRecordId) {
      await this.safe('answered', this.api.updateCall(slot.callRecordId, { answeredAt: this.iso(answeredAtMs), result: 'answered' }));
    }
    await this.release(dropped);
  }

  private async onMachine(callId: string): Promise<void> {
    const a = this.active;
    if (!a || a.callId !== callId || a.direction !== 'outbound' || a.lineIndex === null) return;
    if (!this.settings.skipVoicemail) return;
    const slot = this.slots[a.lineIndex];
    this.active = null;
    this.detach(callId);
    await this.hangupQuietly(callId);
    if (a.callRecordId) {
      await this.safe('voicemail', this.api.updateCall(a.callRecordId, { result: 'voicemail', talkSeconds: 0, endedAt: this.iso() }));
    }
    const session = this.bumpSession({ pickups: Math.max(0, this.state.session.pickups - 1) });
    const resumeDialing = !this.stopRequested && !this.fatalAfterWrapUp && !this.state.pauseRequested;
    if (resumeDialing) {
      this.presence('dialing');
      this.commit({ phase: 'dialing', session });
    } else {
      this.commit({ session });
    }
    if (slot) await this.missedRing(slot, 'voicemail');
    if (resumeDialing) {
      await this.fill();
    } else {
      await this.afterCallDone();
    }
  }

  private async onEnded(callId: string, reason: EndReason): Promise<void> {
    if (this.droppedCalls.delete(callId)) return;
    const p = this.pending;
    if (p && p.callId === callId) {
      // The inbound caller gave up (or the provider dropped it before we were connected).
      this.pending = null;
      await this.logMissedInbound(p);
      this.commit();
      await this.afterIncomingCleared();
      return;
    }
    if (this.active && this.active.callId === callId) {
      await this.endActive();
      return;
    }
    const slot = this.slotForCall(callId);
    if (!slot || slot.status !== 'ringing' || !slot.lead) return;
    const result = resultForEnd(reason);
    const recordId = slot.callRecordId;
    const lead = slot.lead;
    const phone = slot.phones[slot.phoneIdx];
    this.detach(callId);
    if (recordId) await this.safe('ring ended', this.api.updateCall(recordId, { endedAt: this.iso(), result }));
    if (result === 'bad_number') await this.safe('reporting bad number', this.api.reportBadNumber(lead.id, phone));
    await this.missedRing(slot, result);
    await this.fill();
  }

  private async onIncoming(callId: string, from: string, to: string): Promise<void> {
    const phase = this.state.phase;
    const canOffer = (phase === 'dialing' || phase === 'paused') && !this.active && !this.wrap && !this.pending;
    const lead = (await this.safe('finding lead', this.api.findLeadByPhone(from))) ?? null;
    if (!canOffer) {
      await this.safe('decline incoming', this.telephony.declineIncoming(callId));
      if (phase !== 'idle') await this.logMissedInbound({ callId, from, to, lead, answering: false });
      return;
    }
    this.pending = { callId, from, to, lead, answering: false };
    this.commit();
  }

  private async connectInbound(p: Pending): Promise<void> {
    const answeredAtMs = this.now();
    const lead = p.lead ?? this.syntheticLead(p.from);
    const rec = await this.safe(
      'logging inbound call',
      this.api.createCall({
        leadId: p.lead ? p.lead.id : null,
        direction: 'inbound',
        fromNumber: p.from,
        toNumber: p.to,
        ring: 1,
        startedAt: this.iso(answeredAtMs),
        answeredAt: this.iso(answeredAtMs),
        result: 'answered',
        providerCallId: p.callId,
      }),
    );
    this.pending = null;
    this.active = {
      callId: p.callId,
      callRecordId: rec?.id ?? '',
      lead,
      synthetic: !p.lead,
      answeredAtMs,
      direction: 'inbound',
      fromNumber: p.from,
      toNumber: p.to,
      lineIndex: null,
      muted: false,
    };
    this.presence('on_call', lead.businessName);
    this.commit({ phase: 'connected', queueEmpty: false });
    await this.unmuteForNewCall();
  }

  private syntheticLead(phone: string): Lead {
    return {
      id: `unknown:${phone}`,
      listId: '',
      businessName: 'Unknown caller',
      contactName: '',
      phones: [phone],
      email: '',
      city: '',
      state: '',
      notes: '',
      status: 'new',
      assignedTo: null,
      attemptDays: 0,
      lastCalledAt: null,
      lastCalledBy: null,
      nextCallAt: null,
      callbackAt: null,
      callbackOwner: null,
      lockedBy: null,
      lockedAt: null,
      createdAt: this.iso(),
    };
  }

  private async logMissedInbound(p: Pending): Promise<void> {
    await this.safe(
      'logging missed inbound',
      this.api.createCall({
        leadId: p.lead ? p.lead.id : null,
        direction: 'inbound',
        fromNumber: p.from,
        toNumber: p.to,
        ring: 1,
        endedAt: this.iso(),
        result: 'missed_inbound',
        providerCallId: p.callId,
      }),
    );
  }

  private async afterIncomingCleared(): Promise<void> {
    // answerIncoming() from paused sets pauseRequested; the call never connected, so drop it.
    if (this.state.phase === 'paused' && this.state.pauseRequested) this.commit({ pauseRequested: false });
    if (this.state.phase === 'dialing') await this.fill();
  }

  private async unmuteForNewCall(): Promise<void> {
    if (!this.telephonyMuted) return;
    this.telephonyMuted = false;
    await this.safe('unmute', this.telephony.setMuted(false));
  }

  // -------------------------------------------------------------------------
  // Call end, wrap-up, pause, stop, errors
  // -------------------------------------------------------------------------

  /** The active call has ended (either side). Goes to wrap-up (or straight on for unknown callers). */
  private async endActive(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.detach(a.callId);
    const endMs = this.now();
    const talkSeconds = Math.max(0, Math.round((endMs - a.answeredAtMs) / 1000));
    if (a.lineIndex !== null) {
      const slot = this.slots[a.lineIndex];
      if (slot) Object.assign(slot, emptySlot(slot.index));
    }
    const s = this.state.session;
    const session = this.bumpSession({
      talkSeconds: s.talkSeconds + talkSeconds,
      conversations: s.conversations + (talkSeconds >= CONVERSATION_MIN_SECONDS ? 1 : 0),
    });
    if (a.callRecordId) {
      await this.safe('ending call', this.api.updateCall(a.callRecordId, { endedAt: this.iso(endMs), talkSeconds }));
    }
    if (a.synthetic || !a.callRecordId) {
      this.commit({ session });
      await this.afterCallDone();
      return;
    }
    this.wrap = { lead: a.lead, callRecordId: a.callRecordId, talkSeconds };
    this.presence('wrap_up', a.lead.businessName);
    this.commit({ phase: 'wrap_up', session });
  }

  /** After a wrap-up (or a call that needs none): stop, fail, pause or keep dialing. */
  private async afterCallDone(): Promise<void> {
    if (this.stopRequested) {
      await this.finalStop();
      return;
    }
    if (this.fatalAfterWrapUp) {
      const msg = this.fatalAfterWrapUp;
      this.fatalAfterWrapUp = null;
      await this.enterFatal(msg);
      return;
    }
    if (this.state.pauseRequested) {
      await this.enterPaused();
      return;
    }
    this.presence('dialing');
    this.commit({ phase: 'dialing' });
    await this.fill();
  }

  private async enterPaused(): Promise<void> {
    this.clearPoll();
    const ids = await this.hangupLines();
    await this.release(ids);
    this.presence('paused');
    this.commit({ phase: 'paused', pauseRequested: false, queueEmpty: false });
  }

  /** Hang up / release everything this engine holds except the active call and wrap-up. */
  private async cleanupAll(): Promise<void> {
    this.clearPoll();
    const ids = await this.hangupLines();
    for (const s of this.slots) if (s.lead && s.status === 'answered' && !this.active) {
      ids.push(s.lead.id);
      Object.assign(s, emptySlot(s.index));
    }
    const p = this.pending;
    if (p) {
      this.pending = null;
      this.detach(p.callId);
      await this.safe('decline incoming', this.telephony.declineIncoming(p.callId));
      await this.logMissedInbound(p);
    }
    await this.release(ids);
  }

  private async finalStop(): Promise<void> {
    await this.cleanupAll();
    if (this.wrap) {
      await this.release([this.wrap.lead.id]);
      this.wrap = null;
    }
    await this.safe('disconnect', this.telephony.disconnect());
    this.resetInternals();
    this.presence('idle');
    this.commit({ phase: 'idle', pauseRequested: false, queueEmpty: false, error: null });
  }

  /**
   * Fatal problem: hang up, release locks, phase `error`. During a conversation the call is ended
   * and the wrap-up is kept so the outcome is not lost; the error applies once it is submitted.
   */
  private async enterFatal(message: string): Promise<void> {
    if (this.active || this.wrap) {
      this.fatalAfterWrapUp = message;
      const ids = await this.hangupLines();
      await this.release(ids);
      this.commit({ error: message });
      if (this.active) {
        const a = this.active;
        this.detach(a.callId);
        await this.hangupQuietly(a.callId);
        await this.endActive();
      }
      return;
    }
    await this.cleanupAll();
    await this.safe('disconnect', this.telephony.disconnect());
    this.resetInternals();
    this.presence('idle');
    this.commit({ phase: 'error', error: message, pauseRequested: false, queueEmpty: false });
  }
}
