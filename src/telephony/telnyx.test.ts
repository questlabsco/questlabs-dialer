import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeClientState, type TelephonyEventRow } from '../../supabase/functions/_shared/telnyxLogic';
import type { TelephonyEvent } from './Telephony';
import { TelnyxTelephony } from './telnyx';
import type { SubscriptionStatus, TelnyxBackend } from './telnyxBackend';
import type { RtcAgentCall, RtcCallbacks, RtcFactory, RtcInboundCall, StartAgentLegOptions } from './telnyxRtc';

class FakeBackend implements TelnyxBackend {
  calls: { fn: string; body: Record<string, unknown> }[] = [];
  onRow: ((r: TelephonyEventRow) => void) | null = null;
  onStatus: ((s: SubscriptionStatus) => void) | null = null;
  subscribeCount = 0;
  stored: TelephonyEventRow[] = [];
  latest = 0;
  dialSeq = 0;
  agentStatus = 'pending';
  failNext: string | null = null;

  async invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    this.calls.push({ fn, body });
    if (this.failNext === fn) {
      this.failNext = null;
      throw new Error(`${fn} failed`);
    }
    if (fn === 'telnyx-agent' && body.action === 'start') return { sessionId: `sess-${this.calls.length}` } as T;
    if (fn === 'telnyx-agent' && body.action === 'status') return { status: this.agentStatus } as T;
    if (fn === 'telnyx-dial') return { callId: `call-${++this.dialSeq}` } as T;
    return { ok: true } as T;
  }
  async userId() {
    return 'me';
  }
  async latestEventId() {
    return this.latest;
  }
  async eventsSince(_c: string, after: number) {
    return this.stored.filter((r) => r.id > after);
  }
  subscribe(_c: string, onRow: (r: TelephonyEventRow) => void, onStatus: (s: SubscriptionStatus) => void) {
    this.subscribeCount++;
    this.onRow = onRow;
    this.onStatus = onStatus;
    return () => {
      this.onRow = null;
    };
  }
  fnCalls(fn: string, action?: string) {
    return this.calls.filter((c) => c.fn === fn && (action === undefined || c.body.action === action));
  }
}

interface FakeInbound extends RtcInboundCall {
  answered: boolean | null;
  hungUp: boolean;
  mutes: boolean[];
  digits: string[];
  end(): void;
}

class FakeRtc {
  token: string | null = null;
  connects = 0;
  disconnects = 0;
  inbound: FakeInbound[] = [];
  /** The server rings this client (a callback offer). */
  ring(offerId: string | null): FakeInbound {
    let ended = false;
    const cbs: (() => void)[] = [];
    const c: FakeInbound = {
      id: `sdk-${this.inbound.length + 1}`,
      offerId,
      answered: null,
      hungUp: false,
      mutes: [],
      digits: [],
      get ended() {
        return ended;
      },
      answer: async (muted) => {
        c.answered = muted;
      },
      setMuted: (m) => c.mutes.push(m),
      dtmf: (d) => c.digits.push(d),
      hangup: async () => {
        c.hungUp = true;
        c.end();
      },
      onEnded: (cb) => {
        if (ended) cb();
        else cbs.push(cb);
      },
      end: () => {
        if (ended) return;
        ended = true;
        for (const cb of cbs.splice(0)) cb();
      },
    };
    this.inbound.push(c);
    this.callbacks!.onIncomingCall!(c);
    return c;
  }
  legs: { opts: StartAgentLegOptions; muted: boolean[]; digits: string[]; hungUp: boolean; resolve: () => void }[] = [];
  callbacks: RtcCallbacks | null = null;
  activateImmediately = true;
  factory: RtcFactory = (cb) => {
    this.callbacks = cb;
    return {
      connect: async (token) => {
        this.token = token;
        this.connects++;
      },
      startAgentLeg: (opts) => {
        let resolve!: () => void;
        const active = new Promise<void>((r) => (resolve = r));
        const leg = { opts, muted: [] as boolean[], digits: [] as string[], hungUp: false, resolve };
        this.legs.push(leg);
        if (this.activateImmediately) resolve();
        const call: RtcAgentCall = {
          active,
          setMuted: (m) => leg.muted.push(m),
          dtmf: (d) => leg.digits.push(d),
          hangup: async () => {
            leg.hungUp = true;
          },
        };
        return call;
      },
      disconnect: async () => {
        this.disconnects++;
      },
    };
  };
}

