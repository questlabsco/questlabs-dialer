/** Headline stat tiles with change vs the previous period of the same length. */
import type { ReactNode } from 'react';
import type { MetricsTotals } from '../../../types';
import { formatNumber, formatPercent } from '../../../lib/format';
import { MetricDelta, MetricsBand } from '../../../components/ui';
import { computeDelta, deltaTone, formatHoursMinutes, formatPointChange, formatSignedPercent } from './chartMath';

interface TileDef {
  key: keyof MetricsTotals;
  label: string;
  value: (t: MetricsTotals) => string;
  /** One-line plain-English definition. */
  definition?: string;
  /** Up is bad. */
  invert?: boolean;
  /** Compare in percentage points instead of relative change. */
  rate?: boolean;
}

const TILES: TileDef[] = [
  { key: 'dials', label: 'Dials', value: (t) => formatNumber(t.dials) },
  { key: 'pickups', label: 'Pickups', value: (t) => formatNumber(t.pickups), definition: 'A person answered the phone' },
  { key: 'pickupRate', label: 'Pickup rate', value: (t) => formatPercent(t.pickupRate), rate: true },
  { key: 'conversations', label: 'Conversations', value: (t) => formatNumber(t.conversations), definition: 'Connected and talked 20 seconds or more' },
  { key: 'bookings', label: 'Bookings', value: (t) => formatNumber(t.bookings) },
  { key: 'talkSeconds', label: 'Talk time', value: (t) => formatHoursMinutes(t.talkSeconds) },
  {
    key: 'droppedPickups',
    label: 'Dropped pickups',
    value: (t) => formatNumber(t.droppedPickups),
    definition: 'Answered, but another line had already connected',
    invert: true,
  },
];

const toneOf = (t: ReturnType<typeof deltaTone>): 'good' | 'bad' | 'flat' => (t === 'good' ? 'good' : t === 'bad' ? 'bad' : 'flat');

function DeltaLine({ def, totals, previous, comparison }: { def: TileDef; totals: MetricsTotals; previous: MetricsTotals; comparison: string }) {
  let body: ReactNode;
  if (def.rate) {
    if (totals.dials === 0 && previous.dials === 0) body = <span>No dials in either period</span>;
    else if (previous.dials === 0) body = <span>No dials in the previous period</span>;
    else {
      const change = totals.pickupRate - previous.pickupRate;
      const rounded = Math.round(change * 1000) / 1000;
      const tone = deltaTone(rounded, def.invert);
      body = (
        <span title={`${formatPointChange(totals.pickupRate, previous.pickupRate)} ${comparison}`}>
          <MetricDelta text={formatPointChange(totals.pickupRate, previous.pickupRate)} tone={toneOf(tone)} direction={rounded > 0 ? 'up' : rounded < 0 ? 'down' : undefined} />
        </span>
      );
    }
  } else {
    const cur = totals[def.key] as number;
    const prev = previous[def.key] as number;
    const d = computeDelta(cur, prev);
    if (d.kind === 'none') body = <span>None in either period</span>;
    else if (d.kind === 'new') body = <span>None in the previous period</span>;
    else {
      const tone = deltaTone(d.value, def.invert);
      body = (
        <span title={`${formatSignedPercent(d.value)} ${comparison}`}>
          <MetricDelta text={formatSignedPercent(d.value)} tone={toneOf(tone)} direction={d.value > 0 ? 'up' : d.value < 0 ? 'down' : undefined} />
        </span>
      );
    }
  }
  return <span className="dz-delta">{body}</span>;
}

/** Seven headline metrics in one band; definitions live in the cell tooltips. */
export function HeadlineTiles({ totals, previous, comparison }: { totals: MetricsTotals; previous: MetricsTotals; comparison: string }) {
  return (
    <MetricsBand
      className="dz-tiles"
      role="group"
      aria-label={`Totals, change ${comparison}`}
      metrics={TILES.map((def) => ({
        key: def.key,
        label: def.label,
        value: def.value(totals),
        title: def.definition ? `${def.label}: ${def.definition}` : undefined,
        sub: <DeltaLine def={def} totals={totals} previous={previous} comparison={comparison} />,
      }))}
    />
  );
}
