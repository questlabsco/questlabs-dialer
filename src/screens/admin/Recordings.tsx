import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { CallListRow } from '../../api/Api';
import { Badge, Button, EmptyState, IconChevronUp, IconPlay, IconRecordings, Input, PageHeader, Select, Spinner, Toolbar } from '../../components/ui';
import { addDays, formatDateTime, formatDuration, formatPhone, startOfDay, toDateKey } from '../../lib/format';
import { dispositionInfo, type Profile } from '../../types';
import { RecordingPlayer } from './recordings/RecordingPlayer';
import './recordings/recordings.css';

const PAGE_SIZE = 25;

/** 'YYYY-MM-DD' (local) -> ISO at local midnight, or undefined. */
function dateKeyToIso(key: string, plusDays = 0): string | undefined {
  if (!key) return undefined;
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return addDays(new Date(y, m - 1, d), plusDays).toISOString();
}

/** Admin: listen to recorded calls, filtered by caller and date. */
export default function Recordings() {
  const [users, setUsers] = useState<Profile[]>([]);
  const [callerId, setCallerId] = useState('');
  const [fromKey, setFromKey] = useState(() => toDateKey(addDays(startOfDay(Date.now()), -6)));
  const [toKey, setToKey] = useState(() => toDateKey(Date.now()));
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<CallListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    api.listUsers().then(setUsers, () => undefined);
  }, []);

  useEffect(() => {
    setPage(1);
    setExpanded(null);
  }, [callerId, fromKey, toKey]);

  const rangeError = fromKey && toKey && fromKey > toKey ? 'Start date is after end date' : '';

  useEffect(() => {
    if (rangeError) return;
    let alive = true;
    setLoading(true);
    api
      .listCalls({
        onlyRecorded: true,
        callerId: callerId || undefined,
        from: dateKeyToIso(fromKey),
        // "To" is inclusive for the admin: up to the end of that day.
        to: dateKeyToIso(toKey, 1),
        page,
        pageSize: PAGE_SIZE,
      })
      .then((res) => {
        if (!alive) return;
        setRows(res.rows);
        setTotal(res.total);
        setError('');
      })
      .catch((e) => alive && setError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [callerId, fromKey, toKey, page, rangeError]);

  const callers = useMemo(() => users.filter((u) => u.role === 'caller'), [users]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="screen screen-fill recordings-screen">
      <PageHeader title="Recordings" subtitle="Answered calls with audio" />

      <div className="data-panel rec-panel">
        <Toolbar
          className="rec-filters"
          count={
            <>
              <strong>{total.toLocaleString('en-US')}</strong> {total === 1 ? 'recording' : 'recordings'}
            </>
          }
          right={
            <div className="adm-pager">
              {loading && <Spinner size={14} />}
              <span className="tb-count" title={`Page ${page} of ${pages}`}>
                {total === 0 ? '' : `${from}-${to} of ${total.toLocaleString('en-US')}`}
              </span>
              <div className="btn-group">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          }
        >
          <Select
            aria-label="Caller"
            value={callerId}
            onChange={(e) => setCallerId(e.target.value)}
            options={[{ value: '', label: 'All callers' }, ...callers.map((u) => ({ value: u.id, label: u.active ? u.fullName : `${u.fullName} (inactive)` }))]}
            fieldClassName="rec-filter"
          />
          <label className="rec-date">
            <span>From</span>
            <Input type="date" value={fromKey} max={toKey || undefined} onChange={(e) => setFromKey(e.target.value)} fieldClassName="rec-date-field" aria-invalid={rangeError ? true : undefined} />
          </label>
          <label className="rec-date">
            <span>To</span>
            <Input type="date" value={toKey} min={fromKey || undefined} onChange={(e) => setToKey(e.target.value)} fieldClassName="rec-date-field" aria-invalid={rangeError ? true : undefined} />
          </label>
          <div className="btn-group rec-quick">
            {[
              { label: 'Today', days: 0 },
              { label: '7 days', days: 6 },
              { label: '30 days', days: 29 },
            ].map((q) => (
              <Button
                key={q.label}
                size="sm"
                onClick={() => {
                  setFromKey(toDateKey(addDays(startOfDay(Date.now()), -q.days)));
                  setToKey(toDateKey(Date.now()));
                }}
              >
                {q.label}
              </Button>
            ))}
          </div>
          {rangeError && (
            <span className="field-error" role="alert">
              {rangeError}
            </span>
          )}
        </Toolbar>

        {error ? (
          <div className="form-error rec-error">{error}</div>
        ) : !loading && rows.length === 0 ? (
          <EmptyState icon={<IconRecordings size={32} />} title="No recordings" message="Nothing matches these filters. Recording is set in Settings." />
        ) : (
          <div className={`table-wrap rec-table-wrap ${loading ? 'is-loading' : ''}`}>
            <table className="table rec-table">
              <caption className="visually-hidden">Recorded calls</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Business</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Caller</th>
                  <th scope="col">Outcome</th>
                  <th scope="col" className="align-right">
                    Talk time
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Listen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const open = expanded === c.id;
                  const d = c.disposition ? dispositionInfo(c.disposition) : null;
                  return (
                    <Fragment key={c.id}>
                      <tr className={`clickable ${open ? 'selected' : ''}`} onClick={() => setExpanded(open ? null : c.id)}>
                        <td className="num">{formatDateTime(c.startedAt)}</td>
                        <td>
                          <span className="rec-biz cell-link">{c.businessName ?? formatPhone(c.direction === 'inbound' ? c.fromNumber : c.toNumber)}</span>
                        </td>
                        <td>{c.contactName || <span className="muted">-</span>}</td>
                        <td>{c.callerName ?? <span className="muted">-</span>}</td>
                        <td>{d ? <Badge tone={d.tone}>{d.label}</Badge> : <span className="muted">Not set</span>}</td>
                        <td className="align-right num">{formatDuration(c.talkSeconds)}</td>
                        <td className="align-right">
                          <Button
                            size="sm"
                            variant={open ? 'secondary' : 'ghost'}
                            icon={open ? <IconChevronUp size={13} /> : <IconPlay size={13} />}
                            aria-expanded={open}
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded(open ? null : c.id);
                            }}
                          >
                            {open ? 'Hide' : 'Listen'}
                          </Button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="rec-player-row">
                          <td colSpan={7}>
                            <div className="rec-player">
                              {/* Loaded only now that the row is open. */}
                              <RecordingPlayer callId={c.id} recordingUrl={c.recordingUrl} autoPlay />
                              {c.notes && (
                                <div className="rec-notes">
                                  <span className="muted">Caller note: </span>
                                  {c.notes}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
