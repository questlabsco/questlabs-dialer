import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoApi } from '../api/demoApi';
import type { DialRequest, Telephony, TelephonyEvent, TelephonyListener } from '../telephony/Telephony';
import type { CallRecord, Lead, NewLead, Settings } from '../types';
import { SimulatedTelephony } from '../telephony/simulated';
import { DialerEngine, NO_CAPACITY_MESSAGE, QUEUE_POLL_MS, RING_GRACE_MS } from './engine';

// Wednesday 2026-11-11 14:00 local.
const NOW = new Date(2026, 10, 11, 14, 0, 0).getTime();

/** Scripted telephony: dials are recorded, tests push events with emit(). */
class FakeTelephony implements Telephony {
  readonly kind = 'simulated' as const;
  connected = false;
  failConnect: Error | null = null;
  dials: (DialRequest & { callId: string })[] = [];
  hangups: string[] = [];
  declined: string[] = [];
  answeredIncoming: string[] = [];
  muted = false;
  digits: string[] = [];
  private live = new Set<string>();
  private seq = 0;
  private listeners = new Set<TelephonyListener>();

  emit(e: TelephonyEvent): void {
    if (e.type === 'ended') this.live.delete(e.callId);
    for (const l of [...this.listeners]) l(e);
  }
  /** Simulates an inbound call. Returns its id. */
  incoming(from: string, to = '+12145550100'): string {
    const id = `in${++this.seq}`;
    this.live.add(id);
    this.emit({ type: 'incoming', callId: id, from, to });
    return id;
  }
  lastDial(): DialRequest & { callId: string } {
    return this.dials[this.dials.length - 1];
  }
  isLive(id: string): boolean {
    return this.live.has(id);
  }

