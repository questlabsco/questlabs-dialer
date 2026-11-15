// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CallerMetricsRow, Metrics, MetricsTotals, Presence } from '../../../types';
import {
  MetricsCache,
  ZERO_TOTALS,
  assembleSeries,
  callEnding,
  callerTotals,
  comparisonLabel,
  countEndings,
  dayCount,
  daySlots,
  hasActivity,
  headlineDelta,
  liveStatus,
  mapLimit,
  metricSortValue,
  previousRange,
  teamRange,
  trendDayCount,
} from './teamPerf';

const NOW = new Date(2026, 10, 15, 14, 30, 0).getTime();

function totals(p: Partial<MetricsTotals> = {}): MetricsTotals {
  return { ...ZERO_TOTALS, ...p };
}

function row(callerId: string, p: Partial<MetricsTotals> = {}): CallerMetricsRow {
  return { callerId, label: callerId, ...totals(p) };
}

function metrics(byCaller: CallerMetricsRow[]): Metrics {
  return {
    range: { from: '', to: '' },
    totals: totals(),
    previousTotals: totals(),
    byCaller,
    byDay: [],
    byNumber: [],
    byList: [],
    outcomes: [],
  };
}

describe('ranges', () => {
  it('today is one local day ending at next midnight', () => {
    const r = teamRange('today', NOW);
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 10, 15).getTime());
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 10, 16).getTime());
    expect(dayCount(r)).toBe(1);
  });

  it('7 and 30 days include today', () => {
    const r7 = teamRange('7d', NOW);
    expect(new Date(r7.from).getTime()).toBe(new Date(2026, 10, 9).getTime());
    expect(dayCount(r7)).toBe(7);
    const r30 = teamRange('30d', NOW);
    expect(new Date(r30.from).getTime()).toBe(new Date(2026, 9, 17).getTime());
    expect(dayCount(r30)).toBe(30);
  });

  it('previous period has the same length and ends where the range starts', () => {
    for (const id of ['today', '7d', '30d'] as const) {
      const r = teamRange(id, NOW);
      const p = previousRange(r);
      expect(p.to).toBe(r.from);
      expect(dayCount(p)).toBe(dayCount(r));
    }
    const p = previousRange(teamRange('7d', NOW));
    expect(new Date(p.from).getTime()).toBe(new Date(2026, 10, 2).getTime());
  });

  it('comparison labels', () => {
    expect(comparisonLabel('today', 1)).toBe('vs yesterday');
    expect(comparisonLabel('7d', 7)).toBe('vs previous 7 days');
    expect(comparisonLabel('30d', 30)).toBe('vs previous 30 days');
  });

  it('trend covers a week, or 30 days for the 30 day range', () => {
    expect(trendDayCount('today')).toBe(7);
    expect(trendDayCount('7d')).toBe(7);
    expect(trendDayCount('30d')).toBe(30);
  });

  it('day slots are consecutive local days ending today', () => {
    const s = daySlots(NOW, 7);
    expect(s).toHaveLength(7);
    expect(s[0].date).toBe('2026-11-09');
    expect(s[6].date).toBe('2026-11-15');
    for (let i = 1; i < s.length; i++) expect(s[i].range.from).toBe(s[i - 1].range.to);
    expect(new Date(s[6].range.to).getTime()).toBe(new Date(2026, 10, 16).getTime());
    expect(daySlots(NOW, 0)).toEqual([]);
  });
});

describe('series and totals', () => {
  it('callerTotals takes the row or zeros', () => {
    const m = metrics([row('a', { dials: 5, bookings: 1 })]);
    expect(callerTotals(m, 'a')).toEqual(totals({ dials: 5, bookings: 1 }));
    expect(callerTotals(m, 'b')).toEqual(totals());
    expect(callerTotals(null, 'a')).toEqual(totals());
  });

  it('assembles one point per slot, zero and not loaded where missing', () => {
    const slots = daySlots(NOW, 3);
    const byDate = new Map<string, Metrics | undefined>([
      [slots[0].date, metrics([row('a', { dials: 10, bookings: 2 }), row('b', { dials: 99 })])],
      [slots[2].date, metrics([row('b', { dials: 4 })])],
    ]);
    const s = assembleSeries(slots, byDate, 'a');
    expect(s.map((p) => p.dials)).toEqual([10, 0, 0]);
    expect(s.map((p) => p.bookings)).toEqual([2, 0, 0]);
    expect(s.map((p) => p.loaded)).toEqual([true, false, true]);
    expect(s[2].label).toBe('Nov 15');
  });

  it('hasActivity', () => {
    expect(hasActivity(totals())).toBe(false);
    expect(hasActivity(totals({ dials: 1 }))).toBe(true);
    expect(hasActivity(totals({ talkSeconds: 30 }))).toBe(true);
  });
});

