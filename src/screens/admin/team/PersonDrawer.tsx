/** One person's page: details, numbers for the range vs the previous period, trend, endings, calls. */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../../../api';
import type { CallListRow } from '../../../api/Api';
import { Badge, Button, Drawer, FieldGrid, IconChevronUp, IconPlay, MetricDelta, MetricsBand, SectionHeading, Spinner } from '../../../components/ui';
import { formatDate, formatDateTime, formatDuration, formatNumber, formatPercent, formatPhone } from '../../../lib/format';
import { displayLogin } from '../../../lib/login';
import { PRESENCE_LABELS, type MetricsRange, type MetricsTotals, type PresenceStatus, type Profile } from '../../../types';
import { formatHoursMinutes, maxOf, scaleFraction, shareOf } from '../dashboard/chartMath';
import { MiniTrend } from './MiniTrend';
import { metricsCache } from './metricsSource';
import {
  assembleSeries,
  callEnding,
  callerTotals,
  comparisonLabel,
  countEndings,
  dayCount,
  daySlots,
  hasActivity,
  headlineDelta,
  mapLimit,
  previousRange,
  trendDayCount,
  type DayPoint,
  type EndingCount,
  type HeadlineKey,
  type TeamRange,
} from './teamPerf';

const PAGE_SIZE = 15;
const ALL_PAGE = 1000;
const ALL_MAX_PAGES = 10;

const HEADLINES: { key: HeadlineKey; label: string; value: (t: MetricsTotals) => string; title?: string }[] = [
  { key: 'dials', label: 'Dials', value: (t) => formatNumber(t.dials) },
  { key: 'pickups', label: 'Pickups', value: (t) => formatNumber(t.pickups), title: 'Pickups: a person answered the phone' },
  { key: 'pickupRate', label: 'Pickup rate', value: (t) => formatPercent(t.pickupRate) },
  { key: 'conversations', label: 'Conversations', value: (t) => formatNumber(t.conversations), title: 'Conversations: connected and talked 20 seconds or more' },
  { key: 'bookings', label: 'Bookings', value: (t) => formatNumber(t.bookings) },
  { key: 'talkSeconds', label: 'Talk time', value: (t) => formatHoursMinutes(t.talkSeconds) },
];

export interface PersonDrawerProps {
  user: Profile | null;
  isSelf: boolean;
  rangeId: TeamRange;
  range: MetricsRange;
  rangeLabel: string;
  live: PresenceStatus | null;
  /** Bumped by Refresh on the screen. */
  reloadKey: number;
  onClose: () => void;
  onEdit: (u: Profile) => void;
  onPassword: (u: Profile) => void;
  onToggle: (u: Profile) => void;
}

type Load<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: T };

/** Runs `fn` whenever deps change; returns the latest result and a retry. */
function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]): [Load<T> | null, () => void] {
  const [result, setResult] = useState<Load<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!fn) {
      setResult(null);
      return;
    }
    let alive = true;
    setResult((r) => (r && r.state === 'ok' ? r : { state: 'loading' }));
    fn().then(
      (data) => alive && setResult({ state: 'ok', data }),
      (e: unknown) => alive && setResult({ state: 'error', error: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
  }, [...deps, attempt]);
  return [result, () => setAttempt((a) => a + 1)];
}

