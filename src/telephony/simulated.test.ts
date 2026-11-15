import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_SPEED_STORAGE_KEY, SimulatedTelephony } from './simulated';
import type { DialRequest, TelephonyEvent } from './Telephony';

const REQ: DialRequest = { to: '+12145550111', from: '+12145550100', leadId: 'lead_1', ring: 1, ringSeconds: 22, detectMachine: true };

/** Returns the given values in order (then 0.9 = plain no answer / no callback). */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.9);
}

async function connected(random: () => number, opts: { speed?: number } = {}) {
  const tel = new SimulatedTelephony({ random, ...opts });
  const events: (TelephonyEvent & { at: number })[] = [];
  const t0 = Date.now();
  tel.on((e) => events.push({ ...e, at: Date.now() - t0 }));
  const p = tel.connect();
  await vi.advanceTimersByTimeAsync(300 / (opts.speed ?? 1));
  await p;
  return { tel, events, t0 };
}

const types = (events: TelephonyEvent[], callId?: string) => events.filter((e) => !callId || ('callId' in e && e.callId === callId)).map((e) => e.type);
const endedCount = (events: TelephonyEvent[], callId: string) => events.filter((e) => e.type === 'ended' && e.callId === callId).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 11, 14, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('simulated telephony', () => {
  it('connect resolves after ~300 ms and dial requires a connection', async () => {
    const tel = new SimulatedTelephony({ random: seq() });
    await expect(tel.dial(REQ)).rejects.toThrow();
    let done = false;
    void tel.connect().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(tel.connected).toBe(true);
  });

  it('human answers within 3-14 s, then hangs up after 25-150 s', async () => {
    // outcome 0.05 -> human; answer at 3 + 0.5*11 = 8.5 s; talk 25 + 0*125 = 25 s.
    const { tel, events } = await connected(seq(0.05, 0.5, 0));
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(300);
    expect(types(events, id)).toEqual(['ringing']);
    await vi.advanceTimersByTimeAsync(8_200);
    expect(types(events, id)).toEqual(['ringing', 'answered']);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(events.find((e) => e.type === 'ended')).toMatchObject({ callId: id, reason: 'hangup_remote' });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(endedCount(events, id)).toBe(1);
  });

  it('second ring to the same number is more likely to be answered', async () => {
    const first = await connected(seq(0.15, 0.5, 0));
    const id1 = await first.tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(types(first.events, id1)).not.toContain('answered');

    const second = await connected(seq(0.15, 0.5, 0));
    const id2 = await second.tel.dial({ ...REQ, ring: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(types(second.events, id2)).toContain('answered');

    // Re-dial of the same number within a minute counts too, even as ring 1.
    const third = await connected(seq(0.9, 0.9, 0.15, 0.5, 0));
    const a = await third.tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(types(third.events, a)).toContain('ended');
    const b = await third.tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(types(third.events, b)).toContain('answered');
  });

  it('voicemail answers at 15-25 s and is detected 1.2-2.5 s later', async () => {
    // 0.2 -> voicemail; answer at 15 s; machine after 1.2 s.
    const { tel, events } = await connected(seq(0.2, 0, 0));
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(types(events, id)).toEqual(['ringing', 'answered']);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(types(events, id)).toEqual(['ringing', 'answered', 'machine']);
    await tel.hangup(id);
    expect(events[events.length - 1]).toMatchObject({ type: 'ended', reason: 'hangup_local' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(endedCount(events, id)).toBe(1);
  });

  it('voicemail without detection stays up ~20 s then hangs up', async () => {
    const { tel, events } = await connected(seq(0.2, 0));
    const id = await tel.dial({ ...REQ, detectMachine: false });
    await vi.advanceTimersByTimeAsync(15_000 + 19_000);
    expect(types(events, id)).toEqual(['ringing', 'answered']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(types(events, id)).toEqual(['ringing', 'answered', 'ended']);
    expect(events[events.length - 1]).toMatchObject({ reason: 'hangup_remote' });
  });

  it('voicemail later than ringSeconds is just no answer', async () => {
    // answer would be at 15 + 0.99*10 = 24.9 s > 22 s.
    const { tel, events } = await connected(seq(0.2, 0.99));
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(types(events, id)).toEqual(['ringing', 'ended']);
    expect(events[events.length - 1]).toMatchObject({ reason: 'no_answer' });
  });

  it.each([
    [0.33, 'busy', 1_500],
    [0.355, 'bad_number', 1_000],
    [0.375, 'failed', 2_000],
    [0.9, 'no_answer', 22_000],
  ] as const)('outcome %s -> %s at %i ms', async (r, reason, atMs) => {
    const { tel, events } = await connected(seq(r));
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(atMs - 1);
    expect(types(events, id)).not.toContain('ended');
    await vi.advanceTimersByTimeAsync(1);
    expect(events.filter((e) => e.type === 'ended')).toEqual([expect.objectContaining({ callId: id, reason })]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(endedCount(events, id)).toBe(1);
  });

  it('hangup while ringing ends the call exactly once', async () => {
    const { tel, events } = await connected(seq(0.05, 0.5, 0));
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(1_000);
    await tel.hangup(id);
    await tel.hangup(id);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(types(events, id)).toEqual(['ringing', 'ended']);
    expect(events[events.length - 1]).toMatchObject({ reason: 'hangup_local' });
  });

  it('after a no-answer the number may call back as an incoming call', async () => {
    // no answer; callback draw 0.01 (< 4%); delay 30 + 0*90 = 30 s; then talk 25 + 0 s.
    const { tel, events } = await connected(seq(0.9, 0.01, 0, 0));
    const out = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(types(events, out)).toContain('ended');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(events.some((e) => e.type === 'incoming')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const incoming = events.find((e) => e.type === 'incoming');
    expect(incoming).toMatchObject({ from: REQ.to, to: REQ.from });
    const inId = (incoming as { callId: string }).callId;
    await tel.answerIncoming(inId);
    expect(types(events, inId)).toEqual(['incoming', 'answered']);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(types(events, inId)).toEqual(['incoming', 'answered', 'ended']);
  });

  it('an unanswered incoming call rings ~20 s then ends; decline ends it at once', async () => {
    const { tel, events } = await connected(seq(0.9, 0.01, 0, 0.9, 0.01, 0));
    await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(22_000 + 30_000);
    const first = events.filter((e) => e.type === 'incoming')[0] as { callId: string };
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events.filter((e) => e.type === 'ended' && e.callId === first.callId)).toEqual([expect.objectContaining({ reason: 'hangup_remote' })]);

    await tel.dial({ ...REQ, to: '+12145550122' });
    await vi.advanceTimersByTimeAsync(22_000 + 30_000);
    const second = events.filter((e) => e.type === 'incoming')[1] as { callId: string };
    await tel.declineIncoming(second.callId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.filter((e) => e.type === 'ended' && e.callId === second.callId)).toEqual([expect.objectContaining({ reason: 'hangup_local' })]);
  });

  it('no call-back is delivered after disconnect', async () => {
    const { tel, events } = await connected(seq(0.9, 0.01, 0));
    await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(22_000);
    await tel.disconnect();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(events.some((e) => e.type === 'incoming')).toBe(false);
  });

  it('disconnect ends every live call once', async () => {
    const { tel, events } = await connected(seq(0.05, 0.1, 0.5, 0.9));
    const a = await tel.dial(REQ);
    const b = await tel.dial({ ...REQ, to: '+12145550122' });
    await vi.advanceTimersByTimeAsync(5_000);
    await tel.disconnect();
    expect(tel.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(endedCount(events, a)).toBe(1);
    expect(endedCount(events, b)).toBe(1);
  });

  it('speed option makes everything faster', async () => {
    const { tel, events } = await connected(seq(0.9), { speed: 4 });
    const id = await tel.dial(REQ);
    await vi.advanceTimersByTimeAsync(5_499);
    expect(types(events, id)).not.toContain('ended');
    await vi.advanceTimersByTimeAsync(1);
    expect(types(events, id)).toContain('ended');
  });

  it('reads the speed from localStorage when available', async () => {
    const store = new Map<string, string>([[SIM_SPEED_STORAGE_KEY, '2']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} });
    const tel = new SimulatedTelephony({ random: seq(0.9) });
    expect(tel.speed).toBe(2);
    store.set(SIM_SPEED_STORAGE_KEY, 'nonsense');
    expect(tel.speed).toBe(1);
    expect(new SimulatedTelephony({ speed: 3 }).speed).toBe(3);
  });

  it('works without localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(new SimulatedTelephony().speed).toBe(1);
  });
});
