import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { CallListRow } from '../../api/Api';
import { Badge, Button, IconChevronLeft, IconChevronRight, IconRefresh, PageHeader, StatTile, Table, Toolbar, type TableColumn } from '../../components/ui';
import { CALL_RESULT_LABELS, dispositionInfo, type MetricsTotals, type Paged } from '../../types';
import { formatDateTime, formatDurationLong, formatDuration, formatNumber, formatPercent, formatPhone } from '../../lib/format';
import './caller.css';

const PAGE_SIZE = 25;

const columns: TableColumn<CallListRow>[] = [
  { key: 'time', header: 'Time', render: (r) => <span className="num">{formatDateTime(r.startedAt)}</span> },
  {
    key: 'business',
    header: 'Business',
    render: (r) => {
      const other = r.direction === 'inbound' ? r.fromNumber : r.toNumber;
      return (
        <span className="row">
          <span className="ms-business">{r.businessName || formatPhone(other)}</span>
          {r.direction === 'inbound' && <span className="cell-sub">(inbound)</span>}
          {r.ring === 2 && <span className="cell-sub">(2nd ring)</span>}
        </span>
      );
    },
  },
  { key: 'result', header: 'Result', render: (r) => (r.result ? CALL_RESULT_LABELS[r.result] : <span className="muted">In progress</span>) },
  {
    key: 'outcome',
    header: 'Outcome',
    render: (r) => {
      if (!r.disposition) return <span className="muted">-</span>;
      const d = dispositionInfo(r.disposition);
      return <Badge tone={d.tone}>{d.label}</Badge>;
    },
  },
  { key: 'talk', header: 'Talk time', align: 'right', render: (r) => <span className="num">{r.talkSeconds > 0 ? formatDuration(r.talkSeconds) : '-'}</span> },
  {
    key: 'notes',
    header: 'Notes',
    render: (r) =>
      r.notes ? (
        <span className="ms-notes" title={r.notes}>
          {r.notes}
        </span>
      ) : (
        <span className="muted">-</span>
      ),
  },
];

/** The caller's own numbers for today and their recent calls. */
export default function MyStats() {
  const [stats, setStats] = useState<MetricsTotals | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [calls, setCalls] = useState<Paged<CallListRow> | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadStats = useCallback(async () => {
    setStatsError(null);
    try {
      setStats(await api.getMyStatsToday());
    } catch (e) {
      setStatsError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    let alive = true;
    setLoadingCalls(true);
    setCallsError(null);
    api
      .listCalls({ page, pageSize: PAGE_SIZE })
      .then((r) => {
        if (alive) setCalls(r);
      })
      .catch((e) => {
        if (alive) setCallsError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoadingCalls(false);
      });
    return () => {
      alive = false;
    };
  }, [page, reloadKey]);

  const total = calls?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  const dash = '-';

  return (
    <div className="screen">
      <PageHeader
        title="My stats"
        subtitle="Today since midnight"
        actions={
          <Button
            icon={<IconRefresh size={14} />}
            loading={loadingCalls && calls !== null}
            onClick={() => {
              void loadStats();
              setReloadKey((k) => k + 1);
            }}
          >
            Refresh
          </Button>
        }
      />

      {statsError && (
        <div className="form-error" role="alert">
          Could not load today's numbers. {statsError}
        </div>
      )}
      <section aria-label="Today" className="stat-grid">
        <StatTile label="Dials" value={stats ? formatNumber(stats.dials) : dash} />
        <StatTile label="Pickups" value={stats ? formatNumber(stats.pickups) : dash} sub={stats ? `${formatPercent(stats.pickupRate)} rate` : undefined} />
        <StatTile label="Conversations" value={stats ? formatNumber(stats.conversations) : dash} sub="20 s or longer" />
        <StatTile label="Bookings" value={stats ? formatNumber(stats.bookings) : dash} />
        <StatTile label="Talk time" value={stats ? formatDurationLong(stats.talkSeconds) : dash} />
      </section>

      <section className="data-panel" aria-label="Recent calls">
        <Toolbar
          count={
            <>
              <strong>Recent calls</strong>
              {total > 0 ? ` · ${formatNumber(total)}` : ''}
            </>
          }
          right={
            <>
              <span className="tb-count">{total > 0 ? `${formatNumber(first)}-${formatNumber(last)} of ${formatNumber(total)}` : ''}</span>
              <div className="btn-group">
                <Button size="sm" icon={<IconChevronLeft size={13} />} disabled={page <= 1 || loadingCalls} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Newer
                </Button>
                <Button size="sm" disabled={page >= pages || loadingCalls} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                  Older <IconChevronRight size={13} />
                </Button>
              </div>
            </>
          }
        />
        {callsError && (
          <div className="form-error ms-error" role="alert">
            Could not load your calls. {callsError}
          </div>
        )}
        <Table
          caption="Your recent calls"
          columns={columns}
          rows={calls?.rows ?? []}
          rowKey={(r) => r.id}
          dense
          empty={calls ? 'No calls yet' : 'Loading calls'}
        />
      </section>
    </div>
  );
}