let seq = 100;
function row(p: Partial<TelephonyEventRow> & Pick<TelephonyEventRow, 'type'>): TelephonyEventRow {
  return {
    id: ++seq,
    caller_id: 'me',
    call_id: null,
    reason: null,
    from_number: null,
    to_number: null,
    message: null,
    created_at: new Date().toISOString(),
    ...p,
  };
}

async function setup(opts: { micDenied?: boolean; activate?: boolean } = {}) {
  let micRequests = 0;
  const backend = new FakeBackend();
  backend.latest = seq;
  const rtc = new FakeRtc();
  rtc.activateImmediately = opts.activate ?? true;
  const events: TelephonyEvent[] = [];
  const t = new TelnyxTelephony({
    getToken: async () => 'jwt-token',
    backend,
    rtc: rtc.factory,
    requestMicrophone: async () => {
      micRequests++;
      if (opts.micDenied) throw new Error('Microphone access was denied.');
    },
  });
  t.on((e) => events.push(e));
  return { t, backend, rtc, events, micRequests: () => micRequests };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TelnyxTelephony.connect', () => {
  it('logs in with the token, opens one agent leg with our session in client_state, and connects', async () => {
    const { t, backend, rtc } = await setup();
    await t.connect();
    expect(t.connected).toBe(true);
    expect(rtc.token).toBe('jwt-token');
    expect(rtc.legs).toHaveLength(1);
    const sid = rtc.legs[0].opts.sessionId;
    expect(decodeClientState(rtc.legs[0].opts.clientState)).toEqual({ v: 1, k: 'agent', sid });
    expect(backend.fnCalls('telnyx-agent', 'start')).toHaveLength(1);
    expect(backend.subscribeCount).toBe(1);
  });

  it('rejects with the microphone message and stays disconnected', async () => {
    const { t, backend } = await setup({ micDenied: true });
    await expect(t.connect()).rejects.toThrow(/Microphone access was denied/);
    expect(t.connected).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  it('accepts a live session reported by the server when the SDK never reports active', async () => {
    const { t, backend } = await setup({ activate: false });
    const p = t.connect();
    backend.agentStatus = 'live';
    await vi.advanceTimersByTimeAsync(1_100);
    await p;
    expect(t.connected).toBe(true);
  });

  it('times out when the agent leg never comes up', async () => {
    const { t, backend } = await setup({ activate: false });
    const p = t.connect();
    const assertion = expect(p).rejects.toThrow(/audio line/);
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    expect(t.connected).toBe(false);
    expect(backend.fnCalls('telnyx-agent', 'stop')).toHaveLength(1);
  });

  it('dial before connect rejects', async () => {
    const { t } = await setup();
    await expect(t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 })).rejects.toThrow();
  });
});

describe('TelnyxTelephony events', () => {
  it('passes dial parameters through and emits de-duplicated events in order', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 2, ringSeconds: 20, detectMachine: true, record: false });
    expect(backend.fnCalls('telnyx-dial')[0].body).toEqual({
      to: '+12145550002',
      from: '+12145550001',
      leadId: 'l1',
      ring: 2,
      ringSeconds: 20,
      detectMachine: true,
      record: false,
    });
    const ringing = row({ type: 'ringing', call_id: id });
    backend.onRow!(ringing);
    backend.onRow!(ringing); // same row delivered twice
    backend.onRow!(row({ type: 'ringing', call_id: id })); // a second ringing row
    backend.onRow!(row({ type: 'answered', call_id: id }));
    backend.onRow!(row({ type: 'machine', call_id: id }));
    backend.onRow!(row({ type: 'ended', call_id: id, reason: 'hangup_remote' }));
    backend.onRow!(row({ type: 'ended', call_id: id, reason: 'failed' }));
    backend.onRow!(row({ type: 'answered', call_id: id }));
    expect(events).toEqual([
      { type: 'ringing', callId: id },
      { type: 'answered', callId: id },
      { type: 'machine', callId: id },
      { type: 'ended', callId: id, reason: 'hangup_remote' },
    ]);
  });

  it('buffers events that arrive before dial() returns the id', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    backend.onRow!(row({ type: 'ringing', call_id: 'call-1' }));
    expect(events).toEqual([]);
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 });
    expect(id).toBe('call-1');
    expect(events).toEqual([]); // delivered asynchronously, after the caller has the id
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: 'ringing', callId: 'call-1' }]);
  });

  it('ignores rows from before this session and back-fills after a resubscribe', async () => {
    const { t, backend, events } = await setup();
    const old = row({ type: 'ended', call_id: 'call-1', reason: 'no_answer' });
    backend.latest = old.id;
    await t.connect();
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 });
    await vi.advanceTimersByTimeAsync(0);
    backend.onRow!(old);
    expect(events).toEqual([]);

    // Subscription lost; an event lands while we are away.
    backend.onStatus!('lost');
    const missed = row({ type: 'answered', call_id: id });
    backend.stored.push(missed);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(backend.subscribeCount).toBe(2);
    backend.onStatus!('subscribed');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([{ type: 'answered', callId: id }]);
    // A late realtime copy of the same row is ignored.
    backend.onRow!(missed);
    expect(events).toHaveLength(1);
  });

  it('forwards server error rows', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    backend.onRow!(row({ type: 'error', message: 'Something broke' }));
    expect(events).toEqual([{ type: 'error', message: 'Something broke' }]);
  });
});