  async connect(): Promise<void> {
    if (this.failConnect) throw this.failConnect;
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    for (const id of [...this.live]) await this.hangup(id);
    this.connected = false;
  }
  async dial(req: DialRequest): Promise<string> {
    if (!this.connected) throw new Error('not connected');
    const callId = `c${++this.seq}`;
    this.live.add(callId);
    this.dials.push({ ...req, callId });
    return callId;
  }
  async hangup(callId: string): Promise<void> {
    this.hangups.push(callId);
    if (this.live.has(callId)) this.emit({ type: 'ended', callId, reason: 'hangup_local' });
  }
  async sendDigits(_callId: string, digits: string): Promise<void> {
    this.digits.push(digits);
  }
  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
  }
  async answerIncoming(callId: string): Promise<void> {
    this.answeredIncoming.push(callId);
    this.emit({ type: 'answered', callId });
  }
  async declineIncoming(callId: string): Promise<void> {
    this.declined.push(callId);
    if (this.live.has(callId)) this.emit({ type: 'ended', callId, reason: 'hangup_local' });
  }
  on(listener: TelephonyListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function leadRows(n: number, opts: { prefix?: string; ext?: number; phones?: number } = {}): NewLead[] {
  const { prefix = 'Biz', ext = 100, phones = 1 } = opts;
  return Array.from({ length: n }, (_, i) => ({
    businessName: `${prefix} ${i}`,
    contactName: `Owner ${i}`,
    phones: Array.from({ length: phones }, (_, p) => `+1214555${String(ext + i * 10 + p).padStart(4, '0')}`),
    email: `o${i}@example.com`,
  }));
}

async function setup(opts: { leads?: NewLead[]; settings?: Partial<Settings>; noNumbers?: boolean } = {}) {
  const api = new DemoApi({ storage: null, now: () => Date.now(), simulatePresence: false, empty: true });
  await api.signInDemo('admin');
  if (opts.settings) await api.saveSettings(opts.settings);
  if (opts.leads?.length) await api.importLeads({ newListName: 'Test', rows: opts.leads, assign: { mode: 'pool' } });
  if (opts.noNumbers) for (const n of await api.listNumbers()) await api.updateNumber(n.id, { active: false });
  const me = await api.signInDemo('caller');
  const tel = new FakeTelephony();
  const engine = new DialerEngine({ api, telephony: tel });
  const settle = () => engine.settled();
  const lead = (businessName: string): Lead => api.debugState().leads.find((l) => l.businessName === businessName)!;
  const leadById = (id: string): Lead => api.debugState().leads.find((l) => l.id === id)!;
  const callFor = (callId: string): CallRecord => api.debugState().calls.find((c) => c.providerCallId === callId)!;
  const emit = async (e: TelephonyEvent) => {
    tel.emit(e);
    await settle();
  };
  return { api, me, tel, engine, settle, lead, leadById, callFor, emit };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dialer engine: starting', () => {
  it('connects, sets lines and rings two leads at once', async () => {
    const t = await setup({ leads: leadRows(3) });
    await t.engine.start();
    await t.settle();
    const s = t.engine.getState();
    expect(s.phase).toBe('dialing');
    expect(s.lines).toHaveLength(2);
    expect(s.lines.map((l) => l.status)).toEqual(['ringing', 'ringing']);
    expect(t.tel.dials.map((d) => d.ring)).toEqual([1, 1]);
    expect(t.tel.dials[0].detectMachine).toBe(true);
    expect(t.tel.dials[0].ringSeconds).toBe(22);
    expect(s.session.dials).toBe(2);
    expect(t.lead('Biz 0').lockedBy).toBe(t.me.id);
    expect(t.lead('Biz 1').lockedBy).toBe(t.me.id);
    expect(t.lead('Biz 2').lockedBy).toBeNull();
    const rec = t.callFor(t.tel.dials[0].callId);
    expect(rec).toMatchObject({ direction: 'outbound', ring: 1, result: null, leadId: t.lead('Biz 0').id });
  });

  it('goes to error when telephony cannot connect', async () => {
    const t = await setup({ leads: leadRows(2) });
    t.tel.failConnect = new Error('Microphone access was denied');
    await t.engine.start();
    const s = t.engine.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toContain('Microphone access was denied');
    expect(t.tel.dials).toHaveLength(0);
    expect(t.lead('Biz 0').lockedBy).toBeNull();
  });

  it('goes to error and releases leads when no outbound number has capacity', async () => {
    const t = await setup({ leads: leadRows(2), noNumbers: true });
    await t.engine.start();
    await t.settle();
    const s = t.engine.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toBe(NO_CAPACITY_MESSAGE);
    expect(s.lines).toEqual([]);
    expect(t.tel.dials).toHaveLength(0);
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null)).toBe(true);
    expect(t.tel.connected).toBe(false);
  });

  it('reports an empty queue, polls, and starts dialing when leads appear', async () => {
    const t = await setup();
    await t.engine.start();
    await t.settle();
    expect(t.engine.getState().queueEmpty).toBe(true);
    expect(t.engine.getState().phase).toBe('dialing');

    await t.api.signInDemo('admin');
    await t.api.importLeads({ newListName: 'Late', rows: leadRows(1, { prefix: 'Late' }), assign: { mode: 'pool' } });
    await t.api.signInDemo('caller');
    expect(t.tel.dials).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(QUEUE_POLL_MS);
    await t.settle();
    expect(t.tel.dials).toHaveLength(1);
    expect(t.engine.getState().queueEmpty).toBe(false);
  });
});

