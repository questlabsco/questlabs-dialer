/**
 * Pure helpers for the admin dashboard: ranges, deltas, axis ticks, bar geometry,
 * label thinning and tooltip placement. No React, no DOM — unit-tested in node.
 */
import type { MetricsRange, NumberMetricsRow, Presence, PresenceStatus } from '../../../types';
import { PRESENCE_LABELS } from '../../../types';
import { addDays, formatNumber, formatPercent, startOfDay, startOfNextDay } from '../../../lib/format';

// ---------------------------------------------------------------------------
// Range presets
// ---------------------------------------------------------------------------

export type RangePreset = 'today' | '7d' | '30d' | 'custom';

export const RANGE_PRESETS: { id: RangePreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom' },
];

/** 'YYYY-MM-DD' -> local midnight, or null when malformed / not a real date. */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/**
 * Preset -> MetricsRange (`from` inclusive, `to` exclusive, whole local days).
 * Custom uses two inclusive 'YYYY-MM-DD' dates; returns null when they are missing,
 * malformed, or `to` is before `from`.
 */
export function rangeFromPreset(
  preset: RangePreset,
  now: Date | number,
  custom?: { from: string; to: string },
): MetricsRange | null {
  const end = startOfNextDay(now);
  switch (preset) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to: end.toISOString() };
    case '7d':
      return { from: startOfDay(addDays(now, -6)).toISOString(), to: end.toISOString() };
    case '30d':
      return { from: startOfDay(addDays(now, -29)).toISOString(), to: end.toISOString() };
    case 'custom': {
      if (!custom) return null;
      const from = parseDateKey(custom.from);
      const to = parseDateKey(custom.to);
      if (!from || !to || to.getTime() < from.getTime()) return null;
      return { from: from.toISOString(), to: startOfNextDay(to).toISOString() };
    }
  }
}

/** Number of whole local days a range covers (at least 1). */
export function rangeDayCount(range: MetricsRange): number {
  const ms = Date.parse(range.to) - Date.parse(range.from);
  return Math.max(1, Math.round(ms / 86_400_000));
}

