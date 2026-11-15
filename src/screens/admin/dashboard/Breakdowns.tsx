/** By caller / by phone number / by lead list tables, and the outcomes bars. */
import type { CallerMetricsRow, ListMetricsRow, NumberMetricsRow, OutcomeCount } from '../../../types';
import { formatNumber, formatPercent, formatPhone } from '../../../lib/format';
import { Badge, Card, HelpTip, Table, type TableColumn } from '../../../components/ui';
import { formatHoursMinutes, maxOf, NUMBER_MIN_DIALS, scaleFraction, shareOf, type NumberHealth, type NumberHealthResult } from './chartMath';
import { MetricsTable, type MetricColumn } from './MetricsTable';
import { ChartCard, TipRows, useTip } from './shared';

// ---------------------------------------------------------------------------
// By caller
// ---------------------------------------------------------------------------

const CALLER_METRICS: MetricColumn<CallerMetricsRow>[] = [
  { key: 'dials', header: 'Dials', value: (r) => r.dials, format: (r) => formatNumber(r.dials) },
  { key: 'pickups', header: 'Pickups', value: (r) => r.pickups, format: (r) => formatNumber(r.pickups) },
  { key: 'pickupRate', header: 'Pickup rate', value: (r) => r.pickupRate, format: (r) => formatPercent(r.pickupRate) },
  { key: 'conversations', header: 'Conversations', value: (r) => r.conversations, format: (r) => formatNumber(r.conversations) },
  { key: 'bookings', header: 'Bookings', value: (r) => r.bookings, format: (r) => formatNumber(r.bookings) },
  { key: 'talk', header: 'Talk time', value: (r) => r.talkSeconds, format: (r) => formatHoursMinutes(r.talkSeconds) },
];