describe('dialer engine: rings without pickup', () => {
  it('double-rings from the same number, then counts a missed day', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    const first = t.tel.dials[0];
    await t.emit({ type: 'ended', callId: first.callId, reason: 'no_answer' });
    expect(t.tel.dials).toHaveLength(2);
    const second = t.tel.dials[1];
    expect(second).toMatchObject({ to: first.to, from: first.from, ring: 2 });
    expect(t.callFor(first.callId).result).toBe('no_answer');
    expect(t.engine.getState().lines[0]).toMatchObject({ status: 'ringing', ring: 2, fromNumber: first.from });

    await t.emit({ type: 'ended', callId: second.callId, reason: 'no_answer' });
    const lead = t.lead('Biz 0');
    expect(lead).toMatchObject({ status: 'no_answer', attemptDays: 1, lockedBy: null });
    expect(t.callFor(second.callId)).toMatchObject({ result: 'no_answer', ring: 2 });
    expect(t.engine.getState().queueEmpty).toBe(true);
    expect(t.tel.dials).toHaveLength(2);
  });

  it('works through every phone in order before the missed day', async () => {
    const t = await setup({ leads: leadRows(1, { phones: 3 }) });
    await t.engine.start();
    await t.settle();
    const reasons = ['no_answer', 'busy', 'no_answer', 'failed', 'no_answer', 'no_answer'] as const;
    for (const reason of reasons) {
      await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason });
    }
    const phones = t.lead('Biz 0').phones;
    expect(t.tel.dials.map((d) => [d.to, d.ring])).toEqual([
      [phones[0], 1],
      [phones[0], 2],
      [phones[1], 1],
      [phones[1], 2],
      [phones[2], 1],
      [phones[2], 2],
    ]);
    expect(t.lead('Biz 0')).toMatchObject({ status: 'no_answer', attemptDays: 1, lockedBy: null });
    expect(t.callFor(t.tel.dials[1].callId).result).toBe('busy');
  });

  it('without doubleRing moves straight to the next phone', async () => {
    const t = await setup({ leads: leadRows(1, { phones: 2 }), settings: { doubleRing: false } });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason: 'no_answer' });
    expect(t.tel.lastDial()).toMatchObject({ to: t.lead('Biz 0').phones[1], ring: 1 });
    await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason: 'no_answer' });
    expect(t.lead('Biz 0').attemptDays).toBe(1);
  });

  it('bad_number: no second ring, next phone, phone removed from the lead', async () => {
    const t = await setup({ leads: leadRows(1, { phones: 2 }) });
    const [badPhone, goodPhone] = t.lead('Biz 0').phones;
    await t.engine.start();
    await t.settle();
    const first = t.tel.dials[0];
    await t.emit({ type: 'ended', callId: first.callId, reason: 'bad_number' });
    expect(t.callFor(first.callId).result).toBe('bad_number');
    expect(t.tel.lastDial()).toMatchObject({ to: goodPhone, ring: 1 });
    expect(t.lead('Biz 0').phones).toEqual([goodPhone]);
    expect(t.lead('Biz 0').phones).not.toContain(badPhone);
    await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason: 'no_answer' });
    await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason: 'no_answer' });
    expect(t.lead('Biz 0')).toMatchObject({ status: 'no_answer', attemptDays: 1 });
  });

  it('bad_number on the only phone marks the lead bad without a missed day', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'ended', callId: t.tel.dials[0].callId, reason: 'bad_number' });
    expect(t.tel.dials).toHaveLength(1);
    expect(t.lead('Biz 0')).toMatchObject({ status: 'bad_number', attemptDays: 0, lockedBy: null });
  });

  it('enforces its own ring timeout', async () => {
    const t = await setup({ leads: leadRows(1), settings: { ringSeconds: 20 } });
    await t.engine.start();
    await t.settle();
    const first = t.tel.dials[0];
    await vi.advanceTimersByTimeAsync(20_000 + RING_GRACE_MS - 1);
    expect(t.tel.hangups).not.toContain(first.callId);
    await vi.advanceTimersByTimeAsync(1);
    await t.settle();
    expect(t.tel.hangups).toContain(first.callId);
    expect(t.callFor(first.callId).result).toBe('no_answer');
    expect(t.tel.lastDial()).toMatchObject({ ring: 2, from: first.from });
    expect(t.tel.dials).toHaveLength(2);
  });
});