describe('TelnyxTelephony calls', () => {
  it('hangup asks the server and falls back to a local ended if the server event never comes', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 });
    await t.hangup(id);
    expect(backend.fnCalls('telnyx-call', 'hangup')[0].body).toEqual({ action: 'hangup', callId: id });
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(events).toEqual([{ type: 'ended', callId: id, reason: 'hangup_local' }]);
    // The server's own ended arriving later is not emitted twice.
    backend.onRow!(row({ type: 'ended', call_id: id, reason: 'hangup_local' }));
    expect(events).toHaveLength(1);
  });

  it('hangup of an unknown id is a no-op', async () => {
    const { t, backend } = await setup();
    await t.connect();
    await t.hangup('nope');
    expect(backend.fnCalls('telnyx-call')).toHaveLength(0);
  });

  it('watchdog closes a call whose webhooks never arrive', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1, ringSeconds: 20 });
    await vi.advanceTimersByTimeAsync(45_100);
    expect(backend.fnCalls('telnyx-call', 'hangup')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(events).toEqual([{ type: 'ended', callId: id, reason: 'failed' }]);
  });

  it('mute and DTMF go to the agent leg; DTMF only on answered calls', async () => {
    const { t, backend, rtc } = await setup();
    await t.connect();
    await t.setMuted(true);
    expect(rtc.legs[0].muted).toEqual([true]);
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 });
    await t.sendDigits(id, '1');
    expect(rtc.legs[0].digits).toEqual([]);
    backend.onRow!(row({ type: 'answered', call_id: id }));
    await t.sendDigits(id, '12a#');
    expect(rtc.legs[0].digits).toEqual(['12#']);
  });

  it('incoming: emits, answers through the server, and auto-declines when ignored', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    backend.onRow!(row({ type: 'incoming', call_id: 'in-1', from_number: '+12145550009', to_number: '+12145550001' }));
    expect(events).toEqual([{ type: 'incoming', callId: 'in-1', from: '+12145550009', to: '+12145550001' }]);
    await t.answerIncoming('in-1');
    expect(backend.fnCalls('telnyx-call', 'answer')).toHaveLength(1);
    backend.onRow!(row({ type: 'answered', call_id: 'in-1' }));
    expect(events.at(-1)).toEqual({ type: 'answered', callId: 'in-1' });
    // Answered calls are not auto-declined.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(backend.fnCalls('telnyx-call', 'timeout')).toHaveLength(0);

    backend.onRow!(row({ type: 'incoming', call_id: 'in-2', from_number: '+12145550008', to_number: '+12145550001' }));
    await vi.advanceTimersByTimeAsync(20_100);
    // The server moves an unanswered call on itself; the app's own timeout is only a late backstop.
    expect(backend.fnCalls('telnyx-call', 'timeout')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(backend.fnCalls('telnyx-call', 'timeout')[0].body).toEqual({ action: 'timeout', callId: 'in-2' });
  });

  it('declineIncoming asks the server and ends locally if needed', async () => {
    const { t, backend, events } = await setup();
    await t.connect();
    backend.onRow!(row({ type: 'incoming', call_id: 'in-1', from_number: '+12145550009', to_number: '+12145550001' }));
    await t.declineIncoming('in-1');
    expect(backend.fnCalls('telnyx-call', 'decline')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(events.at(-1)).toEqual({ type: 'ended', callId: 'in-1', reason: 'hangup_local' });
  });

  it('reopens the agent leg when it drops', async () => {
    const { t, rtc, events } = await setup();
    await t.connect();
    rtc.legs[0].opts.onEnded('NORMAL_CLEARING');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(rtc.legs).toHaveLength(2);
    expect(t.connected).toBe(true);
    expect(events).toEqual([]);
  });

  it('re-logs in after a fatal SDK error', async () => {
    const { t, rtc } = await setup();
    await t.connect();
    rtc.callbacks!.onFatal('socket closed', 'network');
    await vi.advanceTimersByTimeAsync(0);
    expect(rtc.legs).toHaveLength(2);
    expect(t.connected).toBe(true);
  });

  it('disconnect hangs up open calls, stops the agent session and closes leftovers locally', async () => {
    const { t, backend, rtc, events } = await setup();
    await t.connect();
    const id = await t.dial({ to: '+12145550002', from: '+12145550001', leadId: 'l1', ring: 1 });
    const p = t.disconnect();
    await vi.advanceTimersByTimeAsync(3_200);
    await p;
    expect(backend.fnCalls('telnyx-call', 'hangup')).toHaveLength(1);
    expect(backend.fnCalls('telnyx-agent', 'stop')).toHaveLength(1);
    expect(rtc.legs[0].hungUp).toBe(true);
    expect(events).toEqual([{ type: 'ended', callId: id, reason: 'hangup_local' }]);
    expect(t.connected).toBe(false);
  });
});