describe('deltas', () => {
  it('relative change for counts', () => {
    const d = headlineDelta('dials', totals({ dials: 120 }), totals({ dials: 100 }));
    expect(d).toEqual({ kind: 'change', text: '+20.0%', tone: 'good', direction: 'up' });
    const down = headlineDelta('bookings', totals({ bookings: 1 }), totals({ bookings: 4 }));
    expect(down).toMatchObject({ kind: 'change', tone: 'bad', direction: 'down', text: '-75.0%' });
    const flat = headlineDelta('pickups', totals({ pickups: 3 }), totals({ pickups: 3 }));
    expect(flat).toMatchObject({ kind: 'change', tone: 'flat', direction: undefined });
  });

  it('zero previous', () => {
    expect(headlineDelta('dials', totals(), totals())).toEqual({ kind: 'note', text: 'None in either period' });
    expect(headlineDelta('dials', totals({ dials: 3 }), totals())).toEqual({ kind: 'note', text: 'None in the previous period' });
    expect(headlineDelta('dials', totals(), totals({ dials: 3 }))).toMatchObject({ kind: 'change', text: '-100.0%', tone: 'bad' });
  });

  it('pickup rate compares in points and needs dials', () => {
    const d = headlineDelta('pickupRate', totals({ dials: 100, pickupRate: 0.25 }), totals({ dials: 100, pickupRate: 0.2 }));
    expect(d).toEqual({ kind: 'change', text: '+5.0 pts', tone: 'good', direction: 'up' });
    expect(headlineDelta('pickupRate', totals(), totals())).toMatchObject({ kind: 'note' });
    expect(headlineDelta('pickupRate', totals({ dials: 5, pickupRate: 0.2 }), totals())).toEqual({ kind: 'note', text: 'No dials in the previous period' });
    expect(headlineDelta('pickupRate', totals(), totals({ dials: 5, pickupRate: 0.2 }))).toEqual({ kind: 'note', text: 'No dials in this period' });
  });
});

describe('endings', () => {
  it('prefers the disposition, then the result', () => {
    expect(callEnding({ disposition: 'booked', result: 'answered' }).label).toBe('Booked');
    expect(callEnding({ disposition: null, result: 'no_answer' }).label).toBe('No answer');
    expect(callEnding({ disposition: null, result: 'answered' }).label).toBe('Answered, no outcome');
    expect(callEnding({ disposition: null, result: null }).label).toBe('In progress');
  });

  it('counts largest first', () => {
    const out = countEndings([
      { disposition: null, result: 'no_answer' },
      { disposition: null, result: 'no_answer' },
      { disposition: 'booked', result: 'answered' },
      { disposition: null, result: 'voicemail' },
      { disposition: null, result: 'no_answer' },
      { disposition: null, result: 'voicemail' },
    ]);
    expect(out.map((o) => [o.label, o.count])).toEqual([
      ['No answer', 3],
      ['Voicemail', 2],
      ['Booked', 1],
    ]);
    expect(countEndings([])).toEqual([]);
  });
});

describe('people', () => {
  const presence = new Map<string, Presence>([['c1', { callerId: 'c1', fullName: 'A', status: 'on_call', since: '', detail: null }]]);
  it('live status', () => {
    expect(liveStatus({ id: 'c1', role: 'caller', active: true }, presence)).toBe('on_call');
    expect(liveStatus({ id: 'c2', role: 'caller', active: true }, presence)).toBe('offline');
    expect(liveStatus({ id: 'c1', role: 'caller', active: false }, presence)).toBeNull();
    expect(liveStatus({ id: 'a', role: 'admin', active: true }, presence)).toBeNull();
    expect(liveStatus({ id: 'c1', role: 'caller', active: true }, null)).toBeNull();
  });

  it('admins sort as null, callers without a row as 0', () => {
    expect(metricSortValue({ role: 'admin' }, totals({ dials: 4 }), 'dials')).toBeNull();
    expect(metricSortValue({ role: 'caller' }, undefined, 'dials')).toBe(0);
    expect(metricSortValue({ role: 'caller' }, totals({ dials: 4 }), 'dials')).toBe(4);
  });
});

describe('mapLimit', () => {
  it('keeps order, limits concurrency and records failures', async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error('boom');
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(res.map((r) => (r.status === 'fulfilled' ? r.value : 'x'))).toEqual([10, 20, 30, 'x', 50, 60]);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe('MetricsCache', () => {
  const past = { from: new Date(2026, 10, 1).toISOString(), to: new Date(2026, 10, 2).toISOString() };
  const open = { from: new Date(2026, 10, 15).toISOString(), to: new Date(2026, 10, 16).toISOString() };

  it('keeps past ranges, expires open ones', async () => {
    let t = NOW;
    const fetch = vi.fn(async () => metrics([]));
    const c = new MetricsCache(fetch, () => t, 1000);
    await c.get(past);
    await c.get(past);
    await c.get(open);
    await c.get(open);
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 5000;
    await c.get(past);
    await c.get(open);
    expect(fetch).toHaveBeenCalledTimes(3);
    c.invalidateOpen();
    await c.get(past);
    await c.get(open);
    expect(fetch).toHaveBeenCalledTimes(4);
    await c.get(past, { fresh: true });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not keep failures', async () => {
    let fail = true;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error('nope');
      return metrics([]);
    });
    const c = new MetricsCache(fetch, () => NOW);
    await expect(c.get(past)).rejects.toThrow('nope');
    fail = false;
    await expect(c.get(past)).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
