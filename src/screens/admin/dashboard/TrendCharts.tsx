/**
 * Daily trend as three small multiples sharing one x-axis (never a second y-axis):
 * dials per day (columns), pickup rate per day (line), bookings per day (columns).
 * One crosshair band and one tooltip cover all three.
 */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { DayMetricsRow } from '../../../types';
import { formatNumber, formatPercent } from '../../../lib/format';
import { Table, type TableColumn } from '../../../components/ui';
import {
  bandIndexAt,
  barWidth,
  clampLabelX,
  columnPath,
  formatAxisNumber,
  formatAxisPercent,
  niceTicks,
  placeTooltip,
  splitRuns,
  thinLabelIndices,
  type Ticks,
} from './chartMath';
import { ChartCard, useElementWidth } from './shared';

const LEFT = 44;
const RIGHT = 14;
const TOP = 14;
const AXIS_BAND = 22;
const TIP_WIDTH = 176;
const TICK_FONT = 11;

type PanelKind = 'column' | 'line';

interface Panel {
  key: string;
  title: string;
  kind: PanelKind;
  plotHeight: number;
  value: (d: DayMetricsRow) => number | null;
  ticks: (max: number) => Ticks;
  tick: (v: number, t: Ticks) => string;
  label: (v: number) => string;
}

const PANELS: Panel[] = [
  {
    key: 'dials',
    title: 'Dials per day',
    kind: 'column',
    plotHeight: 64,
    value: (d) => d.dials,
    ticks: (max) => niceTicks(max, 4, { integer: true }),
    tick: (v, t) => formatAxisNumber(v, t.max),
    label: (v) => formatNumber(v),
  },
  {
    key: 'rate',
    title: 'Pickup rate per day',
    kind: 'line',
    plotHeight: 34,
    // No dials that day -> no rate (a gap in the line, not a drop to 0%).
    value: (d) => (d.dials > 0 ? d.pickupRate : null),
    ticks: (max) => niceTicks(max, 2, { fallbackMax: 0.1 }),
    tick: (v, t) => formatAxisPercent(v, t.step),
    label: (v) => formatPercent(v),
  },
  {
    key: 'bookings',
    title: 'Bookings per day',
    kind: 'column',
    plotHeight: 34,
    value: (d) => d.bookings,
    ticks: (max) => niceTicks(max, 2, { integer: true }),
    tick: (v, t) => formatAxisNumber(v, t.max),
    label: (v) => formatNumber(v),
  },
];

/** "2026-11-09" -> "Nov 9". */
function shortDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function TrendCard({ days }: { days: DayMetricsRow[] }) {
  if (days.length <= 1) {
    return (
      <ChartCard className="dz-trendcard" title="Daily trend" table={null} toggle={false}>
        <p className="dz-note">A single day is selected. Choose a longer range for the trend.</p>
      </ChartCard>
    );
  }
  return (
    <ChartCard className="dz-trendcard" title="Daily trend" table={<TrendTable days={days} />}>
      <TrendStack days={days} />
    </ChartCard>
  );
}

function TrendTable({ days }: { days: DayMetricsRow[] }) {
  const columns: TableColumn<DayMetricsRow>[] = [
    { key: 'label', header: 'Day', render: (d) => d.label },
    { key: 'dials', header: 'Dials', align: 'right', render: (d) => <span className="num">{formatNumber(d.dials)}</span> },
    { key: 'pickups', header: 'Pickups', align: 'right', render: (d) => <span className="num">{formatNumber(d.pickups)}</span> },
    { key: 'rate', header: 'Pickup rate', align: 'right', render: (d) => <span className="num">{d.dials ? formatPercent(d.pickupRate) : '-'}</span> },
    { key: 'conv', header: 'Conversations', align: 'right', render: (d) => <span className="num">{formatNumber(d.conversations)}</span> },
    { key: 'bookings', header: 'Bookings', align: 'right', render: (d) => <span className="num">{formatNumber(d.bookings)}</span> },
  ];
  return (
    <div className="dz-scroll">
      <Table columns={columns} rows={days} rowKey={(d) => d.date} dense caption="Daily trend" />
    </div>
  );
}

