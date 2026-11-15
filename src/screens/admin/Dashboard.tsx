import { useEffect, useMemo, useState } from 'react';
import type { Metrics } from '../../types';
import { api, errorMessage } from '../../api';
import { addDays, formatDate, formatPhone, toDateKey } from '../../lib/format';
import { Button, EmptyState, IconAlert, IconFlag, IconStats, PageHeader, Spinner } from '../../components/ui';
import { numberHealth, previousPeriodLabel, rangeDayCount, rangeFromPreset, type RangePreset } from './dashboard/chartMath';
import { FilterBar } from './dashboard/FilterBar';
import { HeadlineTiles } from './dashboard/HeadlineTiles';
import { TrendCard } from './dashboard/TrendCharts';
import { CallersCard, ListsCard, NumbersCard, OutcomesCard } from './dashboard/Breakdowns';
import { LiveView } from './dashboard/LiveView';
import { TipLayer } from './dashboard/shared';
import './dashboard/dashboard.css';

const NUMBERS_ID = 'dz-numbers';

/** "Nov 9 – Nov 15, 2026" for a [from, to) range of whole days. */
function describeRange(from: string, to: string): string {
  const last = addDays(new Date(to), -1);
  const a = formatDate(from);
  const b = formatDate(last);
  return a === b ? a : `${a} - ${b}`;
}

/** Admin dashboard: how the team is doing, and whether anything is going wrong. */
export default function Dashboard() {
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [custom, setCustom] = useState(() => ({ from: toDateKey(addDays(Date.now(), -6)), to: toDateKey(Date.now()) }));
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // `reload` also re-reads the clock so "Today" moves on after midnight.
  const range = useMemo(() => rangeFromPreset(preset, Date.now(), custom), [preset, custom, reload]);
  const customError = preset === 'custom' && !range ? 'Pick a start date on or before the end date.' : null;

  useEffect(() => {
    if (!range) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getMetrics(range)
      .then((m) => {
        if (!alive) return;
        setData(m);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(errorMessage(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range?.from, range?.to, reload]);

  const days = data ? rangeDayCount(data.range) : 1;
  const tileComparison = days === 1 ? (preset === 'today' ? 'vs yesterday' : 'vs prev. day') : `vs prev. ${days} days`;
  const health = useMemo(() => numberHealth(data?.byNumber ?? []), [data]);
  const flagged = data ? data.byNumber.filter((r) => health.byNumber.get(r.number)?.health === 'flagged') : [];
  const noCalls = data !== null && data.totals.dials === 0 && data.totals.talkSeconds === 0 && data.totals.conversations === 0;
  const today = toDateKey(Date.now());
  const rangeText = data ? `${describeRange(data.range.from, data.range.to)} · change ${previousPeriodLabel(days)}` : '';
  const retry = () => setReload((r) => r + 1);

  return (
    <TipLayer>
      <div className="screen dz">
        <PageHeader
          title="Dashboard"
          subtitle={rangeText || 'Team activity'}
          actions={
            <FilterBar
              preset={preset}
              onPreset={setPreset}
              custom={custom}
              onCustom={setCustom}
              customError={customError}
              today={today}
              loading={loading && data !== null}
              onRefresh={retry}
              rangeText=""
            />
          }
        />
        <div className="dz-layout">
          <aside className="dz-area-live" aria-label="Live view">
            <LiveView />
          </aside>

          {!data ? (
            <div className="dz-area-main">
              {error ? (
                <EmptyState
                  icon={<IconAlert size={32} />}
                  title="Could not load the dashboard"
                  message={error}
                  action={
                    <Button variant="primary" onClick={retry}>
                      Retry
                    </Button>
                  }
                />
              ) : (
                <div className="dz-loading">
                  <Spinner size={22} label="Loading metrics" />
                </div>
              )}
            </div>
          ) : (
            <>
              <div className={`dz-area-tiles ${loading ? 'dz-stale' : ''}`} aria-busy={loading || undefined}>
                {error && (
                  <div className="dz-banner dz-banner-error" role="alert">
                    <IconAlert size={16} />
                    <span>Could not refresh: {error}. Showing the last numbers loaded.</span>
                    <Button size="sm" onClick={retry}>
                      Retry
                    </Button>
                  </div>
                )}
                <HeadlineTiles totals={data.totals} previous={data.previousTotals} comparison={tileComparison} />
                {flagged.length > 0 && (
                  <div className="dz-banner dz-banner-critical" role="status">
                    <IconFlag size={16} />
                    <span>
                      <strong>{flagged.length === 1 ? '1 number likely spam-flagged:' : `${flagged.length} numbers likely spam-flagged:`}</strong>{' '}
                      {flagged.map((r) => (r.label && r.label !== r.number ? `${r.label} ${formatPhone(r.number)}` : formatPhone(r.number))).join(', ')}
                      <span className="muted"> (pickup rate far below the other numbers)</span>
                    </span>
                    <Button size="sm" onClick={() => document.getElementById(NUMBERS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                      See numbers
                    </Button>
                  </div>
                )}
              </div>

              <div className={`dz-area-main ${loading ? 'dz-stale' : ''}`} aria-busy={loading || undefined}>
                {noCalls ? (
                  <div className="card dz-card">
                    <EmptyState icon={<IconStats size={32} />} title="No calls in this range" />
                  </div>
                ) : (
                  <>
                    <TrendCard days={data.byDay} />
                    <CallersCard rows={data.byCaller} />
                    <OutcomesCard outcomes={data.outcomes} />
                    <NumbersCard id={NUMBERS_ID} rows={data.byNumber} health={health} />
                    <ListsCard rows={data.byList} />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </TipLayer>
  );
}
