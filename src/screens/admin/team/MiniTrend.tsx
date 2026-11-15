/**
 * Compact daily trend for one person: dials per day and bookings per day as two separate
 * small column charts sharing the same days (never a second y-axis). One hover readout.
 */
import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatNumber } from '../../../lib/format';
import { bandIndexAt, barWidth, clampLabelX, columnPath, formatAxisNumber, niceTicks, thinLabelIndices } from '../dashboard/chartMath';
import { useElementWidth } from '../dashboard/shared';
import type { DayPoint } from './teamPerf';

const LEFT = 36;
const RIGHT = 8;
const TOP = 12;
const AXIS_BAND = 20;
const FONT = 11;

interface PanelDef {
  key: 'dials' | 'bookings';
  title: string;
  plotHeight: number;
}

const PANELS: PanelDef[] = [
  { key: 'dials', title: 'Dials per day', plotHeight: 52 },
  { key: 'bookings', title: 'Bookings per day', plotHeight: 32 },
];

function half(text: string): number {
  return text.length * 3.3 + 2;
}

export function MiniTrend({ points }: { points: DayPoint[] }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState(-1);
  const width = measured > 0 ? measured : 560;
  const n = points.length;
  const band = Math.max(1, width - LEFT - RIGHT) / Math.max(1, n);
  const hovered = hover >= 0 ? points[hover] : null;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(bandIndexAt(e.clientX - rect.left, LEFT, band, n));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      setHover((h) => Math.min(n - 1, Math.max(0, (h < 0 ? n - 1 : h) + dir)));
    } else if (e.key === 'Escape') {
      setHover(-1);
    }
  };

  return (
    <div className="tm-trend">
      <div className="tm-trend-readout" aria-live="polite">
        {hovered ? (
          <>
            <strong>{hovered.label}</strong> · {formatNumber(hovered.dials)} dials · {formatNumber(hovered.bookings)} bookings
          </>
        ) : (
          <span className="muted">
            {formatNumber(points.reduce((s, p) => s + p.dials, 0))} dials · {formatNumber(points.reduce((s, p) => s + p.bookings, 0))} bookings
          </span>
        )}
      </div>
      <div
        ref={ref}
        className="tm-trend-plot"
        tabIndex={0}
        role="group"
        aria-label="Daily trend. Use the left and right arrow keys to read each day."
        onPointerMove={onMove}
        onPointerLeave={() => setHover(-1)}
        onBlur={() => setHover(-1)}
        onKeyDown={onKey}
      >
        {PANELS.map((p, i) => (
          <Panel key={p.key} def={p} points={points} width={width} band={band} hover={hover} showAxis={i === PANELS.length - 1} />
        ))}
      </div>
    </div>
  );
}

function Panel({ def, points, width, band, hover, showAxis }: { def: PanelDef; points: DayPoint[]; width: number; band: number; hover: number; showAxis: boolean }) {
  const values = points.map((p) => p[def.key]);
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  const ticks = niceTicks(max, def.key === 'dials' ? 3 : 1, { integer: true });
  const plotH = def.plotHeight;
  const height = TOP + plotH + (showAxis ? AXIS_BAND : 4);
  const baseY = TOP + plotH;
  const right = width - RIGHT;
  const y = (v: number) => baseY - (ticks.max > 0 ? (v / ticks.max) * plotH : 0);
  const cx = (i: number) => LEFT + band * (i + 0.5);
  const w = barWidth(band);
  let peak = -1;
  if (max > 0) for (let i = 0; i < values.length; i++) if (values[i] === max) peak = i;
  const labels = showAxis ? thinLabelIndices(points.length, right - LEFT, 56) : [];

  return (
    <div className="tm-panel">
      <div className="tm-panel-title">{def.title}</div>
      <svg className="tm-svg" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${def.title}, ${points.length} days, peak ${formatNumber(max)}`}>
        {hover >= 0 && <rect x={LEFT + band * hover} y={TOP - 4} width={band} height={plotH + 4} className="tm-hover-band" />}
        {ticks.ticks.map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={right} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} className={t === 0 ? 'tm-axis' : 'tm-grid'} />
            <text x={LEFT - 6} y={y(t)} className="tm-tick" textAnchor="end" dominantBaseline="middle" fontSize={FONT}>
              {formatAxisNumber(t, ticks.max)}
            </text>
          </g>
        ))}
        {values.map((v, i) => {
          if (v <= 0) return null;
          const h = Math.max(1, baseY - y(v));
          const x = LEFT + band * i + (band - w) / 2;
          return <path key={i} d={columnPath(x, baseY, w, h, 3)} className={i === hover ? 'tm-mark tm-mark-hover' : 'tm-mark'} />;
        })}
        {peak >= 0 && (
          <text x={clampLabelX(cx(peak), half(formatNumber(max)), LEFT, width)} y={y(max) - 4} className="tm-data-label" textAnchor="middle" fontSize={FONT}>
            {formatNumber(max)}
          </text>
        )}
        {labels.map((i) => (
          <text key={i} x={clampLabelX(cx(i), half(points[i].label), LEFT, right)} y={baseY + 14} className="tm-tick" textAnchor="middle" fontSize={FONT}>
            {points[i].label}
          </text>
        ))}
      </svg>
    </div>
  );
}
