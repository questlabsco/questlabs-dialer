/** The single filter row: date-range presets, custom dates, refresh and loading state. */
import { IconButton, IconRefresh, Spinner } from '../../../components/ui';
import { RANGE_PRESETS, type RangePreset } from './chartMath';

export interface FilterBarProps {
  preset: RangePreset;
  onPreset: (p: RangePreset) => void;
  custom: { from: string; to: string };
  onCustom: (c: { from: string; to: string }) => void;
  /** Error for an invalid custom range, shown inline. */
  customError: string | null;
  /** 'YYYY-MM-DD' of today (max for the date inputs). */
  today: string;
  loading: boolean;
  onRefresh: () => void;
  /** e.g. "Nov 9 – Nov 15, 2026". */
  rangeText: string;
}

export function FilterBar({ preset, onPreset, custom, onCustom, customError, today, loading, onRefresh, rangeText }: FilterBarProps) {
  return (
    <div className="dz-filter" role="group" aria-label="Date range">
      <div className="dz-seg">
        {RANGE_PRESETS.map((p) => (
          <button key={p.id} type="button" className="dz-seg-btn" aria-pressed={preset === p.id} onClick={() => onPreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="dz-custom">
          <label className="dz-date">
            <span>From</span>
            <input
              type="date"
              className="input"
              value={custom.from}
              max={custom.to || today}
              aria-invalid={customError ? true : undefined}
              onChange={(e) => onCustom({ ...custom, from: e.target.value })}
            />
          </label>
          <label className="dz-date">
            <span>To</span>
            <input
              type="date"
              className="input"
              value={custom.to}
              min={custom.from || undefined}
              max={today}
              aria-invalid={customError ? true : undefined}
              onChange={(e) => onCustom({ ...custom, to: e.target.value })}
            />
          </label>
        </div>
      )}
      <div className="dz-filter-status">
        {customError ? (
          <span className="dz-filter-error" role="alert">
            {customError}
          </span>
        ) : rangeText ? (
          <span className="dz-range-text">{rangeText}</span>
        ) : null}
        {loading && <Spinner size={14} label="Updating" />}
        <IconButton label="Refresh" variant="secondary" icon={<IconRefresh size={14} />} onClick={onRefresh} disabled={loading} />
      </div>
    </div>
  );
}