describe('dialer engine: pickups', () => {
  it('first pickup wins; the other line is dropped and its lead released with no missed day', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    const [a, b] = t.tel.dials;
    await t.emit({ type: 'answered', callId: a.callId });
    const s = t.engine.getState();
    expect(s.phase).toBe('connected');
    expect(s.activeCall).toMatchObject({ callId: a.callId, direction: 'outbound', toNumber: a.to, fromNumber: a.from });
    expect(s.activeCall!.lead.businessName).toBe('Biz 0');
    expect(s.session.pickups).toBe(1);
    expect(s.lines[1].status).toBe('empty');
    expect(t.tel.hangups).toEqual([b.callId]);
    expect(t.callFor(b.callId).result).toBe('dropped');
    expect(t.callFor(a.callId).result).toBe('answered');
    expect(t.callFor(a.callId).answeredAt).not.toBeNull();
    expect(t.lead('Biz 1')).toMatchObject({ lockedBy: null, attemptDays: 0, status: 'new' });
    // The dropped hangup must not cause a second ring.
    expect(t.tel.dials).toHaveLength(2);

    const presence = t.api.debugState().presence[t.me.id];
    expect(presence).toMatchObject({ status: 'on_call', detail: 'Biz 0' });

    // After the call the dropped lead is claimable again.
    await t.engine.hangUp();
    await t.engine.submitDisposition({ disposition: 'not_interested', notes: '' });
    await t.settle();
    expect(t.tel.dials.slice(2).map((d) => d.to)).toContain(b.to);
  });

  it('second pickup race: hung up as dropped_pickup and released', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    const [a, b] = t.tel.dials;
    // Both answer before the engine processes either event.
    t.tel.emit({ type: 'answered', callId: a.callId });
    t.tel.emit({ type: 'answered', callId: b.callId });
    await t.settle();
    const s = t.engine.getState();
    expect(s.activeCall?.callId).toBe(a.callId);
    expect(t.callFor(b.callId).result).toBe('dropped_pickup');
    expect(t.callFor(b.callId).answeredAt).not.toBeNull();
    expect(t.lead('Biz 1').lockedBy).toBeNull();
    expect(s.session.pickups).toBe(1);
  });

  it('voicemail on the active call is skipped: second ring, no wrap-up, pickup undone', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    const a = t.tel.dials[0];
    await t.emit({ type: 'answered', callId: a.callId });
    expect(t.engine.getState().phase).toBe('connected');
    await t.emit({ type: 'machine', callId: a.callId });
    const s = t.engine.getState();
    expect(s.phase).toBe('dialing');
    expect(s.wrapUp).toBeNull();
    expect(s.activeCall).toBeNull();
    expect(s.session.pickups).toBe(0);
    expect(t.callFor(a.callId)).toMatchObject({ result: 'voicemail', talkSeconds: 0 });
    expect(t.tel.lastDial()).toMatchObject({ to: a.to, from: a.from, ring: 2 });
    // Voicemail on ring 2 -> missed day.
    const b = t.tel.lastDial();
    await t.emit({ type: 'answered', callId: b.callId });
    await t.emit({ type: 'machine', callId: b.callId });
    expect(t.lead('Biz 0')).toMatchObject({ attemptDays: 1, status: 'no_answer', lockedBy: null });
  });

  it('ignores machine detection when skipVoicemail is off', async () => {
    const t = await setup({ leads: leadRows(1), settings: { skipVoicemail: false } });
    await t.engine.start();
    await t.settle();
    expect(t.tel.dials[0].detectMachine).toBe(false);
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.emit({ type: 'machine', callId: t.tel.dials[0].callId });
    expect(t.engine.getState().phase).toBe('connected');
  });

  it('active call -> wrap-up -> disposition -> dialing resumes', async () => {
    const t = await setup({ leads: leadRows(3) });
    await t.engine.start();
    await t.settle();
    const a = t.tel.dials[0];
    await t.emit({ type: 'answered', callId: a.callId });
    await vi.advanceTimersByTimeAsync(45_000);
    await t.emit({ type: 'ended', callId: a.callId, reason: 'hangup_remote' });
    let s = t.engine.getState();
    expect(s.phase).toBe('wrap_up');
    expect(s.wrapUp).toMatchObject({ talkSeconds: 45, callRecordId: t.callFor(a.callId).id });
    expect(s.wrapUp!.lead.businessName).toBe('Biz 0');
    expect(s.session).toMatchObject({ talkSeconds: 45, conversations: 1 });
    expect(t.callFor(a.callId)).toMatchObject({ talkSeconds: 45 });
    expect(t.callFor(a.callId).endedAt).not.toBeNull();
    expect(t.api.debugState().presence[t.me.id].status).toBe('wrap_up');
    const dialsBefore = t.tel.dials.length;

    await t.engine.submitDisposition({ disposition: 'booked', notes: 'Tuesday demo' });
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('dialing');
    expect(s.wrapUp).toBeNull();
    expect(s.session.bookings).toBe(1);
    expect(t.lead('Biz 0')).toMatchObject({ status: 'booked', lockedBy: null });
    expect(t.callFor(a.callId)).toMatchObject({ disposition: 'booked', notes: 'Tuesday demo' });
    expect(t.tel.dials.length).toBe(dialsBefore + 2);
    expect(s.lines.every((l) => l.status === 'ringing')).toBe(true);
  });

  it('short calls are not conversations', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await vi.advanceTimersByTimeAsync(5_000);
    await t.engine.hangUp();
    expect(t.engine.getState().session).toMatchObject({ conversations: 0, talkSeconds: 5 });
    expect(t.engine.getState().phase).toBe('wrap_up');
  });

  it('callback disposition schedules the callback for me', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.hangUp();
    const at = new Date(NOW + 2 * 86_400_000).toISOString();
    await t.engine.submitDisposition({ disposition: 'callback', notes: 'call Friday', callbackAt: at });
    expect(t.lead('Biz 0')).toMatchObject({ status: 'callback', callbackAt: at, callbackOwner: t.me.id, lockedBy: null });
    expect(t.engine.getState().phase).toBe('dialing');
  });

  it('keeps the wrap-up open when saving fails', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.hangUp();
    await expect(t.engine.submitDisposition({ disposition: 'callback', notes: 'keep me' })).rejects.toBeTruthy();
    const s = t.engine.getState();
    expect(s.phase).toBe('wrap_up');
    expect(s.wrapUp).not.toBeNull();
    expect(s.error).toBeTruthy();
  });

  it('mute and digits pass through to the active call', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.toggleMute();
    expect(t.tel.muted).toBe(true);
    expect(t.engine.getState().activeCall!.muted).toBe(true);
    await t.engine.sendDigits('1#');
    expect(t.tel.digits).toEqual(['1#']);
    await t.engine.toggleMute();
    expect(t.engine.getState().activeCall!.muted).toBe(false);
  });
});

