import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoApi } from '../api/demoApi';
import type { DialRequest, Telephony, TelephonyEvent, TelephonyListener } from '../telephony/Telephony';
import type { CallRecord, Lead, NewLead, Settings } from '../types';
import { SimulatedTelephony } from '../telephony/simulated';
import {
  DialerEngine,
  MANUAL_DURING_CALL_MESSAGE,
  MANUAL_DURING_INCOMING_MESSAGE,
  MANUAL_INVALID_NUMBER_MESSAGE,
  MANUAL_WHILE_DIALING_MESSAGE,
  NO_CAPACITY_MESSAGE,
  PERSON_CONFIRM_MS,
  QUEUE_POLL_MS,
  RING_GRACE_MS,
} from './engine';

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
  standbyStarts = 0;
  standbyStops = 0;
  failAnswer: Error | null = null;
  logsMissedInbound = false;
  confirmsPeople = false;
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
  async startStandby(): Promise<void> {
    this.standbyStarts++;
  }
  async stopStandby(): Promise<void> {
    this.standbyStops++;
  }
  async answerIncoming(callId: string): Promise<void> {
    if (this.failAnswer) throw this.failAnswer;
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

async function setup(opts: { leads?: NewLead[]; settings?: Partial<Settings>; noNumbers?: boolean; standby?: boolean } = {}) {
  const api = new DemoApi({ storage: null, now: () => Date.now(), simulatePresence: false, empty: true });
  await api.signInDemo('admin');
  if (opts.settings) await api.saveSettings(opts.settings);
  if (opts.leads?.length) await api.importLeads({ newListName: 'Test', rows: opts.leads, assign: { mode: 'pool' } });
  if (opts.noNumbers) for (const n of await api.listNumbers()) await api.updateNumber(n.id, { active: false });
  const me = await api.signInDemo('caller');
  const tel = new FakeTelephony();
  const engine = new DialerEngine({ api, telephony: tel, standby: opts.standby });
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
  it('keeps the other line available during screening and connects its human pickup', async () => {
    const t=await setup({leads:leadRows(2)});
    await t.engine.start();
    const [screened,human]=t.tel.dials;
    await t.emit({type:'checking',callId:screened.callId});
    await t.emit({type:'screening',callId:screened.callId});
    expect(t.engine.getState().activeCall).toBeNull();
    expect(t.tel.hangups).toEqual([]);
    await t.emit({type:'answered',callId:human.callId});
    expect(t.engine.getState().activeCall?.lead.id).toBe(human.leadId);
  });

  it('counts a terminal voicemail as a miss and retries once', async () => {
    const t=await setup({leads:leadRows(1)});
    await t.engine.start();
    await t.emit({type:'ended',reason:'voicemail',callId:t.tel.lastDial().callId});
    expect(t.tel.lastDial().ring).toBe(2);
    await t.emit({type:'ended',reason:'voicemail',callId:t.tel.lastDial().callId});
    expect(t.tel.dials).toHaveLength(2);
    expect(t.engine.getState().session.pickups).toBe(0);
  });

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

  it('places both lines at the same moment, not one after the other', async () => {
    const t = await setup({ leads: leadRows(2) });
    // Dials that stay unanswered by the phone service until the test lets them through.
    const waiting: (() => void)[] = [];
    const realDial = t.tel.dial.bind(t.tel);
    let asked = 0;
    t.tel.dial = async (req) => {
      asked++;
      await new Promise<void>((r) => waiting.push(r));
      return realDial(req);
    };
    const started = t.engine.start();
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    // The second line was dialed while the first was still being placed.
    expect(asked).toBe(2);
    expect(t.tel.dials).toHaveLength(0);
    for (const go of waiting) go();
    await started;
    await t.settle();
    expect(t.engine.getState().lines.map((l) => l.status)).toEqual(['ringing', 'ringing']);
    expect(t.engine.getState().session.dials).toBe(2);
  });

  it('shows the wrap-up at once on hang up, before the phone service confirms it', async () => {
    const t = await setup({ leads: leadRows(1), settings: { linesPerCaller: 1 } });
    await t.engine.start();
    await t.settle();
    const [a] = t.tel.dials;
    await t.emit({ type: 'answered', callId: a.callId });
    let confirm!: () => void;
    const realHangup = t.tel.hangup.bind(t.tel);
    t.tel.hangup = async (callId) => {
      await new Promise<void>((r) => (confirm = r));
      return realHangup(callId);
    };
    const hanging = t.engine.hangUp();
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
    expect(t.engine.getState().phase).toBe('wrap_up');
    expect(t.tel.hangups).toHaveLength(0);
    confirm();
    await hanging;
    await t.settle();
    expect(t.tel.hangups).toEqual([a.callId]);
    expect(t.engine.getState().phase).toBe('wrap_up');
    expect(t.callFor(a.callId).endedAt).not.toBeNull();
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

  describe('joined at pickup, voicemail check still running', () => {
    const start = async () => {
      const t = await setup({ leads: leadRows(3) });
      t.tel.confirmsPeople = true;
      await t.engine.start();
      await t.settle();
      return t;
    };

    it('keeps the other line ringing until the pickup is confirmed as a person', async () => {
      const t = await start();
      const [a, b] = t.tel.dials;
      await t.emit({ type: 'answered', callId: a.callId });
      expect(t.engine.getState().phase).toBe('connected');
      expect(t.tel.hangups).toEqual([]);
      expect(t.engine.getState().lines[1].status).toBe('ringing');
      await t.emit({ type: 'human', callId: a.callId });
      expect(t.tel.hangups).toEqual([b.callId]);
      expect(t.callFor(b.callId).result).toBe('dropped');
      expect(t.lead('Biz 1').lockedBy).toBeNull();
    });

    it('a voicemail pickup is skipped and the other line simply keeps ringing', async () => {
      const t = await start();
      const [a, b] = t.tel.dials;
      await t.emit({ type: 'answered', callId: a.callId });
      await t.emit({ type: 'machine', callId: a.callId });
      expect(t.engine.getState().phase).toBe('dialing');
      expect(t.tel.hangups).toEqual([a.callId]);
      expect(t.callFor(a.callId).result).toBe('voicemail');
      // Line 2 was never touched and can still connect.
      await t.emit({ type: 'answered', callId: b.callId });
      expect(t.engine.getState().activeCall?.callId).toBe(b.callId);
      // A late timer from the first pickup changes nothing.
      await vi.advanceTimersByTimeAsync(PERSON_CONFIRM_MS);
      await t.settle();
      expect(t.engine.getState().activeCall?.callId).toBe(b.callId);
    });

    it('without a verdict in time, the pickup counts as a person and the other line is dropped', async () => {
      const t = await start();
      const [a, b] = t.tel.dials;
      await t.emit({ type: 'answered', callId: a.callId });
      await vi.advanceTimersByTimeAsync(PERSON_CONFIRM_MS - 1);
      expect(t.tel.hangups).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await t.settle();
      expect(t.tel.hangups).toEqual([b.callId]);
    });

    it('if the call ends before the verdict, the other line is dropped before the wrap-up', async () => {
      const t = await start();
      const [a, b] = t.tel.dials;
      await t.emit({ type: 'answered', callId: a.callId });
      await t.engine.hangUp();
      await t.settle();
      expect(t.engine.getState().phase).toBe('wrap_up');
      expect(t.tel.hangups).toContain(b.callId);
      expect(t.engine.getState().lines.every((l) => l.status !== 'ringing')).toBe(true);
    });

    it('a second pickup while the first is unconfirmed is dropped', async () => {
      const t = await start();
      const [a, b] = t.tel.dials;
      await t.emit({ type: 'answered', callId: a.callId });
      await t.emit({ type: 'answered', callId: b.callId });
      expect(t.engine.getState().activeCall?.callId).toBe(a.callId);
      expect(t.callFor(b.callId).result).toBe('dropped_pickup');
    });
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

describe('dialer engine: manual calls', () => {
  it('unknown number from idle: connects, rings once, answered, we hang up -> no wrap-up, idle, disconnected', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.callNumber('(972) 555-0199');
    let s = t.engine.getState();
    expect(t.tel.connected).toBe(true);
    expect(t.tel.dials).toHaveLength(1);
    const d = t.tel.dials[0];
    expect(d).toMatchObject({ to: '+19725550199', ring: 1, detectMachine: true, record: true, ringSeconds: 22, leadId: 'unknown:+19725550199' });
    expect(s.phase).toBe('dialing');
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ status: 'ringing', manual: true, phone: '+19725550199', fromNumber: d.from, callId: d.callId, ring: 1 });
    expect(s.lines[0].lead!.id).toBe('unknown:+19725550199');
    expect(s.session.dials).toBe(1);
    expect(t.callFor(d.callId)).toMatchObject({ direction: 'outbound', leadId: null, toNumber: '+19725550199', ring: 1, result: null });
    expect(t.api.debugState().presence[t.me.id].status).toBe('dialing');
    // Nothing was claimed from the queue.
    expect(t.api.debugState().leads.every((l) => l.lockedBy === null)).toBe(true);

    await t.emit({ type: 'answered', callId: d.callId });
    s = t.engine.getState();
    expect(s.phase).toBe('connected');
    expect(s.activeCall).toMatchObject({ callId: d.callId, manual: true, direction: 'outbound', toNumber: '+19725550199' });
    expect(s.lines).toEqual([expect.objectContaining({ status: 'answered', manual: true })]);
    expect(t.api.debugState().presence[t.me.id].status).toBe('on_call');

    await vi.advanceTimersByTimeAsync(30_000);
    await t.engine.hangUp();
    await t.settle();
    s = t.engine.getState();
    expect(t.tel.hangups).toContain(d.callId);
    expect(s.phase).toBe('idle');
    expect(s.wrapUp).toBeNull();
    expect(s.activeCall).toBeNull();
    expect(s.lines).toEqual([]);
    expect(t.tel.connected).toBe(false);
    expect(t.api.debugState().presence[t.me.id].status).toBe('idle');
    expect(t.callFor(d.callId)).toMatchObject({ leadId: null, result: 'answered', talkSeconds: 30 });
    expect(t.callFor(d.callId).endedAt).not.toBeNull();
    // No ring timer left behind, nothing else dialed.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.tel.dials).toHaveLength(1);
  });

  it('unknown number hung up by them -> back to idle without wrap-up', async () => {
    const t = await setup();
    await t.engine.callNumber('+1 214 555 0177');
    const d = t.tel.lastDial();
    await t.emit({ type: 'answered', callId: d.callId });
    await vi.advanceTimersByTimeAsync(12_000);
    await t.emit({ type: 'ended', callId: d.callId, reason: 'hangup_remote' });
    const s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.wrapUp).toBeNull();
    expect(t.tel.connected).toBe(false);
    expect(t.callFor(d.callId)).toMatchObject({ result: 'answered', talkSeconds: 12 });
  });

  it('known lead: used without claiming, wrap-up after the call, outcome saved, back to idle', async () => {
    const t = await setup({ leads: leadRows(2) });
    const lead = t.lead('Biz 1');
    await t.engine.callNumber(lead.phones[0].slice(2)); // 10 digits, no +1
    const d = t.tel.lastDial();
    expect(d.leadId).toBe(lead.id);
    expect(t.engine.getState().lines[0].lead!.id).toBe(lead.id);
    expect(t.lead('Biz 1').lockedBy).toBeNull();
    expect(t.callFor(d.callId).leadId).toBe(lead.id);

    await t.emit({ type: 'answered', callId: d.callId });
    expect(t.engine.getState().activeCall!.lead.id).toBe(lead.id);
    await vi.advanceTimersByTimeAsync(40_000);
    await t.emit({ type: 'ended', callId: d.callId, reason: 'hangup_remote' });
    let s = t.engine.getState();
    expect(s.phase).toBe('wrap_up');
    expect(s.wrapUp).toMatchObject({ manual: true, talkSeconds: 40, callRecordId: t.callFor(d.callId).id });
    expect(t.tel.connected).toBe(true);

    await t.engine.submitDisposition({ disposition: 'booked', notes: 'demo Tuesday' });
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.wrapUp).toBeNull();
    expect(t.tel.connected).toBe(false);
    expect(t.lead('Biz 1')).toMatchObject({ status: 'booked', lockedBy: null });
    expect(t.callFor(d.callId)).toMatchObject({ disposition: 'booked', notes: 'demo Tuesday' });
    expect(t.tel.dials).toHaveLength(1);
  });

  it('rings out -> no_answer, no missed day, back to idle', async () => {
    const t = await setup({ leads: leadRows(1), settings: { ringSeconds: 20, recordCalls: false } });
    const lead = t.lead('Biz 0');
    await t.engine.callNumber(lead.phones[0]);
    const d = t.tel.lastDial();
    expect(d).toMatchObject({ ringSeconds: 20, record: false, detectMachine: true });
    await vi.advanceTimersByTimeAsync(20_000 + RING_GRACE_MS);
    await t.settle();
    const s = t.engine.getState();
    expect(t.tel.hangups).toContain(d.callId);
    expect(t.callFor(d.callId).result).toBe('no_answer');
    expect(s.phase).toBe('idle');
    expect(s.manualEnded).toMatchObject({ phone: lead.phones[0], result: 'no_answer' });
    expect(t.tel.connected).toBe(false);
    expect(t.lead('Biz 0')).toMatchObject({ attemptDays: 0, status: 'new', lockedBy: null });
    // No double ring.
    expect(t.tel.dials).toHaveLength(1);
  });

  it('provider ends the ring (bad number / busy): logged, no bad-number report, idle', async () => {
    const t = await setup({ leads: leadRows(1) });
    const lead = t.lead('Biz 0');
    await t.engine.callNumber(lead.phones[0]);
    const d = t.tel.lastDial();
    await t.emit({ type: 'ended', callId: d.callId, reason: 'bad_number' });
    expect(t.callFor(d.callId).result).toBe('bad_number');
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', manualEnded: { result: 'bad_number' } });
    expect(t.lead('Biz 0').phones).toEqual(lead.phones);

    await t.engine.callNumber(lead.phones[0]);
    expect(t.engine.getState().manualEnded).toBeNull();
    await t.emit({ type: 'ended', callId: t.tel.lastDial().callId, reason: 'busy' });
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', manualEnded: { result: 'busy' } });
  });

  it('hang up while ringing cancels it', async () => {
    const t = await setup();
    await t.engine.callNumber('2145550123');
    const d = t.tel.lastDial();
    await t.engine.hangUp();
    await t.settle();
    const s = t.engine.getState();
    expect(t.tel.hangups).toContain(d.callId);
    expect(t.callFor(d.callId).result).toBe('no_answer');
    expect(t.callFor(d.callId).endedAt).not.toBeNull();
    expect(s.phase).toBe('idle');
    expect(s.lines).toEqual([]);
    expect(s.manualEnded).toBeNull();
    expect(t.tel.connected).toBe(false);
    // A late answer for the cancelled call is ignored.
    await t.emit({ type: 'answered', callId: d.callId });
    expect(t.engine.getState().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.tel.dials).toHaveLength(1);
  });

  it('stop while ringing cancels it and goes idle', async () => {
    const t = await setup();
    await t.engine.callNumber('2145550123');
    await t.engine.stop();
    await t.settle();
    expect(t.tel.hangups).toContain(t.tel.lastDial().callId);
    expect(t.engine.getState().phase).toBe('idle');
    expect(t.tel.connected).toBe(false);
  });

  it('rejects invalid numbers without connecting', async () => {
    const t = await setup();
    for (const bad of ['', '555-0123', '123', '(012) 555-0123', '+44 20 7946 0958', 'abc']) {
      await expect(t.engine.callNumber(bad)).rejects.toThrow(MANUAL_INVALID_NUMBER_MESSAGE);
    }
    expect(t.engine.getState().phase).toBe('idle');
    expect(t.tel.connected).toBe(false);
    expect(t.tel.dials).toHaveLength(0);
  });

  it('is rejected while queue dialing and during a call', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await expect(t.engine.callNumber('2145550123')).rejects.toThrow(MANUAL_WHILE_DIALING_MESSAGE);
    expect(t.tel.dials).toHaveLength(2);
    expect(t.engine.getState().phase).toBe('dialing');
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await expect(t.engine.callNumber('2145550123')).rejects.toThrow(MANUAL_DURING_CALL_MESSAGE);
    expect(t.tel.dials).toHaveLength(2);
  });

  it('from paused returns to paused with the session still open', async () => {
    const t = await setup({ leads: leadRows(2) });
    await t.engine.start();
    await t.settle();
    await t.engine.pause();
    await t.settle();
    expect(t.tel.dials).toHaveLength(2);
    await t.engine.callNumber('2145550123');
    let s = t.engine.getState();
    expect(s.phase).toBe('dialing');
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].manual).toBe(true);
    expect(t.tel.dials).toHaveLength(3);
    // Pause / resume do nothing while it rings; the queue is not dialed.
    await t.engine.pause();
    await t.engine.resume();
    await t.settle();
    expect(t.tel.dials).toHaveLength(3);
    const d = t.tel.lastDial();
    await t.emit({ type: 'answered', callId: d.callId });
    await t.emit({ type: 'ended', callId: d.callId, reason: 'hangup_remote' });
    s = t.engine.getState();
    expect(s.phase).toBe('paused');
    expect(s.lines).toHaveLength(2);
    expect(s.lines.every((l) => l.status === 'empty' && !l.manual)).toBe(true);
    expect(t.tel.connected).toBe(true);
    expect(t.api.debugState().presence[t.me.id].status).toBe('paused');
    expect(s.session.dials).toBe(3);
    expect(t.tel.dials).toHaveLength(3);
    // Resume still works afterwards.
    await t.engine.resume();
    await t.settle();
    expect(t.engine.getState().phase).toBe('dialing');
    expect(t.tel.dials).toHaveLength(5);
  });

  it('fails with the no-capacity message and stays idle', async () => {
    const t = await setup({ noNumbers: true });
    await expect(t.engine.callNumber('2145550123')).rejects.toThrow(NO_CAPACITY_MESSAGE);
    expect(t.engine.getState().phase).toBe('idle');
    expect(t.tel.connected).toBe(false);
    expect(t.tel.dials).toHaveLength(0);
  });

  it('declines and logs an incoming call while a manual call rings or is active', async () => {
    const t = await setup();
    await t.engine.callNumber('2145550123');
    const d = t.tel.lastDial();
    const in1 = t.tel.incoming('+19725550111');
    await t.settle();
    expect(t.tel.declined).toContain(in1);
    expect(t.engine.getState().incoming).toBeNull();
    expect(t.callFor(in1)).toMatchObject({ direction: 'inbound', result: 'missed_inbound' });
    await t.emit({ type: 'answered', callId: d.callId });
    const in2 = t.tel.incoming('+19725550112');
    await t.settle();
    expect(t.tel.declined).toContain(in2);
    expect(t.engine.getState().phase).toBe('connected');
    expect(t.callFor(in2).result).toBe('missed_inbound');
  });

  it('a connect failure rejects and leaves the dialer idle', async () => {
    const t = await setup();
    t.tel.failConnect = new Error('Microphone access was denied');
    await expect(t.engine.callNumber('2145550123')).rejects.toThrow('Microphone access was denied');
    expect(t.engine.getState().phase).toBe('idle');
    expect(t.tel.dials).toHaveLength(0);
  });

  it('works on the simulated telephony: every call ends back on idle', async () => {
    const api = new DemoApi({ storage: null, now: () => Date.now(), simulatePresence: false, empty: true });
    await api.signInDemo('caller');
    let x = 777;
    const random = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const tel = new SimulatedTelephony({ random, speed: 1 });
    const engine = new DialerEngine({ api, telephony: tel });
    const phases = new Set<string>();
    engine.subscribe((s) => phases.add(s.phase));
    for (let i = 0; i < 25; i++) {
      const p = engine.callNumber(`214555${1000 + i}`);
      await vi.advanceTimersByTimeAsync(1_000);
      await p;
      for (let sec = 0; sec < 200 && engine.getState().phase !== 'idle'; sec++) await vi.advanceTimersByTimeAsync(1_000);
      expect(engine.getState().phase).toBe('idle');
      expect(tel.connected).toBe(false);
    }
    await engine.settled();
    const outbound = api.debugState().calls.filter((c) => c.direction === 'outbound');
    expect(outbound).toHaveLength(25);
    expect(outbound.every((c) => c.result !== null && c.ring === 1)).toBe(true);
    expect(phases.has('connected')).toBe(true);
    expect(phases.has('wrap_up')).toBe(false);
  }, 30_000);
});

