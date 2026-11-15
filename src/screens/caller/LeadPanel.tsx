import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge, Button, Card, HighlightsStrip, IconButton, IconEdit, Spinner } from '../../components/ui';
import { errorMessage } from '../../api/Api';
import { CALL_RESULT_LABELS, dispositionInfo, type CallRecord, type Lead } from '../../types';
import { formatDateTime, formatDuration, formatPhone } from '../../lib/format';
import { isUnknownLead, isValidEmail } from './dialerLogic';

export interface LeadDataSource {
  getLeadHistory(leadId: string): Promise<CallRecord[]>;
}

// ---------------------------------------------------------------------------
// Inline editable field
// ---------------------------------------------------------------------------

interface InlineEditProps {
  label: string;
  value: string;
  placeholder: string;
  type?: 'text' | 'email';
  disabled?: boolean;
  validate?: (v: string) => string | null;
  onSave: (v: string) => Promise<void>;
}

export function InlineEdit({ label, value, placeholder, type = 'text', disabled, validate, onSave }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft(value);
    requestAnimationFrame(() => editBtnRef.current?.focus());
  };

  const save = async () => {
    const v = draft.trim();
    if (v === value.trim()) {
      cancel();
      return;
    }
    const problem = validate?.(v) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(v);
      setEditing(false);
      requestAnimationFrame(() => editBtnRef.current?.focus());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className="dl-kv">
      <div className="dl-kv-label">{label}</div>
      {editing ? (
        <div className="dl-inline-edit">
          <div className="row dl-wrap">
            <input
              ref={inputRef}
              className="input dl-inline-input"
              type={type}
              value={draft}
              placeholder={placeholder}
              aria-label={label}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={saving}
            />
            <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className="dl-kv-value row">
          <span className={value ? undefined : 'muted'}>{value || placeholder}</span>
          {!disabled && (
            <IconButton ref={editBtnRef} label={`Edit ${label.toLowerCase()}`} icon={<IconEdit size={14} />} size="sm" onClick={() => setEditing(true)} />
          )}
        </div>
      )}
    </div>
  );
}

export function validateEmailInput(v: string): string | null {
  if (!v) return null;
  return isValidEmail(v) ? null : 'Not a valid email address';
}

// ---------------------------------------------------------------------------
// Call history
// ---------------------------------------------------------------------------