export function CallersCard({ rows }: { rows: CallerMetricsRow[] }) {
  return (
    <Card className="dz-card dz-callers" padded={false} title="By caller">
      <MetricsTable
        rows={rows}
        rowKey={(r) => r.callerId}
        nameHeader="Caller"
        name={(r) => r.label}
        nameSort={(r) => r.label}
        nameText={(r) => r.label}
        metrics={CALLER_METRICS}
        defaultMetric="dials"
        isZero={(r) => r.dials === 0 && r.talkSeconds === 0}
        caption="Metrics by caller"
        empty="No callers yet."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// By lead list
// ---------------------------------------------------------------------------

const LIST_METRICS: MetricColumn<ListMetricsRow>[] = [
  { key: 'dials', header: 'Dials', value: (r) => r.dials, format: (r) => formatNumber(r.dials) },
  { key: 'pickups', header: 'Pickups', value: (r) => r.pickups, format: (r) => formatNumber(r.pickups) },
  { key: 'pickupRate', header: 'Pickup rate', value: (r) => r.pickupRate, format: (r) => formatPercent(r.pickupRate) },
  { key: 'bookings', header: 'Bookings', value: (r) => r.bookings, format: (r) => formatNumber(r.bookings) },
];

export function ListsCard({ rows }: { rows: ListMetricsRow[] }) {
  return (
    <Card className="dz-card dz-lists" padded={false} title="By lead list">
      <MetricsTable
        rows={rows}
        rowKey={(r) => r.listId}
        nameHeader="List"
        name={(r) => r.label}
        nameSort={(r) => r.label}
        nameText={(r) => r.label}
        metrics={LIST_METRICS}
        defaultMetric="dials"
        isZero={(r) => r.dials === 0}
        caption="Metrics by lead list"
        empty="No lead lists yet."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// By phone number
// ---------------------------------------------------------------------------

const NUMBER_METRICS: MetricColumn<NumberMetricsRow>[] = [
  { key: 'dials', header: 'Dials', value: (r) => r.dials, format: (r) => formatNumber(r.dials) },
  { key: 'pickups', header: 'Pickups', value: (r) => r.pickups, format: (r) => formatNumber(r.pickups) },
  { key: 'pickupRate', header: 'Pickup rate', value: (r) => r.pickupRate, format: (r) => formatPercent(r.pickupRate) },
];

/** Higher = worse, so the default (descending) sort puts problems first. */
const HEALTH_SORT: Record<NumberHealth, number> = { flagged: 3, low: 2, ok: 1, too_few: 0 };

export function HealthBadge({ health, ratio }: { health: NumberHealth; ratio: number | null }) {
  const pct = ratio !== null ? `Pickup rate is ${formatPercent(ratio, 0)} of the other numbers' rate.` : undefined;
  switch (health) {
    case 'flagged':
      return (
        <Badge tone="critical" title={pct}>
          Likely spam-flagged
        </Badge>
      );
    case 'low':
      return (
        <Badge tone="warning" title={pct}>
          Below the others
        </Badge>
      );
    case 'ok':
      return (
        <Badge tone="good" title={pct}>
          Healthy
        </Badge>
      );
    default:
      return <Badge title={`Fewer than ${NUMBER_MIN_DIALS} dials in this range, not judged yet.`}>Too few dials</Badge>;
  }
}

function numberName(r: NumberMetricsRow) {
  const phone = formatPhone(r.number);
  return r.label && r.label !== r.number ? `${r.label} · ${phone}` : phone;
}

export function NumbersCard({ id, rows, health }: { id?: string; rows: NumberMetricsRow[]; health: NumberHealthResult }) {
  const status = (r: NumberMetricsRow) => health.byNumber.get(r.number) ?? { health: 'too_few' as NumberHealth, ratio: null };
  const extra: TableColumn<NumberMetricsRow>[] = [
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => HEALTH_SORT[status(r).health],
      render: (r) => <HealthBadge {...status(r)} />,
    },
  ];
  return (
    <Card
      id={id}
      className="dz-card dz-numbers"
      padded={false}
      title={
        <>
          By phone number
          <HelpTip text={`Flagged when a number with at least ${NUMBER_MIN_DIALS} dials picks up at under half the rate of the other numbers.`} />
        </>
      }
      actions={<span className="dz-sub">All numbers: {formatPercent(health.fleetRate)} pickup</span>}
    >
      <MetricsTable
        rows={rows}
        rowKey={(r) => r.number}
        nameHeader="Number"
        name={(r) => (
          <span className="dz-num-name">
            <span>{r.label && r.label !== r.number ? r.label : formatPhone(r.number)}</span>
            {r.label && r.label !== r.number && <span className="dz-sub mono">{formatPhone(r.number)}</span>}
          </span>
        )}
        nameSort={(r) => r.label || r.number}
        nameText={numberName}
        metrics={NUMBER_METRICS}
        defaultMetric="dials"
        isZero={(r) => r.dials === 0}
        extra={extra}
        caption="Metrics by outbound phone number"
        empty="No outbound numbers yet."
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export function OutcomesCard({ outcomes }: { outcomes: OutcomeCount[] }) {
  const tip = useTip();
  const total = outcomes.reduce((s, o) => s + o.count, 0);
  // Nominal categories: ranked largest first (ties keep the wrap-up order).
  const ranked = outcomes.map((o, i) => ({ ...o, i })).sort((a, b) => b.count - a.count || a.i - b.i);
  const max = maxOf(ranked, (o) => o.count);

  const table = (
    <Table
      columns={[
        { key: 'label', header: 'Outcome', render: (o) => o.label },
        { key: 'count', header: 'Count', align: 'right', render: (o) => <span className="num">{formatNumber(o.count)}</span> },
        { key: 'share', header: 'Share', align: 'right', render: (o) => <span className="num">{formatPercent(shareOf(o.count, total))}</span> },
      ]}
      rows={ranked}
      rowKey={(o) => o.disposition}
      dense
      caption="Call outcomes"
    />
  );

  return (
    <ChartCard className="dz-outcomes" title="Outcomes" subtitle={`${formatNumber(total)} calls`} table={table} toggle={total > 0}>
      {total === 0 ? (
        <p className="dz-note">No outcomes were logged in this range.</p>
      ) : (
        <ul className="dz-hbars" aria-label="Outcomes, largest first">
          {ranked.map((o) => {
            const f = scaleFraction(o.count, max);
            const share = formatPercent(shareOf(o.count, total));
            return (
              <li key={o.disposition} className={o.count === 0 ? 'dz-hbar dz-hbar-zero' : 'dz-hbar'}>
                <span className="dz-hbar-label">{o.label}</span>
                <span
                  className="dz-hbar-track"
                  tabIndex={0}
                  aria-label={`${o.label}: ${formatNumber(o.count)}, ${share} of total`}
                  {...tip(
                    <TipRows
                      title={o.label}
                      rows={[
                        { value: formatNumber(o.count), label: 'calls' },
                        { value: share, label: 'of all outcomes' },
                      ]}
                    />,
                  )}
                >
                  {f > 0 && <span className="dz-hbar-fill" style={{ width: `${f * 100}%` }} />}
                </span>
                <span className="dz-hbar-value num">
                  {formatNumber(o.count)} <span className="dz-sub">· {share}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </ChartCard>
  );
}