describe('dialer engine: pause / resume / stop', () => {
  it('pause hangs up ringing lines and releases every lock; resume re-dials', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    const [a, b] = t.tel.dials;
    await t.engine.pause();
    await t.settle();
    let s = t.engine.getState();
    expect(s.phase).toBe('paused');
    expect(s.lines.every((l) => l.status === 'empty')).toBe(true);
    expect(t.callFor(a.callId).result).toBe('dropped');
    expect(t.callFor(b.callId).result).toBe('dropped');
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null && l.attemptDays === 0)).toBe(true);
    expect(t.tel.dials).toHaveLength(2);
    expect(t.api.debugState().presence[t.me.id].status).toBe('paused');

    await t.engine.resume();
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('dialing');
    expect(t.tel.dials).toHaveLength(4);
  });

  it('pause during a call waits for the wrap-up; pressing again clears it', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.pause();
    expect(t.engine.getState().pauseRequested).toBe(true);
    await t.engine.pause();
    expect(t.engine.getState().pauseRequested).toBe(false);
    await t.engine.pause();
    await t.engine.hangUp();
    await t.engine.submitDisposition({ disposition: 'not_interested', notes: '' });
    await t.settle();
    const s = t.engine.getState();
    expect(s.phase).toBe('paused');
    expect(s.pauseRequested).toBe(false);
    expect(t.tel.dials).toHaveLength(2);
  });

  it('stop releases everything and disconnects', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.engine.stop();
    await t.settle();
    const s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.lines).toEqual([]);
    expect(t.tel.connected).toBe(false);
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null && l.attemptDays === 0)).toBe(true);
    expect(t.api.debugState().presence[t.me.id].status).toBe('idle');
    // No timers left behind.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.tel.dials).toHaveLength(2);
  });

  it('stop during a call goes through wrap-up first, then idle', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    const a = t.tel.dials[0];
    await t.emit({ type: 'answered', callId: a.callId });
    await t.engine.stop();
    expect(t.tel.hangups).toContain(a.callId);
    expect(t.engine.getState().phase).toBe('wrap_up');
    await t.engine.submitDisposition({ disposition: 'do_not_call', notes: 'angry' });
    await t.settle();
    expect(t.engine.getState().phase).toBe('idle');
    expect(t.lead('Biz 0').status).toBe('do_not_call');
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null)).toBe(true);
    expect(t.tel.connected).toBe(false);
  });

  it('dispose releases locks even mid wrap-up', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.hangUp();
    await t.engine.dispose();
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null)).toBe(true);
    expect(t.tel.connected).toBe(false);
    await t.engine.start();
    expect(t.tel.dials).toHaveLength(2);
  });

  it('a telephony error hangs up, releases locks and shows the message', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'error', message: 'Lost connection to the phone service.' });
    const s = t.engine.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toBe('Lost connection to the phone service.');
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null)).toBe(true);
    // Can start again.
    await t.engine.start();
    await t.settle();
    expect(t.engine.getState().phase).toBe('dialing');
  });
});

