import type { ReactNode } from 'react';
import { IconArrowDown, IconArrowUp } from './icons';

export interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value. */
  sub?: ReactNode;
  /** Relative change vs previous period as a fraction (0.12 = +12%); null/undefined hides it. */
  delta?: number | null;
  /** Set true when a decrease is good (e.g. dropped pickups). */
  invertDelta?: boolean;
  /** Text after the delta chip. Default "vs prev."; pass '' to hide. */
  deltaLabel?: ReactNode;
  /** Small icon before the label. */
  icon?: ReactNode;
}

export function StatTile({ label, value, sub, delta, invertDelta, deltaLabel = 'vs prev.', icon }: StatTileProps) {
  let deltaEl: ReactNode = null;
  if (delta !== undefined && delta !== null && Number.isFinite(delta)) {
    const up = delta > 0;
    const flat = Math.round(delta * 100) === 0;
    const good = invertDelta ? !up : up;
    const cls = flat ? '' : good ? 'up' : 'down';
    const pct = Math.abs(delta * 100).toFixed(0);
    deltaEl = (
      <>
        <span className={`stat-delta ${cls}`.trim()} title={`${up ? '+' : delta < 0 ? '-' : ''}${pct}% ${typeof deltaLabel === 'string' ? deltaLabel : ''}`.trim()}>
          {!flat && (up ? <IconArrowUp size={12} strokeWidth={2.4} /> : <IconArrowDown size={12} strokeWidth={2.4} />)}
          {flat ? '0' : pct}%
        </span>
        {deltaLabel !== '' && sub === undefined && <span className="stat-delta-label">{deltaLabel}</span>}
      </>
    );
  }
  return (
    <div className="stat-tile">
      <div className="label">
        {icon}
        {label}
      </div>
      <div className="value">{value}</div>
      {(sub !== undefined || deltaEl) && (
        <div className="sub">
          {deltaEl}
          {sub !== undefined && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
}
