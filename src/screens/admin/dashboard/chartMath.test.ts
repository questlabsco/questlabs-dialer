import { describe, expect, it } from 'vitest';
import type { NumberMetricsRow, Presence } from '../../../types';
import {
  bandIndexAt,
  barWidth,
  clampLabelX,
  columnPath,
  computeDelta,
  deltaTone,
  formatAxisNumber,
  formatAxisPercent,
  formatElapsed,
  formatHoursMinutes,
  formatPointChange,
  formatSignedPercent,
  maxOf,
  niceTicks,
  numberHealth,
  parseDateKey,
  placeTooltip,
  presenceSummary,
  rangeDayCount,
  rangeFromPreset,
  scaleFraction,
  shareOf,
  sortPresence,
  splitRuns,
  thinLabelIndices,
} from './chartMath';

describe('niceTicks', () => {
  it('produces round steps that cover the max', () => {
    expect(niceTicks(250, 4, { integer: true })).toEqual({ ticks: [0, 100, 200, 300], max: 300, step: 100 });
    expect(niceTicks(87, 4).ticks).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1000, 4).ticks).toEqual([0, 250, 500, 750, 1000]);
  });

  it('handles fractional rates without float noise', () => {
    const t = niceTicks(0.18, 4);
    expect(t.step).toBe(0.05);
    expect(t.ticks).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
    expect(t.max).toBeGreaterThanOrEqual(0.18);
  });

  it('keeps integer steps for small counts', () => {
    expect(niceTicks(3, 4, { integer: true }).ticks).toEqual([0, 1, 2, 3]);
    expect(niceTicks(1, 4, { integer: true }).ticks).toEqual([0, 1]);
    expect(niceTicks(7, 4, { integer: true }).step).toBe(2);
  });

  it('falls back for zero, negative and non-finite max', () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], max: 1, step: 1 });
    expect(niceTicks(-5, 4, { fallbackMax: 0.1 }).ticks).toEqual([0, 0.1]);
    expect(niceTicks(Number.NaN).max).toBe(1);
  });

  it('exact multiples do not add an extra tick', () => {
    expect(niceTicks(100, 4).ticks).toEqual([0, 25, 50, 75, 100]);
  });
});

describe('bar scaling', () => {
  it('scaleFraction is 0 for zero/empty data and clamps to 1', () => {
    expect(scaleFraction(0, 0)).toBe(0);
    expect(scaleFraction(5, 0)).toBe(0);
    expect(scaleFraction(0, 10)).toBe(0);
    expect(scaleFraction(-3, 10)).toBe(0);
    expect(scaleFraction(Number.NaN, 10)).toBe(0);
    expect(scaleFraction(5, 10)).toBe(0.5);
    expect(scaleFraction(15, 10)).toBe(1);
  });

  it('maxOf and shareOf handle empty input', () => {
    expect(maxOf([], (x: number) => x)).toBe(0);
    expect(maxOf([3, 9, 2], (x) => x)).toBe(9);
    expect(shareOf(3, 0)).toBe(0);
    expect(shareOf(1, 4)).toBe(0.25);
  });

  it('barWidth caps at 24px and always leaves a gap', () => {
    expect(barWidth(100)).toBe(24);
    expect(barWidth(20)).toBeCloseTo(12.4);
    expect(20 - barWidth(20)).toBeGreaterThanOrEqual(2);
    expect(barWidth(3)).toBe(1);
    expect(barWidth(0)).toBe(0);
  });

  it('columnPath is empty for zero height and clamps the radius', () => {
    expect(columnPath(0, 100, 10, 0)).toBe('');
    expect(columnPath(0, 100, 0, 10)).toBe('');
    expect(columnPath(10, 100, 20, 50)).toBe('M10,100 V54 Q10,50 14,50 H26 Q30,50 30,54 V100 Z');
    // 2px tall bar: radius limited to the height.
    expect(columnPath(0, 10, 20, 2)).toBe('M0,10 V10 Q0,8 2,8 H18 Q20,8 20,10 V10 Z');
  });
});

