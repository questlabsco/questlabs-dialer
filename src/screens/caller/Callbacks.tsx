import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { Badge, Button, Card, EmptyState, IconCallback, IconRefresh, PageHeader, Spinner } from '../../components/ui';
import type { Lead } from '../../types';
import { formatDateTime, formatPhone, formatRelative } from '../../lib/format';
import { groupCallbacks } from './dialerLogic';
import { useNow } from './callerHooks';
import './caller.css';

/** Last non-empty call note for each lead (best effort; missing on error). */
async function loadLastNotes(leads: Lead[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    leads.map(async (l) => {
      try {
        const history = await api.getLeadHistory(l.id);
        const withNote = history.find((c) => c.notes.trim());
        if (withNote) out[l.id] = withNote.notes.trim();
      } catch {
        /* note is optional */
      }
    }),
  );
  return out;
}

function CallbackRow({ lead, note, now, tone }: { lead: Lead; note: string | undefined; now: number; tone: 'critical' | 'accent' | 'neutral' }) {
  return (
    <tr>
      <td className="num">{lead.callbackAt ? formatDateTime(lead.callbackAt) : '-'}</td>
      <td>
        <Badge tone={tone}>{lead.callbackAt ? formatRelative(lead.callbackAt, now) : 'Due now'}</Badge>
      </td>
      <td className="cell-truncate cb-business" title={lead.businessName || undefined}>
        {lead.businessName || formatPhone(lead.phones[0])}
      </td>
      <td>{lead.contactName || <span className="muted">-</span>}</td>
      <td className="num">{formatPhone(lead.phones[0])}</td>
      <td>{[lead.city, lead.state].filter(Boolean).join(', ') || <span className="muted">-</span>}</td>
      <td className="cell-truncate cb-note" title={note}>
        {note || <span className="muted">-</span>}
      </td>
    </tr>
  );
}

function Group({ title, leads, notes, now, tone }: { title: string; leads: Lead[]; notes: Record<string, string>; now: number; tone: 'critical' | 'accent' | 'neutral' }) {
  if (leads.length === 0) return null;
  return (
    <Card title={title} actions={<span className="muted cb-count num">{leads.length}</span>} padded={false}>
      <div className="table-wrap">
        <table className="table dense cb-table">
          <caption className="visually-hidden">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Call back at</th>
              <th scope="col">Due</th>
              <th scope="col">Business</th>
              <th scope="col">Contact</th>
              <th scope="col">Phone</th>
              <th scope="col">City, state</th>
              <th scope="col">Last note</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <CallbackRow key={l.id} lead={l} note={notes[l.id]} now={now} tone={tone} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The caller's own scheduled callbacks. */
export default function Callbacks() {
  const now = useNow(30_000);
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.getMyCallbacks();
      setLeads(list);
      setNotes(await loadLastNotes(list));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = leads ? groupCallbacks(leads, now) : null;

  return (
    <div className="screen">
      <PageHeader
        title="Callbacks"
        subtitle={leads ? `${leads.length} scheduled · due callbacks are dialed first when you start` : 'Scheduled callbacks'}
        actions={
          <Button icon={<IconRefresh size={14} />} loading={loading && leads !== null} onClick={() => void load()}>
            Refresh
          </Button>
        }
      />
      {error && (
        <div className="form-error" role="alert">
          Could not load your callbacks. {error}
        </div>
      )}
      {!groups && !error && (
        <div className="row muted">
          <Spinner size={16} /> Loading callbacks
        </div>
      )}
      {groups && leads && leads.length === 0 && (
        <Card>
          <EmptyState icon={<IconCallback size={32} />} title="No callbacks scheduled" message="Pick Callback in wrap-up to schedule one." />
        </Card>
      )}
      {groups && (
        <>
          <Group title="Overdue" leads={groups.overdue} notes={notes} now={now} tone="critical" />
          <Group title="Due today" leads={groups.today} notes={notes} now={now} tone="accent" />
          <Group title="Upcoming" leads={groups.upcoming} notes={notes} now={now} tone="neutral" />
        </>
      )}
    </div>
  );
}