describe('dialer engine: callbacks while not dialing (standby)', () => {
  it('goes on standby when created for a signed-in caller and off it on dispose', async () => {
    const t = await setup({ standby: true });
    const presence = vi.spyOn(t.api, 'setPresence');
    await t.settle();
    expect(t.tel.standbyStarts).toBe(1);
    expect(t.tel.connected).toBe(false);
    await t.engine.dispose();
    expect(t.tel.standbyStops).toBe(1);
    expect(presence).toHaveBeenCalledWith('idle', null);
  });

  it('without standby nothing is started (tests, demo fixtures)', async () => {
    const t = await setup();
    await t.settle();
    await t.engine.dispose();
    expect(t.tel.standbyStarts).toBe(0);
    expect(t.tel.standbyStops).toBe(0);
  });

  it('idle: a known lead calling back rings, is answered, wrap-up, then back to idle', async () => {
    const t = await setup({ leads: leadRows(2), standby: true });
    await t.settle();
    const lead = t.lead('Biz 1');
    const inId = t.tel.incoming(lead.phones[0]);
    await t.settle();
    let s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.incoming).toMatchObject({ callId: inId, from: lead.phones[0] });
    expect(s.incoming!.lead!.id).toBe(lead.id);

    await t.engine.answerIncoming();
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('connected');
    expect(s.activeCall).toMatchObject({ callId: inId, direction: 'inbound' });
    expect(s.activeCall!.lead.id).toBe(lead.id);
    expect(s.lines).toHaveLength(1);
    expect(s.incoming).toBeNull();
    // No dialing session was opened and nothing was dialed.
    expect(t.tel.connected).toBe(false);
    expect(t.tel.dials).toHaveLength(0);
    expect(t.callFor(inId)).toMatchObject({ direction: 'inbound', result: 'answered', leadId: lead.id });

    await vi.advanceTimersByTimeAsync(40_000);
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    expect(t.engine.getState().phase).toBe('wrap_up');
    await t.engine.submitDisposition({ disposition: 'callback', notes: 'Call Tuesday', callbackAt: new Date(NOW + 86_400_000).toISOString() });
    await t.settle();
    s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.lines).toEqual([]);
    expect(t.lead('Biz 1').status).toBe('callback');
    expect(t.tel.dials).toHaveLength(0);
    expect(t.callFor(inId).talkSeconds).toBe(40);
  });

  it('idle: an unknown number is answered with no wrap-up and returns to idle', async () => {
    const t = await setup({ leads: leadRows(1), standby: true });
    await t.settle();
    const inId = t.tel.incoming('+19725550123');
    await t.settle();
    expect(t.engine.getState().incoming!.lead).toBeNull();
    await t.engine.answerIncoming();
    await t.settle();
    expect(t.engine.getState().activeCall!.lead).toMatchObject({ id: 'unknown:+19725550123', businessName: 'Unknown caller' });
    await t.engine.hangUp();
    await t.settle();
    const s = t.engine.getState();
    expect(s.phase).toBe('idle');
    expect(s.wrapUp).toBeNull();
    expect(t.tel.hangups).toContain(inId);
    expect(t.callFor(inId)).toMatchObject({ leadId: null, direction: 'inbound', result: 'answered' });
  });

  it('idle: declining stays idle and logs a missed inbound (when the provider does not)', async () => {
    const t = await setup({ standby: true });
    await t.settle();
    const inId = t.tel.incoming('+19725550124');
    await t.settle();
    await t.engine.declineIncoming();
    await t.settle();
    expect(t.tel.declined).toContain(inId);
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', incoming: null });
    expect(t.callFor(inId)).toMatchObject({ direction: 'inbound', result: 'missed_inbound', leadId: null });
  });

  it('a provider that logs missed calls itself gets no duplicate row from the engine', async () => {
    const t = await setup({ standby: true });
    t.tel.logsMissedInbound = true;
    await t.settle();
    const in1 = t.tel.incoming('+19725550125');
    await t.settle();
    await t.engine.declineIncoming();
    const in2 = t.tel.incoming('+19725550126');
    await t.settle();
    await t.emit({ type: 'ended', callId: in2, reason: 'hangup_remote' });
    expect(t.callFor(in1)).toBeUndefined();
    expect(t.callFor(in2)).toBeUndefined();
  });

  it('idle: the person giving up clears the banner and stays idle', async () => {
    const t = await setup({ standby: true });
    await t.settle();
    const inId = t.tel.incoming('+19725550127');
    await t.settle();
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', incoming: null });
  });

  it('idle: answering fails (e.g. microphone blocked): rejects with the reason, declines, stays idle', async () => {
    const t = await setup({ standby: true });
    await t.settle();
    const inId = t.tel.incoming('+19725550128');
    await t.settle();
    t.tel.failAnswer = new Error('Microphone access was denied.');
    await expect(t.engine.answerIncoming()).rejects.toThrow(/Couldn't answer: Microphone access was denied/);
    await t.settle();
    expect(t.tel.declined).toContain(inId);
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', incoming: null, activeCall: null });
    // A later Start works normally.
    t.tel.failAnswer = null;
  });

  it('idle: Start and Call a number wait until the incoming call is answered or declined', async () => {
    const t = await setup({ leads: leadRows(1), standby: true });
    await t.settle();
    t.tel.incoming('+19725550129');
    await t.settle();
    await expect(t.engine.start()).rejects.toThrow(MANUAL_DURING_INCOMING_MESSAGE);
    await expect(t.engine.callNumber('(972) 555-0100')).rejects.toThrow(MANUAL_DURING_INCOMING_MESSAGE);
    expect(t.engine.getState().phase).toBe('idle');
    await t.engine.declineIncoming();
    await t.engine.start();
    await t.settle();
    expect(t.engine.getState().phase).toBe('dialing');
  });

  it('idle: a telephony error (standby reconnecting) does not put the dialer in error', async () => {
    const t = await setup({ standby: true });
    await t.settle();
    await t.emit({ type: 'error', message: 'Live call updates are reconnecting...' });
    expect(t.engine.getState()).toMatchObject({ phase: 'idle', error: null });
  });

  it('paused: declining keeps the dialer paused', async () => {
    const t = await setup({ leads: leadRows(1), standby: true });
    await t.engine.start();
    await t.settle();
    await t.engine.pause();
    const inId = t.tel.incoming('+19725550130');
    await t.settle();
    expect(t.engine.getState().incoming!.callId).toBe(inId);
    await t.engine.declineIncoming();
    await t.settle();
    expect(t.engine.getState()).toMatchObject({ phase: 'paused', incoming: null, pauseRequested: false });
  });

  it('paused: an answered callback to a known lead wraps up and returns to paused', async () => {
    const t = await setup({ leads: leadRows(2), standby: true });
    await t.engine.start();
    await t.settle();
    await t.engine.pause();
    const lead = t.lead('Biz 1');
    const inId = t.tel.incoming(lead.phones[0]);
    await t.settle();
    await t.engine.answerIncoming();
    await t.settle();
    expect(t.engine.getState().phase).toBe('connected');
    await t.emit({ type: 'ended', callId: inId, reason: 'hangup_remote' });
    expect(t.engine.getState().phase).toBe('wrap_up');
    await t.engine.submitDisposition({ disposition: 'not_interested', notes: '' });
    await t.settle();
    expect(t.engine.getState().phase).toBe('paused');
  });

  it('wrap-up: a callback is declined (offered to someone else) and the wrap-up stays', async () => {
    const t = await setup({ leads: leadRows(2), standby: true });
    await t.engine.start();
    await t.settle();
    await t.emit({ type: 'answered', callId: t.tel.dials[0].callId });
    await t.engine.hangUp();
    expect(t.engine.getState().phase).toBe('wrap_up');
    const inId = t.tel.incoming('+19725550131');
    await t.settle();
    expect(t.tel.declined).toContain(inId);
    expect(t.engine.getState()).toMatchObject({ phase: 'wrap_up', incoming: null });
  });

  it('dispose while a callback rings declines it', async () => {
    const t = await setup({ standby: true });
    await t.settle();
    const inId = t.tel.incoming('+19725550132');
    await t.settle();
    await t.engine.dispose();
    expect(t.tel.declined).toContain(inId);
    expect(t.tel.standbyStops).toBe(1);
  });
});