function LeadHistory({ leadId, data, callerId, excludeCallRecordId }: { leadId: string; data: LeadDataSource; callerId: string; excludeCallRecordId?: string | null }) {
  const [rows, setRows] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    data
      .getLeadHistory(leadId)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [leadId, data]);

  if (error) return <p className="muted dl-small dl-pad">Could not load previous calls. {error}</p>;
  if (!rows) {
    return (
      <div className="row muted dl-small dl-pad">
        <Spinner size={14} /> Loading previous calls
      </div>
    );
  }
  const shown = rows.filter((r) => r.id !== excludeCallRecordId).slice(0, 12);
  if (shown.length === 0) return <p className="muted dl-small dl-pad">No previous calls</p>;
  return (
    <div className="table-wrap dl-history">
      <table className="table dense">
        <caption className="visually-hidden">Previous calls</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">By</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="align-right">
              Talk
            </th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const outcome = r.disposition ? dispositionInfo(r.disposition) : null;
            return (
              <tr key={r.id}>
                <td className="num">
                  {formatDateTime(r.startedAt)}
                  {r.direction === 'inbound' && <span className="cell-sub"> (inbound)</span>}
                </td>
                <td>{r.callerId === callerId ? 'You' : r.callerId ? 'Teammate' : 'Nobody'}</td>
                <td>{outcome ? <Badge tone={outcome.tone}>{outcome.label}</Badge> : <Badge>{r.result ? CALL_RESULT_LABELS[r.result] : 'In progress'}</Badge>}</td>
                <td className="align-right num">{r.talkSeconds > 0 ? formatDuration(r.talkSeconds) : '-'}</td>
                <td className="cell-truncate dl-history-notes" title={r.notes || undefined}>
                  {r.notes || <span className="muted">-</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Highlights strip (record header)
// ---------------------------------------------------------------------------

export function LeadHighlights({ lead, phoneInUse }: { lead: Lead; phoneInUse: string | null }) {
  if (isUnknownLead(lead)) {
    const number = lead.phones[0] ?? lead.id.slice('unknown:'.length);
    return (
      <HighlightsStrip
        className="dl-highlights"
        items={[
          { key: 'phone', label: 'Phone', value: <span className="num">{formatPhone(number)}</span> },
          { key: 'who', label: 'Lead', value: 'Not in your leads' },
        ]}
      />
    );
  }
  const phone = phoneInUse ?? lead.phones[0] ?? '';
  const idx = lead.phones.indexOf(phone);
  return (
    <HighlightsStrip
      className="dl-highlights"
      items={[
        { key: 'contact', label: 'Contact', value: lead.contactName || <span className="muted">Unknown</span>, title: lead.contactName || undefined },
        {
          key: 'phone',
          label: 'Phone',
          value: (
            <span className="num">
              {formatPhone(phone)}
              {lead.phones.length > 1 && idx >= 0 && <span className="muted"> ({idx + 1} of {lead.phones.length})</span>}
            </span>
          ),
        },
        { key: 'email', label: 'Email', value: lead.email || <span className="muted">None</span>, title: lead.email || undefined },
        { key: 'place', label: 'City, state', value: [lead.city, lead.state].filter(Boolean).join(', ') || <span className="muted">-</span> },
        { key: 'tries', label: 'Tries', value: <span className="num">{lead.attemptDays}</span> },
        { key: 'last', label: 'Last call', value: lead.lastCalledAt ? formatDateTime(lead.lastCalledAt) : 'Never' },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Lead panel
// ---------------------------------------------------------------------------

export interface LeadPanelProps {
  lead: Lead;
  /** The phone being used right now (highlighted), if known. */
  phoneInUse: string | null;
  callerId: string;
  data: LeadDataSource;
  /** Hidden from the history list (the call in progress). */
  currentCallRecordId?: string | null;
  onSaveField: (field: 'contactName' | 'email', value: string) => Promise<void>;
  compact?: boolean;
}

export function LeadPanel({ lead, phoneInUse, callerId, data, currentCallRecordId, onSaveField, compact }: LeadPanelProps) {
  if (isUnknownLead(lead)) {
    const number = lead.phones[0] ?? lead.id.slice('unknown:'.length);
    return (
      <Card title="Caller" className="dl-lead-card">
        <div className="stack">
          <div className="dl-lead-title num">{formatPhone(number)}</div>
          <p className="muted dl-small">Not in your leads. Ask who they are and why they called; note it.</p>
        </div>
      </Card>
    );
  }

  const place = [lead.city, lead.state].filter(Boolean).join(', ');
  return (
    <Card title={lead.businessName || 'Unnamed business'} actions={place ? <span className="muted dl-small">{place}</span> : undefined} className="dl-lead-card" padded={false}>
      <div className="dl-lead-body">
        <div className="dl-kv-grid">
          <InlineEdit label="Contact" value={lead.contactName} placeholder="Add owner name" onSave={(v) => onSaveField('contactName', v)} />
          <InlineEdit label="Email" type="email" value={lead.email} placeholder="Add email (needed to book)" validate={validateEmailInput} onSave={(v) => onSaveField('email', v)} />
          <div className="dl-kv">
            <div className="dl-kv-label">Phones</div>
            <ul className="dl-phones">
              {lead.phones.map((p, i) => {
                const inUse = p === phoneInUse;
                return (
                  <li key={p} className={inUse ? 'dl-phone in-use' : 'dl-phone'} aria-current={inUse ? 'true' : undefined}>
                    <span className="num">{formatPhone(p)}</span>
                    <span className="muted">{i === 0 ? 'Primary' : `Phone ${i + 1}`}</span>
                    {inUse && <Badge tone="good">In use</Badge>}
                  </li>
                );
              })}
            </ul>
          </div>
          {lead.notes && (
            <div className="dl-kv">
              <div className="dl-kv-label">List notes</div>
              <p className="dl-pre">{lead.notes}</p>
            </div>
          )}
        </div>
      </div>
      {!compact && (
        <>
          <div className="dl-subhead">Previous calls</div>
          <LeadHistory leadId={lead.id} data={data} callerId={callerId} excludeCallRecordId={currentCallRecordId} />
        </>
      )}
    </Card>
  );
}