describe('dialer engine + simulated telephony (soak)', () => {
  it('runs a long random session without leaking locks or leaving calls open', async () => {
    const api = new DemoApi({ storage: null, now: () => Date.now(), simulatePresence: false, empty: true });
    await api.signInDemo('admin');
    await api.importLeads({ newListName: 'Soak', rows: leadRows(40, { phones: 2 }), assign: { mode: 'pool' } });
    const me = await api.signInDemo('caller');
    let x = 12345;
    const random = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const tel = new SimulatedTelephony({ random, speed: 1 });
    const engine = new DialerEngine({ api, telephony: tel });
    const phases = new Set<string>();
    engine.subscribe((s) => phases.add(s.phase));
    const started = engine.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    for (let i = 0; i < 1_800; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      const s = engine.getState();
      if (s.incoming && i % 2 === 0) await engine.answerIncoming();
      if (s.phase === 'connected' && s.activeCall && Date.now() - Date.parse(s.activeCall.answeredAt) > 40_000) await engine.hangUp();
      if (engine.getState().phase === 'wrap_up') await engine.submitDisposition({ disposition: i % 3 === 0 ? 'booked' : 'not_interested', notes: '' });
      // Never more than one line answered at a time.
      const st = engine.getState();
      expect(st.lines.filter((l) => l.status === 'answered').length).toBeLessThanOrEqual(1);
    }
    await engine.stop();
    if (engine.getState().phase === 'wrap_up') await engine.submitDisposition({ disposition: 'hung_up', notes: '' });
    await engine.settled();
    const state = api.debugState();
    expect(engine.getState().phase).toBe('idle');
    expect(state.leads.filter((l) => l.lockedBy === me.id)).toEqual([]);
    const outbound = state.calls.filter((c) => c.direction === 'outbound');
    expect(outbound.length).toBeGreaterThan(50);
    expect(outbound.every((c) => c.result !== null)).toBe(true);
    expect(phases.has('connected')).toBe(true);
    expect(phases.has('wrap_up')).toBe(true);
  }, 30_000);
});