describe('deltas', () => {
  it('relative change, previous = 0 and both zero', () => {
    expect(computeDelta(120, 100)).toEqual({ kind: 'relative', value: 0.2 });
    expect(computeDelta(50, 100)).toEqual({ kind: 'relative', value: -0.5 });
    expect(computeDelta(5, 0)).toEqual({ kind: 'new' });
    expect(computeDelta(0, 0)).toEqual({ kind: 'none' });
    expect(computeDelta(0, 10)).toEqual({ kind: 'relative', value: -1 });
  });

  it('tone respects inverted metrics', () => {
    expect(deltaTone(0.1)).toBe('good');
    expect(deltaTone(-0.1)).toBe('bad');
    expect(deltaTone(0.1, true)).toBe('bad');
    expect(deltaTone(-0.1, true)).toBe('good');
    expect(deltaTone(0)).toBe('flat');
  });

  it('formats signed percents and point changes', () => {
    expect(formatSignedPercent(0.125)).toBe('+12.5%');
    expect(formatSignedPercent(-0.03)).toBe('-3.0%');
    expect(formatSignedPercent(0)).toBe('0.0%');
    expect(formatPointChange(0.231, 0.21)).toBe('+2.1 pts');
    expect(formatPointChange(0.2, 0.25)).toBe('-5.0 pts');
    expect(formatPointChange(0.2, 0.2)).toBe('0.0 pts');
  });
});

describe('range presets', () => {
  const now = new Date(2026, 10, 15, 14, 30); // Nov 15 2026, 2:30 PM local

  it('today is one whole local day', () => {
    const r = rangeFromPreset('today', now)!;
    expect(new Date(r.from)).toEqual(new Date(2026, 10, 15));
    expect(new Date(r.to)).toEqual(new Date(2026, 10, 16));
    expect(rangeDayCount(r)).toBe(1);
  });

  it('last 7 / 30 days end tomorrow midnight and include today', () => {
    const r7 = rangeFromPreset('7d', now)!;
    expect(new Date(r7.from)).toEqual(new Date(2026, 10, 9));
    expect(new Date(r7.to)).toEqual(new Date(2026, 10, 16));
    expect(rangeDayCount(r7)).toBe(7);
    const r30 = rangeFromPreset('30d', now)!;
    expect(new Date(r30.from)).toEqual(new Date(2026, 9, 17));
    expect(rangeDayCount(r30)).toBe(30);
  });

  it('custom range is inclusive of both dates and validated', () => {
    const r = rangeFromPreset('custom', now, { from: '2026-11-01', to: '2026-11-03' })!;
    expect(new Date(r.from)).toEqual(new Date(2026, 10, 1));
    expect(new Date(r.to)).toEqual(new Date(2026, 10, 4));
    expect(rangeDayCount(r)).toBe(3);
    expect(rangeFromPreset('custom', now, { from: '2026-11-03', to: '2026-11-03' })).not.toBeNull();
    expect(rangeFromPreset('custom', now, { from: '2026-11-05', to: '2026-11-03' })).toBeNull();
    expect(rangeFromPreset('custom', now, { from: '', to: '2026-11-03' })).toBeNull();
    expect(rangeFromPreset('custom', now)).toBeNull();
  });

  it('parseDateKey rejects impossible dates', () => {
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('nope')).toBeNull();
    expect(parseDateKey('2026-02-03')).toEqual(new Date(2026, 1, 3));
  });
});