function TrendStack({ days }: { days: DayMetricsRow[] }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState(-1);
  const width = measured > 0 ? measured : 600;
  const n = days.length;
  const plotW = Math.max(1, width - LEFT - RIGHT);
  const band = plotW / n;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(bandIndexAt(e.clientX - rect.left, LEFT, band, n));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h < 0 ? n - 1 : h) + dir)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHover(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape') {
      setHover(-1);
    }
  };

  const hovered = hover >= 0 ? days[hover] : null;
  const tipLeft = hover >= 0 ? placeTooltip(LEFT + band * (hover + 0.5), TIP_WIDTH, width) : 0;

  return (
    <div
      ref={ref}
      className="dz-trend"
      tabIndex={0}
      role="group"
      aria-label="Daily trend charts. Use the left and right arrow keys to read each day; the same numbers are in the table view."
      onPointerMove={onMove}
      onPointerLeave={() => setHover(-1)}
      onFocus={() => setHover((h) => (h < 0 ? n - 1 : h))}
      onBlur={() => setHover(-1)}
      onKeyDown={onKey}
    >
      {PANELS.map((p, i) => (
        <PanelSvg key={p.key} panel={p} days={days} width={width} band={band} hover={hover} showAxis={i === PANELS.length - 1} />
      ))}
      {hovered && (
        <div className="dz-tooltip dz-trend-tip" style={{ left: tipLeft, width: TIP_WIDTH }} aria-live="polite">
          <div className="dz-tip-title">{hovered.label}</div>
          <div className="dz-tip-row">
            <span className="dz-tip-value">{formatNumber(hovered.dials)}</span>
            <span className="dz-tip-label">dials</span>
          </div>
          <div className="dz-tip-row">
            <span className="dz-tip-value">{formatNumber(hovered.pickups)}</span>
            <span className="dz-tip-label">pickups</span>
          </div>
          <div className="dz-tip-row">
            <span className="dz-tip-value">{hovered.dials ? formatPercent(hovered.pickupRate) : '-'}</span>
            <span className="dz-tip-label">pickup rate</span>
          </div>
          <div className="dz-tip-row">
            <span className="dz-tip-value">{formatNumber(hovered.bookings)}</span>
            <span className="dz-tip-label">bookings</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PanelSvg({
  panel,
  days,
  width,
  band,
  hover,
  showAxis,
}: {
  panel: Panel;
  days: DayMetricsRow[];
  width: number;
  band: number;
  hover: number;
  showAxis: boolean;
}) {
  const n = days.length;
  const values = days.map(panel.value);
  let max = 0;
  for (const v of values) if (v !== null && v > max) max = v;
  const ticks = panel.ticks(max);
  const plotH = panel.plotHeight;
  const height = TOP + plotH + (showAxis ? AXIS_BAND : 6);
  const baseY = TOP + plotH;
  const y = (v: number) => baseY - (ticks.max > 0 ? (v / ticks.max) * plotH : 0);
  const cx = (i: number) => LEFT + band * (i + 0.5);
  const right = width - RIGHT;

  // Direct label: the extreme (latest occurrence of the max) for columns, the last point for the line.
  let labelIdx = -1;
  if (panel.kind === 'column') {
    if (max > 0) for (let i = 0; i < n; i++) if (values[i] === max) labelIdx = i;
  } else {
    for (let i = n - 1; i >= 0; i--)
      if (values[i] !== null) {
        labelIdx = i;
        break;
      }
  }

  const xLabels = showAxis ? thinLabelIndices(n, right - LEFT, 64) : [];

  return (
    <div className="dz-panel">
      <div className="dz-panel-title">{panel.title}</div>
      <svg className="dz-svg" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${panel.title}, ${n} days`}>
        {/* Hover wash for the day under the pointer */}
        {hover >= 0 && <rect x={LEFT + band * hover} y={TOP - 4} width={band} height={plotH + 4} className="dz-hover-band" />}

        {/* Grid + y ticks */}
        {ticks.ticks.map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 ? 'dz-axis' : 'dz-grid'} />
            <text x={LEFT - 6} y={y(t)} className="dz-tick" textAnchor="end" dominantBaseline="middle" fontSize={TICK_FONT}>
              {panel.tick(t, ticks)}
            </text>
          </g>
        ))}

        {panel.kind === 'column' ? (
          <Columns values={values} band={band} baseY={baseY} y={y} hover={hover} />
        ) : (
          <Line values={values} cx={cx} y={y} baseY={baseY} hover={hover} />
        )}

        {/* Direct label */}
        {labelIdx >= 0 && values[labelIdx] !== null && (
          <text
            x={clampLabelX(cx(labelIdx), estimateHalf(panel.label(values[labelIdx]!)), LEFT, width)}
            y={y(values[labelIdx]!) - (panel.kind === 'line' ? 8 : 5)}
            className="dz-data-label"
            textAnchor="middle"
            fontSize={TICK_FONT}
          >
            {panel.label(values[labelIdx]!)}
          </text>
        )}

        {/* Shared x-axis labels, bottom panel only */}
        {xLabels.map((i) => (
          <text
            key={i}
            x={clampLabelX(cx(i), estimateHalf(shortDate(days[i].date)), LEFT, right)}
            y={baseY + 15}
            className="dz-tick"
            textAnchor="middle"
            fontSize={TICK_FONT}
          >
            {shortDate(days[i].date)}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** Rough half-width of an 11px label (enough to keep it inside the plot). */
function estimateHalf(text: string): number {
  return text.length * 3.3 + 2;
}

function Columns({
  values,
  band,
  baseY,
  y,
  hover,
}: {
  values: (number | null)[];
  band: number;
  baseY: number;
  y: (v: number) => number;
  hover: number;
}) {
  const w = barWidth(band);
  return (
    <g>
      {values.map((v, i) => {
        if (v === null || v <= 0) return null;
        const h = baseY - y(v);
        const x = LEFT + band * i + (band - w) / 2;
        return <path key={i} d={columnPath(x, baseY, w, Math.max(1, h))} className={i === hover ? 'dz-mark dz-mark-hover' : 'dz-mark'} />;
      })}
    </g>
  );
}

function Line({
  values,
  cx,
  y,
  baseY,
  hover,
}: {
  values: (number | null)[];
  cx: (i: number) => number;
  y: (v: number) => number;
  baseY: number;
  hover: number;
}) {
  const runs = splitRuns(values);
  let last = -1;
  for (let i = values.length - 1; i >= 0; i--)
    if (values[i] !== null) {
      last = i;
      break;
    }
  const pt = (i: number, v: number) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
  return (
    <g>
      {runs.map((r) =>
        r.values.length >= 2 ? (
          <g key={r.start}>
            <path
              className="dz-area"
              d={`M${cx(r.start).toFixed(1)},${baseY} ${r.values.map((v, k) => `L${pt(r.start + k, v)}`).join(' ')} L${cx(r.start + r.values.length - 1).toFixed(1)},${baseY} Z`}
            />
            <path className="dz-line" d={r.values.map((v, k) => `${k === 0 ? 'M' : 'L'}${pt(r.start + k, v)}`).join(' ')} />
          </g>
        ) : (
          <circle key={r.start} className="dz-dot-small" cx={cx(r.start)} cy={y(r.values[0])} r={3} />
        ),
      )}
      {last >= 0 && last !== hover && <circle className="dz-dot" cx={cx(last)} cy={y(values[last]!)} r={4} />}
      {hover >= 0 && values[hover] !== null && <circle className="dz-dot dz-dot-hover" cx={cx(hover)} cy={y(values[hover]!)} r={5} />}
    </g>
  );
}