describe('dialer engine: inbound calls', () => {
  it('answers a known lead calling back: ringing lines dropped, inbound active call, wrap-up', async () => {
    const t = await setup({ leads: leadRows(3) });
    await t.engine.start();
    await t.settle();
    const [a, b] = t.tel.dials;
    const caller = t.lead('Biz 2');
    const inId = t.tel.incoming(caller.phones[0]);
    await t.settle();
    let s = t.engine.getState();
    expect(s.incoming).toMatchObject({ callId: inId, from: caller.phones[0] });
    expect(s.incoming!.lead!.id).toBe(caller.id);

    // While pending, a missed ring does not start a new ring.
    await t.emit({ type: 'ended', callId: a.callId, reason: 'no_answer' });
    expect(t.tel.dials).toHaveLength(2);

    await t.engine.answerIncoming();
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('connected');
    expect(s.activeCall).toMatchObject({ callId: inId, direction: 'inbound' });
    expect(s.activeCall!.lead.id).toBe(caller.id);
    expect(s.incoming).toBeNull();
    expect(t.callFor(b.callId).result).toBe('dropped');
    expect(t.lead('Biz 0').lockedBy).toBeNull();
    expect(t.lead('Biz 0').attemptDays).toBe(0);
    expect(t.lead('Biz 1').lockedBy).toBeNull();
    expect(t.callFor(inId)).toMatchObject({ direction: 'inbound', result: 'answered', leadId: caller.id });

    await t.engine.hangUp();
    expect(t.engine.getState().phase).toBe('wrap_up');
    await t.engine.submitDisposition({ disposition: 'booked', notes: '' });
    await t.settle();
    expect(t.lead('Biz 2').status).toBe('booked');
    expect(t.engine.getState().phase).toBe('dialing');
  });

  it('decline logs missed_inbound and resumes the parked ring', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    const a = t.tel.dials[0];
    const inId = t.tel.incoming('+12145559999');
    await t.settle();
    await t.emit({ type: 'ended', callId: a.callId, reason: 'no_answer' });
    expect(t.tel.dials).toHaveLength(1);
    await t.engine.declineIncoming();
    await t.settle();
    expect(t.tel.declined).toContain(inId);
    expect(t.engine.getState().incoming).toBeNull();
    expect(t.callFor(inId)).toMatchObject({ direction: 'inbound', result: 'missed_inbound', leadId: null });
    expect(t.tel.lastDial()).toMatchObject({ ring: 2, to: a.to, from: a.from });
  });

  it('remote giving up logs missed_inbound', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    const inId = t.tel.incoming('+12145559999');
    await t.settle();
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    expect(t.engine.getState().incoming).toBeNull();
    expect(t.callFor(inId).result).toBe('missed_inbound');
  });

  it('an inbound call during a call is declined and logged', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    const inId = t.tel.incoming(t.lead('Biz 1').phones[0]);
    await t.settle();
    expect(t.tel.declined).toContain(inId);
    expect(t.engine.getState().incoming).toBeNull();
    expect(t.engine.getState().phase).toBe('connected');
    expect(t.callFor(inId)).toMatchObject({ result: 'missed_inbound', leadId: t.lead('Biz 1').id });
  });

  it('unknown inbound caller: synthetic lead, no wrap-up', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    const inId = t.tel.incoming('+19725550199');
    await t.settle();
    expect(t.engine.getState().incoming!.lead).toBeNull();
    await t.engine.answerIncoming();
    await t.settle();
    const s = t.engine.getState();
    expect(s.activeCall!.lead).toMatchObject({ id: 'unknown:+19725550199', businessName: 'Unknown caller', phones: ['+19725550199'] });
    await vi.advanceTimersByTimeAsync(30_000);
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    const after = t.engine.getState();
    expect(after.wrapUp).toBeNull();
    expect(after.phase).toBe('dialing');
    expect(t.callFor(inId)).toMatchObject({ leadId: null, direction: 'inbound', result: 'answered', talkSeconds: 30 });
    // Dialing picked the lead up again.
    expect(after.lines.some((l) => l.status === 'ringing')).toBe(true);
  });

  it('answering from paused returns to paused after the call', async () => {
    const t = await setup({ leads: leadRows(1) });
    await t.engine.start();
    await t.settle();
    await t.engine.pause();
    const inId = t.tel.incoming('+19725550199');
    await t.settle();
    await t.engine.answerIncoming();
    await t.settle();
    expect(t.engine.getState().phase).toBe('connected');
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    expect(t.engine.getState().phase).toBe('paused');
  });
});