export function PersonDrawer({ user, isSelf, rangeId, range, rangeLabel, live, reloadKey, onClose, onEdit, onPassword, onToggle }: PersonDrawerProps) {
  const isCaller = user?.role === 'caller';
  const id = user?.id ?? '';
  const days = dayCount(range);

  // Headline numbers: this range and the previous one of the same length.
  const [headline, retryHeadline] = useLoad(
    isCaller
      ? async () => {
          const [cur, prev] = await Promise.all([metricsCache.get(range), metricsCache.get(previousRange(range))]);
          return { cur: callerTotals(cur, id), prev: callerTotals(prev, id) };
        }
      : null,
    [id, isCaller, range.from, range.to, reloadKey],
  );

  // Daily trend: one getMetrics per day, cached and run in parallel.
  const [trend, retryTrend] = useLoad<DayPoint[]>(
    isCaller
      ? async () => {
          const slots = daySlots(Date.parse(range.to) - 1, trendDayCount(rangeId));
          const res = await mapLimit(slots, 6, (s) => metricsCache.get(s.range));
          const failed = res.find((r) => r.status === 'rejected');
          if (failed && failed.status === 'rejected') throw failed.reason;
          const byDate = new Map(slots.map((s, i) => [s.date, res[i].status === 'fulfilled' ? res[i].value : undefined]));
          return assembleSeries(slots, byDate, id);
        }
      : null,
    [id, isCaller, rangeId, range.to, reloadKey],
  );

  // How calls ended: every call in the range (capped).
  const [endings, retryEndings] = useLoad<{ counts: EndingCount[]; counted: number; total: number }>(
    isCaller
      ? async () => {
          const rows: CallListRow[] = [];
          let total = 0;
          for (let page = 1; page <= ALL_MAX_PAGES; page++) {
            const res = await api.listCalls({ callerId: id, from: range.from, to: range.to, page, pageSize: ALL_PAGE });
            total = res.total;
            rows.push(...res.rows);
            if (res.rows.length < ALL_PAGE || rows.length >= total) break;
          }
          return { counts: countEndings(rows), counted: rows.length, total };
        }
      : null,
    [id, isCaller, range.from, range.to, reloadKey],
  );

  // Last call ever (any range).
  const [lastCall] = useLoad(user ? async () => (await api.listCalls({ callerId: id, page: 1, pageSize: 1 })).rows[0] ?? null : null, [id, reloadKey]);

  // Recent calls, paginated.
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [id, range.from, range.to]);
  const [calls, retryCalls] = useLoad(
    isCaller ? () => api.listCalls({ callerId: id, from: range.from, to: range.to, page, pageSize: PAGE_SIZE }) : null,
    [id, isCaller, range.from, range.to, page, reloadKey],
  );

  if (!user) return null;

  const noCalls = headline?.state === 'ok' && !hasActivity(headline.data.cur) && endings?.state === 'ok' && endings.data.total === 0;

  return (
    <Drawer
      open
      onClose={onClose}
      width={680}
      title={
        <>
          {user.fullName}
          {isSelf && <span className="cell-sub"> (you)</span>}
        </>
      }
      subtitle={`${displayLogin(user.email)} · ${user.role === 'admin' ? 'Admin' : 'Caller'}`}
      headerActions={<Badge tone={user.active ? 'good' : 'neutral'}>{user.active ? 'Active' : 'Deactivated'}</Badge>}
      footer={
        <>
          <Button onClick={() => onEdit(user)}>Edit</Button>
          <Button onClick={() => onPassword(user)}>Reset password</Button>
          {!isSelf && (
            <Button onClick={() => onToggle(user)}>
              {user.active ? 'Deactivate' : 'Reactivate'}
            </Button>
          )}
        </>
      }
    >
      <div className="tm-drawer">
        {!user.active && (
          <div className="tm-inactive" role="status">
            <span>Deactivated. Can't sign in or get new leads.</span>
            {!isSelf && (
              <Button size="sm" onClick={() => onToggle(user)}>
                Reactivate
              </Button>
            )}
          </div>
        )}

        <FieldGrid
          columns={2}
          items={[
            { key: 'username', label: 'Username', value: displayLogin(user.email) },
            { key: 'role', label: 'Role', value: user.role === 'admin' ? 'Admin' : 'Caller' },
            { key: 'status', label: 'Status', value: user.active ? 'Active' : 'Deactivated' },
            { key: 'live', label: 'Live', value: live ? <LiveText status={live} /> : <span className="muted">-</span> },
            { key: 'added', label: 'Added', value: formatDate(user.createdAt) },
            {
              key: 'last',
              label: 'Last call',
              value: !lastCall || lastCall.state === 'loading' ? <span className="muted">-</span> : lastCall.state === 'error' ? <span className="muted">-</span> : lastCall.data ? formatDateTime(lastCall.data.startedAt) : 'Never',
            },
          ]}
        />

        {!isCaller ? null : (
          <>
            <SectionHeading as="h3" actions={<span className="tm-sub">{comparisonLabel(rangeId, days)}</span>}>
              {rangeLabel}
            </SectionHeading>
            <Section load={headline} retry={retryHeadline} what="numbers">
              {(d) => (
                <MetricsBand
                  className="tm-band"
                  metrics={HEADLINES.map((h) => {
                    const delta = headlineDelta(h.key, d.cur, d.prev);
                    return {
                      key: h.key,
                      label: h.label,
                      value: h.value(d.cur),
                      title: h.title,
                      sub: delta.kind === 'note' ? <span>{delta.text}</span> : <MetricDelta text={delta.text} tone={delta.tone} direction={delta.direction} />,
                    };
                  })}
                />
              )}
            </Section>

            <SectionHeading as="h3" actions={<span className="tm-sub">Last {trendDayCount(rangeId)} days</span>}>
              Daily trend
            </SectionHeading>
            <Section load={trend} retry={retryTrend} what="the trend">
              {(points) => <MiniTrend points={points} />}
            </Section>

            {noCalls ? (
              <p className="tm-empty">No calls in this range.</p>
            ) : (
              <>
                <SectionHeading
                  as="h3"
                  actions={
                    endings?.state === 'ok' ? (
                      <span className="tm-sub">
                        {endings.data.counted < endings.data.total
                          ? `Latest ${formatNumber(endings.data.counted)} of ${formatNumber(endings.data.total)} calls`
                          : `${formatNumber(endings.data.total)} ${endings.data.total === 1 ? 'call' : 'calls'}`}
                      </span>
                    ) : undefined
                  }
                >
                  How calls ended
                </SectionHeading>
                <Section load={endings} retry={retryEndings} what="outcomes">
                  {(d) => (d.counts.length === 0 ? <p className="tm-empty">No calls in this range.</p> : <EndingBars counts={d.counts} />)}
                </Section>

                <SectionHeading as="h3" actions={calls?.state === 'ok' && calls.data.total > PAGE_SIZE ? <Pager page={page} total={calls.data.total} onPage={setPage} /> : undefined}>
                  Calls
                </SectionHeading>
                <Section load={calls} retry={retryCalls} what="calls">
                  {(d) => (d.rows.length === 0 ? <p className="tm-empty">No calls in this range.</p> : <CallsTable rows={d.rows} />)}
                </Section>
              </>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function Section<T>({ load, retry, what, children }: { load: Load<T> | null; retry: () => void; what: string; children: (d: T) => ReactNode }) {
  if (!load || load.state === 'loading')
    return (
      <div className="tm-loading">
        <Spinner size={16} label={`Loading ${what}`} />
      </div>
    );
  if (load.state === 'error')
    return (
      <div className="tm-error" role="alert">
        <span>
          Could not load {what}: {load.error}
        </span>
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  return <>{children(load.data)}</>;
}

export function LiveText({ status }: { status: PresenceStatus }) {
  return <span className={`tm-live tm-live-${status}`}>{PRESENCE_LABELS[status]}</span>;
}

function EndingBars({ counts }: { counts: EndingCount[] }) {
  const total = counts.reduce((s, c) => s + c.count, 0);
  const max = maxOf(counts, (c) => c.count);
  return (
    <ul className="tm-hbars" aria-label="How calls ended, largest first">
      {counts.map((c) => {
        const f = scaleFraction(c.count, max);
        const share = formatPercent(shareOf(c.count, total));
        return (
          <li key={c.key} className="tm-hbar" title={`${c.label}: ${formatNumber(c.count)} (${share})`}>
            <span className="tm-hbar-label">{c.label}</span>
            <span className="tm-hbar-track">{f > 0 && <span className="tm-hbar-fill" style={{ width: `${f * 100}%` }} />}</span>
            <span className="tm-hbar-value num">
              {formatNumber(c.count)} <span className="tm-sub">· {share}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  return (
    <span className="tm-pager">
      <span className="tm-sub num">
        {from}-{to} of {formatNumber(total)}
      </span>
      <span className="btn-group">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </span>
    </span>
  );
}

function isTelnyxRef(url: string | null): boolean {
  return !!url && url.startsWith('telnyx-recording:');
}

function CallsTable({ rows }: { rows: CallListRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [audio, setAudio] = useState<{ id: string; src: string | null; error: string } | null>(null);
  const ids = useMemo(() => rows.map((r) => r.id).join(), [rows]);
  useEffect(() => {
    setOpen(null);
    setAudio(null);
  }, [ids]);

  const play = async (c: CallListRow) => {
    if (open === c.id) {
      setOpen(null);
      setAudio(null);
      return;
    }
    setOpen(c.id);
    if (!isTelnyxRef(c.recordingUrl)) {
      setAudio({ id: c.id, src: c.recordingUrl, error: '' });
      return;
    }
    setAudio({ id: c.id, src: null, error: '' });
    try {
      const { resolveRecordingUrl } = await import('../../../telephony/telnyxAdmin');
      const src = await resolveRecordingUrl(c.id, c.recordingUrl);
      setAudio((a) => (a && a.id === c.id ? { id: c.id, src, error: src ? '' : 'No recording' } : a));
    } catch (e) {
      setAudio((a) => (a && a.id === c.id ? { id: c.id, src: null, error: errorMessage(e) } : a));
    }
  };

  return (
    <div className="table-wrap tm-calls">
      <table className="table dense">
        <caption className="visually-hidden">Calls</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Business</th>
            <th scope="col">Result</th>
            <th scope="col" className="align-right">
              Talk
            </th>
            <th scope="col">Notes</th>
            <th scope="col">
              <span className="visually-hidden">Recording</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const isOpen = open === c.id;
            const business = c.businessName ?? formatPhone(c.direction === 'inbound' ? c.fromNumber : c.toNumber);
            return (
              <Fragment key={c.id}>
                <tr className={isOpen ? 'selected' : undefined}>
                  <td className="num tm-nowrap">{formatDateTime(c.startedAt)}</td>
                  <td className="cell-truncate tm-biz" title={business}>
                    {business}
                    {c.direction === 'inbound' && <span className="cell-sub"> (inbound)</span>}
                  </td>
                  <td className="cell-truncate tm-result" title={callEnding(c).label}>
                    {callEnding(c).label}
                  </td>
                  <td className="align-right num">{c.talkSeconds > 0 ? formatDuration(c.talkSeconds) : <span className="muted">-</span>}</td>
                  <td className="cell-truncate tm-notes" title={c.notes || undefined}>
                    {c.notes || <span className="muted">-</span>}
                  </td>
                  <td className="align-right">
                    {c.recordingUrl && (
                      <Button
                        size="sm"
                        variant={isOpen ? 'secondary' : 'ghost'}
                        icon={isOpen ? <IconChevronUp size={13} /> : <IconPlay size={13} />}
                        aria-expanded={isOpen}
                        aria-label={isOpen ? 'Hide recording' : `Play recording, ${business}`}
                        onClick={() => void play(c)}
                      >
                        {isOpen ? 'Hide' : 'Play'}
                      </Button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="tm-player-row">
                    <td colSpan={6}>
                      {audio?.error ? (
                        <span className="tm-error-text">{audio.error}</span>
                      ) : audio?.src ? (
                        <audio controls autoPlay preload="auto" src={audio.src} />
                      ) : (
                        <Spinner size={14} label="Loading recording" />
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