describe('labels and tooltips', () => {
  it('thins 30 day labels so they never collide and keeps the latest day', () => {
    const idx = thinLabelIndices(30, 600, 64);
    expect(idx.length).toBeLessThanOrEqual(Math.floor(600 / 64));
    expect(idx[idx.length - 1]).toBe(29);
    const spacing = 600 / 30;
    for (let i = 1; i < idx.length; i++) expect((idx[i] - idx[i - 1]) * spacing).toBeGreaterThanOrEqual(64);
  });

  it('shows every label when there is room, and handles tiny inputs', () => {
    expect(thinLabelIndices(7, 700)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(thinLabelIndices(1, 10)).toEqual([0]);
    expect(thinLabelIndices(0, 500)).toEqual([]);
  });

  it('clampLabelX keeps labels inside the plot', () => {
    expect(clampLabelX(2, 20, 40, 600)).toBe(60);
    expect(clampLabelX(599, 20, 40, 600)).toBe(580);
    expect(clampLabelX(300, 20, 40, 600)).toBe(300);
    expect(clampLabelX(300, 50, 0, 60)).toBe(30);
  });

  it('placeTooltip flips and clamps inside the container', () => {
    expect(placeTooltip(100, 160, 600)).toBe(112);
    expect(placeTooltip(550, 160, 600)).toBe(378);
    expect(placeTooltip(100, 160, 150)).toBe(0); // wider than the room on both sides
    expect(placeTooltip(5, 160, 100)).toBe(0); // container narrower than the tooltip
    for (const x of [0, 50, 300, 590, 600]) {
      const left = placeTooltip(x, 160, 600);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + 160).toBeLessThanOrEqual(600);
    }
  });

  it('bandIndexAt clamps to the data', () => {
    expect(bandIndexAt(45, 40, 20, 7)).toBe(0);
    expect(bandIndexAt(85, 40, 20, 7)).toBe(2);
    expect(bandIndexAt(-100, 40, 20, 7)).toBe(0);
    expect(bandIndexAt(9999, 40, 20, 7)).toBe(6);
    expect(bandIndexAt(50, 40, 20, 0)).toBe(-1);
  });

  it('splitRuns breaks lines at missing days', () => {
    expect(splitRuns([1, 2, null, 4, null, null, 7, 8])).toEqual([
      { start: 0, values: [1, 2] },
      { start: 3, values: [4] },
      { start: 6, values: [7, 8] },
    ]);
    expect(splitRuns([null, null])).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats talk time and elapsed time', () => {
    expect(formatHoursMinutes(0)).toBe('0m');
    expect(formatHoursMinutes(600)).toBe('10m');
    expect(formatHoursMinutes(3725)).toBe('1h 2m');
    expect(formatHoursMinutes(3600 * 1234)).toBe('1,234h 0m');
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(725_000)).toBe('12:05');
    expect(formatElapsed(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(formatElapsed(3 * 86_400_000 + 4 * 3600_000)).toBe('3d 4h');
    expect(formatElapsed(-5)).toBe('0:00');
  });

  it('formats axis ticks', () => {
    expect(formatAxisNumber(2000, 3000)).toBe('2,000');
    expect(formatAxisNumber(20000, 30000)).toBe('20K');
    expect(formatAxisNumber(1500000, 2000000)).toBe('1.5M');
    expect(formatAxisPercent(0.2, 0.05)).toBe('20%');
    expect(formatAxisPercent(0.025, 0.005)).toBe('2.5%');
  });
});

function numRow(number: string, dials: number, pickups: number): NumberMetricsRow {
  return {
    number,
    numberId: number,
    label: number,
    dials,
    pickups,
    pickupRate: dials ? pickups / dials : 0,
    conversations: 0,
    bookings: 0,
    talkSeconds: 0,
    droppedPickups: 0,
  };
}

describe('numberHealth', () => {
  it('flags a number far below the others', () => {
    const res = numberHealth([numRow('+1', 100, 25), numRow('+2', 100, 24), numRow('+3', 100, 5), numRow('+4', 5, 0)]);
    expect(res.byNumber.get('+1')!.health).toBe('ok');
    expect(res.byNumber.get('+3')!.health).toBe('flagged');
    expect(res.byNumber.get('+4')!.health).toBe('too_few');
    expect(res.fleetRate).toBeCloseTo(54 / 305);
  });

  it('marks low but not flagged', () => {
    const res = numberHealth([numRow('+1', 100, 30), numRow('+2', 100, 20)]);
    expect(res.byNumber.get('+2')!.health).toBe('low');
  });

  it('does not judge when nobody picked up', () => {
    const res = numberHealth([numRow('+1', 100, 0), numRow('+2', 100, 0)]);
    expect(res.byNumber.get('+1')!.health).toBe('too_few');
    expect(numberHealth([]).fleetRate).toBe(0);
  });
});

describe('presence', () => {
  const p = (fullName: string, status: Presence['status']): Presence => ({ callerId: fullName, fullName, status, since: '', detail: null });

  it('summarises in busy-first order and omits zero counts', () => {
    expect(presenceSummary([p('A', 'offline'), p('B', 'on_call'), p('C', 'dialing'), p('D', 'on_call')])).toBe('2 on call · 1 dialing · 1 offline');
    expect(presenceSummary([])).toBe('No callers');
  });

  it('sorts busiest first then by name', () => {
    expect(sortPresence([p('Zed', 'idle'), p('Amy', 'offline'), p('Bo', 'on_call'), p('Al', 'on_call')]).map((x) => x.fullName)).toEqual(['Al', 'Bo', 'Zed', 'Amy']);
  });
});