/** "vs yesterday" / "vs previous 7 days". */
export function previousPeriodLabel(days: number): string {
  return days === 1 ? 'vs previous day' : `vs previous ${days} days`;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export type Delta =
  /** Relative change as a fraction (0.12 = +12%). */
  | { kind: 'relative'; value: number }
  /** Previous was 0 and current is above 0. */
  | { kind: 'new' }
  /** Both are 0. */
  | { kind: 'none' };

/** Relative change of a count, safe for previous = 0. */
export function computeDelta(current: number, previous: number): Delta {
  const c = Number.isFinite(current) ? current : 0;
  const p = Number.isFinite(previous) ? previous : 0;
  if (p === 0) return c === 0 ? { kind: 'none' } : { kind: 'new' };
  return { kind: 'relative', value: (c - p) / p };
}

/** Direction of a change for colouring: 'good' | 'bad' | 'flat'. */
export function deltaTone(change: number, invert = false): 'good' | 'bad' | 'flat' {
  if (!Number.isFinite(change) || Math.abs(change) < 1e-9) return 'flat';
  const up = change > 0;
  return (invert ? !up : up) ? 'good' : 'bad';
}

/** "+12.5%" / "-3.0%" / "0.0%". */
export function formatSignedPercent(fraction: number): string {
  const v = Number.isFinite(fraction) ? fraction : 0;
  const sign = v > 0.0005 ? '+' : v < -0.0005 ? '-' : '';
  return `${sign}${formatPercent(Math.abs(v))}`;
}

/** Change of a rate in percentage points: 0.021 -> "+2.1 pts". */
export function formatPointChange(currentRate: number, previousRate: number): string {
  const pts = ((Number.isFinite(currentRate) ? currentRate : 0) - (Number.isFinite(previousRate) ? previousRate : 0)) * 100;
  const rounded = Math.round(pts * 10) / 10;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${Math.abs(rounded).toFixed(1)} pts`;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** 3725 -> "1h 2m", 600 -> "10m", 0 -> "0m". */
export function formatHoursMinutes(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${formatNumber(h)}h ${m}m`;
  return `${m}m`;
}

/** Elapsed milliseconds for the live view: "0:42", "12:05", "2h 14m", "3d 4h". */
export function formatElapsed(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    return `${h}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const d = Math.floor(s / 86_400);
  return `${d}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** Axis tick label: full under 10,000, compact above ("12K", "1.5M"). */
export function formatAxisNumber(v: number, axisMax: number): string {
  if (axisMax < 10_000) return formatNumber(Math.round(v * 100) / 100);
  if (Math.abs(v) >= 1_000_000) return `${trimZero(v / 1_000_000)}M`;
  if (Math.abs(v) >= 1000) return `${trimZero(v / 1000)}K`;
  return formatNumber(v);
}

function trimZero(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** Rate tick label; one decimal only when the step needs it. */
export function formatAxisPercent(v: number, step: number): string {
  return formatPercent(v, step < 0.01 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Axis ticks / scaling
// ---------------------------------------------------------------------------

export interface Ticks {
  ticks: number[];
  /** Top of the axis (last tick). */
  max: number;
  step: number;
}

/**
 * "Nice" ticks from 0 to at least `maxValue`, about `target` intervals.
 * `integer` forces whole-number steps (counts). Non-positive / non-finite max -> [0, fallback].
 */
export function niceTicks(maxValue: number, target = 4, opts: { integer?: boolean; fallbackMax?: number } = {}): Ticks {
  const integer = opts.integer ?? false;
  const fallback = opts.fallbackMax ?? 1;
  const t = Math.max(1, Math.floor(target));
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    const step = fallback;
    return { ticks: [0, fallback], max: fallback, step };
  }
  const raw = maxValue / t;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const candidates = integer && mag < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
  let step = candidates.find((c) => norm <= c + 1e-9)! * mag;
  if (integer) step = Math.max(1, Math.round(step));
  step = round(step);
  const top = round(Math.ceil(maxValue / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(round(v));
  return { ticks, max: top, step };
}

function round(v: number): number {
  return Math.round(v * 1e10) / 1e10;
}

/** value / max clamped to 0..1; 0 for zero, negative, empty or non-finite input. */
export function scaleFraction(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(1, value / max);
}

/** Largest value of a field across rows (0 for an empty list). */
export function maxOf<T>(rows: readonly T[], get: (row: T) => number): number {
  let m = 0;
  for (const r of rows) {
    const v = get(r);
    if (Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

/** Share of total as a fraction; 0 when total is 0. */
export function shareOf(count: number, total: number): number {
  return total > 0 && count > 0 ? count / total : 0;
}

// ---------------------------------------------------------------------------
// Column geometry
// ---------------------------------------------------------------------------

export const BAR_MAX = 24;
export const BAR_GAP = 2;

/** Width of a column inside a band: <= 24px, never filling the band, always >= 2px of gap. */
export function barWidth(band: number): number {
  if (!Number.isFinite(band) || band <= 0) return 0;
  const w = Math.min(BAR_MAX, band * 0.62, band - BAR_GAP);
  return Math.max(Math.min(1, band), w);
}

/**
 * SVG path for a column growing up from `baseY`: 4px rounded data-end, square baseline.
 * Empty string for zero / negative height or width.
 */
export function columnPath(x: number, baseY: number, w: number, h: number, radius = 4): string {
  if (!(w > 0) || !(h > 0)) return '';
  const r = Math.max(0, Math.min(radius, h, w / 2));
  const top = baseY - h;
  const f = (n: number) => String(Math.round(n * 100) / 100);
  return [
    `M${f(x)},${f(baseY)}`,
    `V${f(top + r)}`,
    `Q${f(x)},${f(top)} ${f(x + r)},${f(top)}`,
    `H${f(x + w - r)}`,
    `Q${f(x + w)},${f(top)} ${f(x + w)},${f(top + r)}`,
    `V${f(baseY)}`,
    'Z',
  ].join(' ');
}

/**
 * Which x-axis labels to show so they never collide: at most floor(plotWidth / minSpacing),
 * evenly stepped and always including the last (most recent) day.
 */
export function thinLabelIndices(count: number, plotWidth: number, minSpacing = 64): number[] {
  if (count <= 0) return [];
  const maxLabels = Math.max(1, Math.floor(Math.max(0, plotWidth) / minSpacing));
  const step = Math.max(1, Math.ceil(count / maxLabels));
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i -= step) out.push(i);
  return out.reverse();
}

/** Keeps a centred label of half-width `half` inside [minX, maxX]. */
export function clampLabelX(x: number, half: number, minX: number, maxX: number): number {
  if (maxX - minX < half * 2) return (minX + maxX) / 2;
  return Math.min(maxX - half, Math.max(minX + half, x));
}

/**
 * Tooltip left edge: to the right of the anchor by `offset`, flipped to the left when it would
 * overflow, and finally clamped inside [0, containerWidth - tipWidth].
 */
export function placeTooltip(anchorX: number, tipWidth: number, containerWidth: number, offset = 12): number {
  let left = anchorX + offset;
  if (left + tipWidth > containerWidth) left = anchorX - offset - tipWidth;
  const maxLeft = Math.max(0, containerWidth - tipWidth);
  return Math.min(maxLeft, Math.max(0, left));
}

/** Band index under a pointer x (plot coordinates), clamped; -1 when there are no bands. */
export function bandIndexAt(x: number, plotLeft: number, band: number, count: number): number {
  if (count <= 0 || !(band > 0)) return -1;
  const i = Math.floor((x - plotLeft) / band);
  return Math.min(count - 1, Math.max(0, i));
}

/**
 * Splits a series with gaps (null) into runs of consecutive points, for drawing a line
 * that breaks where there is no data instead of dropping to zero.
 */
export function splitRuns<T>(values: readonly (T | null)[]): { start: number; values: T[] }[] {
  const runs: { start: number; values: T[] }[] = [];
  let cur: { start: number; values: T[] } | null = null;
  values.forEach((v, i) => {
    if (v === null) {
      cur = null;
      return;
    }
    if (!cur) {
      cur = { start: i, values: [] };
      runs.push(cur);
    }
    cur.values.push(v);
  });
  return runs;
}

// ---------------------------------------------------------------------------
// Phone-number health
// ---------------------------------------------------------------------------

export type NumberHealth = 'ok' | 'low' | 'flagged' | 'too_few';

/** Below this many dials in the range a number is not judged. */
export const NUMBER_MIN_DIALS = 20;

export interface NumberHealthResult {
  fleetRate: number;
  byNumber: Map<string, { health: NumberHealth; ratio: number | null }>;
}

/**
 * Compares each number's pickup rate with the rate of all the other numbers combined.
 * flagged: < 50% of the others (likely marked as spam); low: < 75%.
 */
export function numberHealth(rows: readonly NumberMetricsRow[], minDials = NUMBER_MIN_DIALS): NumberHealthResult {
  let dials = 0;
  let pickups = 0;
  for (const r of rows) {
    dials += r.dials;
    pickups += r.pickups;
  }
  const fleetRate = dials > 0 ? pickups / dials : 0;
  const byNumber = new Map<string, { health: NumberHealth; ratio: number | null }>();
  for (const r of rows) {
    const otherDials = dials - r.dials;
    const otherRate = otherDials > 0 ? (pickups - r.pickups) / otherDials : 0;
    if (r.dials < minDials || otherRate <= 0) {
      byNumber.set(r.number, { health: 'too_few', ratio: null });
      continue;
    }
    const rate = r.pickups / r.dials;
    const ratio = rate / otherRate;
    byNumber.set(r.number, { health: ratio < 0.5 ? 'flagged' : ratio < 0.75 ? 'low' : 'ok', ratio });
  }
  return { fleetRate, byNumber };
}

// ---------------------------------------------------------------------------
// Live view
// ---------------------------------------------------------------------------

export const PRESENCE_ORDER: PresenceStatus[] = ['on_call', 'wrap_up', 'dialing', 'paused', 'idle', 'offline'];

/** Busiest first, then by name. */
export function sortPresence(list: readonly Presence[]): Presence[] {
  return [...list].sort((a, b) => {
    const d = PRESENCE_ORDER.indexOf(a.status) - PRESENCE_ORDER.indexOf(b.status);
    return d !== 0 ? d : a.fullName.localeCompare(b.fullName);
  });
}

/** "2 on call · 1 dialing · 1 offline" ("No callers" when empty). */
export function presenceSummary(list: readonly Presence[]): string {
  if (list.length === 0) return 'No callers';
  const parts: string[] = [];
  for (const s of PRESENCE_ORDER) {
    const n = list.filter((p) => p.status === s).length;
    if (n > 0) parts.push(`${n} ${PRESENCE_LABELS[s].toLowerCase()}`);
  }
  return parts.join(' · ');
}