const OFFER = '0b6c1f2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const deviceRow = (callId = OFFER) =>
  row({ type: 'incoming', call_id: callId, from_number: '+12145550009', to_number: '+12145550001', message: 'device' });

describe('TelnyxTelephony standby (signed in, not dialing)', () => {
  it('logs in and listens without a microphone or an open call leg', async () => {
    const { t, backend, rtc, micRequests } = await setup();
    await t.startStandby();
    expect(t.connected).toBe(false);
    expect(rtc.token).toBe('jwt-token');
    expect(rtc.legs).toHaveLength(0);
    expect(backend.subscribeCount).toBe(1);
    expect(backend.fnCalls('telnyx-agent')).toHaveLength(0);
    expect(micRequests()).toBe(0);
    expect(t.logsMissedInbound).toBe(true);
  });

  it('answers a callback that rings this device: microphone, SDK answer, no server answer', async () => {
    const { t, backend, rtc, events, micRequests } = await setup();
    await t.startStandby();
    const sdk = rtc.ring(OFFER);
    backend.onRow!(deviceRow());
    expect(events).toEqual([{ type: 'incoming', callId: OFFER, from: '+12145550009', to: '+12145550001' }]);
    await t.answerIncoming(OFFER);
    expect(micRequests()).toBe(1);
    expect(sdk.answered).toBe(false);
    expect(backend.fnCalls('telnyx-call', 'answer')).toHaveLength(0);
    backend.onRow!(row({ type: 'answered', call_id: OFFER }));
    expect(events.at(-1)).toEqual({ type: 'answered', callId: OFFER });

    await t.setMuted(true);
    expect(sdk.mutes).toEqual([true]);
    await t.sendDigits(OFFER, '5');
    expect(sdk.digits).toEqual(['5']);

    await t.hangup(OFFER);
    expect(sdk.hungUp).toBe(true);
    expect(backend.fnCalls('telnyx-call', 'hangup')[0].body).toEqual({ action: 'hangup', callId: OFFER });
    backend.onRow!(row({ type: 'ended', call_id: OFFER, reason: 'hangup_local' }));
    expect(events.at(-1)).toEqual({ type: 'ended', callId: OFFER, reason: 'hangup_local' });
  });

  it('waits for the device call when the event arrives first', async () => {
    const { t, backend, rtc } = await setup();
    await t.startStandby();
    backend.onRow!(deviceRow());
    const p = t.answerIncoming(OFFER);
    await vi.advanceTimersByTimeAsync(500);
    const sdk = rtc.ring(OFFER);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(sdk.answered).toBe(false);
  });

  it('matches a device call without our header when it is the only one ringing', async () => {
    const { t, backend, rtc } = await setup();
    await t.startStandby();
    const sdk = rtc.ring(null);
    backend.onRow!(deviceRow());
    await t.answerIncoming(OFFER);
    expect(sdk.answered).toBe(false);
  });

  it('rejects when the microphone is blocked, without answering', async () => {
    const { t, backend, rtc } = await setup({ micDenied: true });
    await t.startStandby();
    const sdk = rtc.ring(OFFER);
    backend.onRow!(deviceRow());
    await expect(t.answerIncoming(OFFER)).rejects.toThrow(/Microphone access was denied/);
    expect(sdk.answered).toBeNull();
  });

  it('rejects when the device call never shows up', async () => {
    const { t, backend } = await setup();
    await t.startStandby();
    backend.onRow!(deviceRow());
    const p = t.answerIncoming(OFFER);
    const assertion = expect(p).rejects.toThrow(/could not be connected/);
    await vi.advanceTimersByTimeAsync(8_200);
    await assertion;
  });

  it('decline rejects the device call and tells the server', async () => {
    const { t, backend, rtc } = await setup();
    await t.startStandby();
    const sdk = rtc.ring(OFFER);
    backend.onRow!(deviceRow());
    await t.declineIncoming(OFFER);
    expect(sdk.hungUp).toBe(true);
    expect(backend.fnCalls('telnyx-call', 'decline')[0].body).toEqual({ action: 'decline', callId: OFFER });
  });

  it('a callback answered elsewhere stops ringing here', async () => {
    const { t, backend, rtc, events } = await setup();
    await t.startStandby();
    const sdk = rtc.ring(OFFER);
    backend.onRow!(deviceRow());
    backend.onRow!(row({ type: 'ended', call_id: OFFER, reason: 'hangup_remote' }));
    expect(events.at(-1)).toEqual({ type: 'ended', callId: OFFER, reason: 'hangup_remote' });
    expect(sdk.hungUp).toBe(true);
  });

  it('a dialing session reuses the standby login; ending it keeps standby until stopStandby', async () => {
    const { t, rtc, backend } = await setup();
    await t.startStandby();
    await t.connect();
    expect(rtc.connects).toBe(1);
    expect(rtc.legs).toHaveLength(1);
    const p = t.disconnect();
    await vi.advanceTimersByTimeAsync(3_200);
    await p;
    expect(t.connected).toBe(false);
    expect(rtc.legs[0].hungUp).toBe(true);
    expect(rtc.disconnects).toBe(0);
    expect(backend.fnCalls('telnyx-agent', 'stop')).toHaveLength(1);
    await t.stopStandby();
    expect(rtc.disconnects).toBe(1);
  });

  it('without standby, disconnect logs out as before', async () => {
    const { t, rtc } = await setup();
    await t.connect();
    const p = t.disconnect();
    await vi.advanceTimersByTimeAsync(3_200);
    await p;
    expect(rtc.disconnects).toBe(1);
  });

  it('a callback offered while dialing is answered through the server (bridged to the open line)', async () => {
    const { t, backend } = await setup();
    await t.startStandby();
    await t.connect();
    backend.onRow!(row({ type: 'incoming', call_id: OFFER, from_number: '+12145550009', to_number: '+12145550001' }));
    await t.answerIncoming(OFFER);
    expect(backend.fnCalls('telnyx-call', 'answer')[0].body).toEqual({ action: 'answer', callId: OFFER });
  });

  it('retries the standby login in the background when it fails', async () => {
    const { t, backend, rtc } = await setup();
    backend.failNext = null;
    const orig = backend.userId.bind(backend);
    let fail = true;
    backend.userId = async () => {
      if (fail) throw new Error('offline');
      return orig();
    };
    await t.startStandby();
    expect(rtc.token).toBeNull();
    fail = false;
    await vi.advanceTimersByTimeAsync(5_100);
    expect(rtc.token).toBe('jwt-token');
  });
});
