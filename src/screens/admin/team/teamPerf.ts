/**
 * Pure helpers for the Team screen's performance views: range -> dates, previous period,
 * per-day ranges and series assembly, deltas, outcome counts and a small metrics cache.
 * No React, no DOM; unit-tested in node.
 */
import type { CallRecord, CallerMetricsRow, Metrics, MetricsRange, MetricsTotals, Presence, PresenceStatus, Profile } from '../../../types';
import { CALL_RESULT_LABELS, DISPOSITIONS } from '../../../types';
import { addDays, startOfDay, toDateKey } from '../../../lib/format';
import { computeDelta, formatPointChange, formatSignedPercent, rangeDayCount, rangeFromPreset, type Delta } from '../dashboard/chartMath';

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export type TeamRange = 'today' | '7d' | '30d';

export const TEAM_RANGES: { id: TeamRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

export const DEFAULT_TEAM_RANGE: TeamRange = '7d';

/** Whole local days ending today (`from` inclusive, `to` exclusive = next local midnight). */
export function teamRange(id: TeamRange, now: Date | number): MetricsRange {
  // rangeFromPreset never returns null for the fixed presets.
  return rangeFromPreset(id, now)!;
}

/** Number of whole local days in a range (at least 1). */
export function dayCount(range: MetricsRange): number {
  return rangeDayCount(range);
}

/**
 * The same number of whole local days immediately before `range`
 * (walks back by calendar days, so a DST change does not shift it by an hour).
 */
export function previousRange(range: MetricsRange): MetricsRange {
  const days = rangeDayCount(range);
  const from = new Date(range.from);
  return { from: startOfDay(addDays(from, -days)).toISOString(), to: range.from };
}

/** "vs yesterday" / "vs previous 7 days". */
export function comparisonLabel(id: TeamRange, days: number): string {
  if (id === 'today') return 'vs yesterday';
  return days === 1 ? 'vs previous day' : `vs previous ${days} days`;
}

/** How many days the daily trend covers: a week for Today / Last 7 days, else the range. */
export function trendDayCount(id: TeamRange): number {
  return id === '30d' ? 30 : 7;
}

export interface DaySlot {
  /** Local 'YYYY-MM-DD'. */
  date: string;
  range: MetricsRange;
}

/** One slot per local day, oldest first, the last one being the day of `end`. */
export function daySlots(end: Date | number, count: number): DaySlot[] {
  const n = Math.max(0, Math.floor(count));
  const last = startOfDay(end);
  const out: DaySlot[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = startOfDay(addDays(last, -i));
    const next = startOfDay(addDays(day, 1));
    out.push({ date: toDateKey(day), range: { from: day.toISOString(), to: next.toISOString() } });
  }
  return out;
}

/** "2026-11-09" -> "Nov 9". */
export function shortDayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Totals / series
// ---------------------------------------------------------------------------

export const ZERO_TOTALS: MetricsTotals = {
  dials: 0,
  pickups: 0,
  pickupRate: 0,
  conversations: 0,
  bookings: 0,
  talkSeconds: 0,
  droppedPickups: 0,
};

/** A caller's row from a Metrics result, or zeros when the caller has none. */
export function callerTotals(metrics: Metrics | null | undefined, callerId: string): MetricsTotals {
  const row = metrics?.byCaller.find((r) => r.callerId === callerId);
  if (!row) return { ...ZERO_TOTALS };
  return {
    dials: row.dials,
    pickups: row.pickups,
    pickupRate: row.pickupRate,
    conversations: row.conversations,
    bookings: row.bookings,
    talkSeconds: row.talkSeconds,
    droppedPickups: row.droppedPickups,
  };
}

/** Map callerId -> row for quick lookups in the list. */
export function indexByCaller(rows: readonly CallerMetricsRow[] | null | undefined): Map<string, CallerMetricsRow> {
  return new Map((rows ?? []).map((r) => [r.callerId, r]));
}

export interface DayPoint {
  date: string;
  label: string;
  dials: number;
  bookings: number;
  /** False while that day's numbers have not loaded (or failed). */
  loaded: boolean;
}

/** Per-day series for one caller from one Metrics result per day (missing day -> zeros, loaded false). */
export function assembleSeries(slots: readonly DaySlot[], byDate: ReadonlyMap<string, Metrics | undefined>, callerId: string): DayPoint[] {
  return slots.map((s) => {
    const m = byDate.get(s.date);
    const t = callerTotals(m, callerId);
    return { date: s.date, label: shortDayLabel(s.date), dials: t.dials, bookings: t.bookings, loaded: !!m };
  });
}

export function hasActivity(t: MetricsTotals): boolean {
  return t.dials > 0 || t.talkSeconds > 0 || t.conversations > 0 || t.bookings > 0 || t.pickups > 0;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export type HeadlineKey = 'dials' | 'pickups' | 'pickupRate' | 'conversations' | 'bookings' | 'talkSeconds';

export type DeltaView =
  | { kind: 'change'; text: string; tone: 'good' | 'bad' | 'flat'; direction?: 'up' | 'down' }
  | { kind: 'note'; text: string };

/** Change line for one headline number. Rates compare in points; counts relatively. */
export function headlineDelta(key: HeadlineKey, cur: MetricsTotals, prev: MetricsTotals): DeltaView {
  if (key === 'pickupRate') {
    if (cur.dials === 0 && prev.dials === 0) return { kind: 'note', text: 'No dials in either period' };
    if (prev.dials === 0) return { kind: 'note', text: 'No dials in the previous period' };
    if (cur.dials === 0) return { kind: 'note', text: 'No dials in this period' };
    const change = Math.round((cur.pickupRate - prev.pickupRate) * 1000) / 1000;
    return {
      kind: 'change',
      text: formatPointChange(cur.pickupRate, prev.pickupRate),
      tone: change > 0 ? 'good' : change < 0 ? 'bad' : 'flat',
      direction: change > 0 ? 'up' : change < 0 ? 'down' : undefined,
    };
  }
  const d: Delta = computeDelta(cur[key], prev[key]);
  if (d.kind === 'none') return { kind: 'note', text: 'None in either period' };
  if (d.kind === 'new') return { kind: 'note', text: 'None in the previous period' };
  const v = Math.round(d.value * 1000) / 1000;
  return {
    kind: 'change',
    text: formatSignedPercent(d.value),
    tone: v > 0 ? 'good' : v < 0 ? 'bad' : 'flat',
    direction: v > 0 ? 'up' : v < 0 ? 'down' : undefined,
  };
}

// ---------------------------------------------------------------------------
// Outcomes ("how their calls ended")
// ---------------------------------------------------------------------------

export interface EndingCount {
  key: string;
  label: string;
  count: number;
}

/** What a call ended as: the wrap-up choice when there is one, else the call result. */
export function callEnding(c: Pick<CallRecord, 'disposition' | 'result'>): { key: string; label: string } {
  if (c.disposition) {
    const d = DISPOSITIONS.find((x) => x.value === c.disposition);
    return { key: `d:${c.disposition}`, label: d?.label ?? c.disposition };
  }
  if (c.result === 'answered') return { key: 'r:answered', label: 'Answered, no outcome' };
  if (c.result) return { key: `r:${c.result}`, label: CALL_RESULT_LABELS[c.result] ?? c.result };
  return { key: 'r:open', label: 'In progress' };
}

/** Count per ending, largest first (ties by label). */
export function countEndings(calls: readonly Pick<CallRecord, 'disposition' | 'result'>[]): EndingCount[] {
  const map = new Map<string, EndingCount>();
  for (const c of calls) {
    const e = callEnding(c);
    const cur = map.get(e.key);
    if (cur) cur.count++;
    else map.set(e.key, { ...e, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// People / presence
// ---------------------------------------------------------------------------

/** Live status for a person: admins and deactivated people have none; a caller without an entry is offline. */
export function liveStatus(user: Pick<Profile, 'id' | 'role' | 'active'>, presence: ReadonlyMap<string, Presence> | null): PresenceStatus | null {
  if (user.role !== 'caller' || !user.active) return null;
  if (!presence) return null;
  return presence.get(user.id)?.status ?? 'offline';
}

/** Busiest first for sorting the Live column. */
export const LIVE_SORT: Record<PresenceStatus, number> = { on_call: 0, wrap_up: 1, dialing: 2, paused: 3, idle: 4, offline: 5 };

/** Value for a sortable number column: null (always last) for admins. */
export function metricSortValue(user: Pick<Profile, 'role'>, row: MetricsTotals | undefined, key: HeadlineKey): number | null {
  if (user.role !== 'caller') return null;
  return row ? row[key] : 0;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. Rejections are kept per item. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  const n = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: items.length ? n : 0 }, worker));
  return out;
}

/**
 * Caches getMetrics results by range. Ranges that end in the past are kept for the session;
 * ranges still open (ending after now) expire after `liveTtlMs`. Failed fetches are not kept.
 */
export class MetricsCache {
  private entries = new Map<string, { at: number; open: boolean; value: Promise<Metrics> }>();

  constructor(
    private fetch: (range: MetricsRange) => Promise<Metrics>,
    private now: () => number = Date.now,
    private liveTtlMs = 60_000,
  ) {}

  static key(range: MetricsRange): string {
    return `${range.from}|${range.to}`;
  }

  get(range: MetricsRange, opts: { fresh?: boolean } = {}): Promise<Metrics> {
    const key = MetricsCache.key(range);
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && !opts.fresh && (!hit.open || t - hit.at < this.liveTtlMs)) return hit.value;
    const value = this.fetch(range);
    const entry = { at: t, open: Date.parse(range.to) > t, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  /** Drop entries for ranges that are still open (e.g. on Refresh). */
  invalidateOpen(): void {
    for (const [k, e] of this.entries) if (e.open) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}
