import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../../api';
import type { LeadPatch } from '../../../api/Api';
import { Badge, Button, HighlightsStrip, Input, Modal, SectionHeading, Select, Spinner, Textarea, useToast } from '../../../components/ui';
import { formatDateTime, formatDuration, formatPhone, fromDateTimeLocalValue, normalizePhone, toDateTimeLocalValue } from '../../../lib/format';
import { US_STATES } from '../../../lib/leadImport';
import { CALL_RESULT_LABELS, LEAD_STATUSES, dispositionInfo, leadStatusLabel, type CallRecord, type Lead, type LeadList, type LeadStatus, type Profile } from '../../../types';
import { RecordingPlayer } from '../recordings/RecordingPlayer';
import { STATUS_TONE } from './leadUi';

interface Props {
  lead: Lead | null;
  users: Profile[];
  lists: LeadList[];
  onClose: () => void;
  onSaved: (lead: Lead) => void;
}

interface Form {
  businessName: string;
  contactName: string;
  phones: [string, string, string];
  email: string;
  city: string;
  state: string;
  notes: string;
  status: LeadStatus;
  assignedTo: string;
  listId: string;
  callbackAt: string;
  callbackOwner: string;
}

function toForm(l: Lead): Form {
  return {
    businessName: l.businessName,
    contactName: l.contactName,
    phones: [formatPhone(l.phones[0] ?? ''), formatPhone(l.phones[1] ?? ''), formatPhone(l.phones[2] ?? '')],
    email: l.email,
    city: l.city,
    state: l.state,
    notes: l.notes,
    status: l.status,
    assignedTo: l.assignedTo ?? '',
    listId: l.listId,
    callbackAt: toDateTimeLocalValue(l.callbackAt),
    callbackOwner: l.callbackOwner ?? l.assignedTo ?? '',
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_OPTIONS = [{ value: '', label: 'Unknown' }, ...Object.entries(US_STATES).map(([code, name]) => ({ value: code, label: `${code} - ${name}` }))];

/** Edit every field of a lead and see its call history. */
export function LeadDetailModal({ lead, users, lists, onClose, onSaved }: Props) {
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(lead ? toForm(lead) : null);
  const [history, setHistory] = useState<CallRecord[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setForm(lead ? toForm(lead) : null);
    setSubmitted(false);
    setHistory(null);
    setHistoryError('');
    if (!lead) return;
    let alive = true;
    api
      .getLeadHistory(lead.id)
      .then((h) => alive && setHistory(h))
      .catch((e) => alive && setHistoryError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [lead]);

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.fullName])), [users]);
  const callerOptions = useMemo(
    () => users.filter((u) => u.role === 'caller' && (u.active || u.id === lead?.assignedTo || u.id === lead?.callbackOwner)).map((u) => ({ value: u.id, label: u.active ? u.fullName : `${u.fullName} (inactive)` })),
    [users, lead],
  );

  if (!lead || !form) return null;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const setPhone = (i: number, v: string) =>
    setForm((f) => {
      if (!f) return f;
      const phones = [...f.phones] as Form['phones'];
      phones[i] = v;
      return { ...f, phones };
    });

  const phoneErrors = form.phones.map((p) => (p.trim() && !normalizePhone(p) ? 'Not a valid phone number' : ''));
  const filledPhones = form.phones.filter((p) => p.trim());
  const errors = {
    businessName: !form.businessName.trim() ? 'Business name is required' : '',
    phones: filledPhones.length === 0 ? 'At least one phone number is required' : '',
    email: form.email.trim() && !EMAIL_RE.test(form.email.trim()) ? 'Not a valid email address' : '',
    callbackAt: form.status === 'callback' && !form.callbackAt ? 'Pick when to call back' : '',
    callbackOwner: form.status === 'callback' && !form.callbackOwner ? 'Pick who calls back' : '',
  };
  const invalid = Object.values(errors).some(Boolean) || phoneErrors.some(Boolean);
  const show = (msg: string) => (submitted ? msg || undefined : undefined);

  const save = async () => {
    setSubmitted(true);
    if (invalid) return;
    const phones = filledPhones.map((p) => normalizePhone(p)!).filter((p, i, a) => a.indexOf(p) === i);
    const patch: LeadPatch = {};
    if (form.businessName.trim() !== lead.businessName) patch.businessName = form.businessName.trim();
    if (form.contactName.trim() !== lead.contactName) patch.contactName = form.contactName.trim();
    if (phones.join() !== lead.phones.join()) patch.phones = phones;
    if (form.email.trim() !== lead.email) patch.email = form.email.trim();
    if (form.city.trim() !== lead.city) patch.city = form.city.trim();
    if (form.state !== lead.state) patch.state = form.state;
    if (form.notes !== lead.notes) patch.notes = form.notes;
    if (form.listId !== lead.listId) patch.listId = form.listId;
    const assignedTo = form.assignedTo || null;
    if (assignedTo !== lead.assignedTo) patch.assignedTo = assignedTo;
    if (form.status !== lead.status) {
      patch.status = form.status;
      if (form.status === 'new' || form.status === 'no_answer') patch.nextCallAt = null;
      if (form.status !== 'callback') {
        patch.callbackAt = null;
        patch.callbackOwner = null;
      }
      if (form.status === 'new') patch.attemptDays = 0;
    }
    if (form.status === 'callback') {
      const at = fromDateTimeLocalValue(form.callbackAt);
      if (at !== lead.callbackAt) {
        patch.callbackAt = at;
        patch.nextCallAt = at;
      }
      if (form.callbackOwner !== lead.callbackOwner) patch.callbackOwner = form.callbackOwner;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateLead(lead.id, patch);
      toast.success('Lead saved.');
      onSaved(updated);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={!saving}
      title={
        <span className="row">
          {lead.businessName || 'Lead'}
          <Badge tone={STATUS_TONE[lead.status]}>
            {leadStatusLabel(lead.status)}
          </Badge>
        </span>
      }
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save changes
          </Button>
        </>
      }
    >
      <HighlightsStrip
        className="lead-highlights"
        items={[
          { key: 'phone', label: 'Phone', value: <span className="num">{formatPhone(lead.phones[0] ?? '') || '-'}</span> },
          { key: 'email', label: 'Email', value: lead.email || '-', title: lead.email || undefined, style: { flex: '1 1 160px' } },
          { key: 'place', label: 'City, state', value: [lead.city, lead.state].filter(Boolean).join(', ') || '-' },
          { key: 'owner', label: 'Owner', value: lead.assignedTo ? userName.get(lead.assignedTo) ?? 'Unknown' : 'Shared pool' },
          { key: 'list', label: 'List', value: lists.find((l) => l.id === lead.listId)?.name ?? '-', title: lists.find((l) => l.id === lead.listId)?.name, style: { flex: '1 1 140px' } },
          { key: 'tries', label: 'Tries', value: <span className="num">{lead.attemptDays}</span> },
          { key: 'last', label: 'Last call', value: lead.lastCalledAt ? formatDateTime(lead.lastCalledAt) : 'Never' },
        ]}
      />
      <div className="lead-detail">
        <form
          className="lead-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <SectionHeading as="h3">Details</SectionHeading>
          <div className="adm-form-grid">
            <Input label="Business name" value={form.businessName} onChange={(e) => set('businessName', e.target.value)} error={show(errors.businessName)} />
            <Input label="Contact name" value={form.contactName} onChange={(e) => set('contactName', e.target.value)} />
            <Input label="Email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} error={show(errors.email)} />
            {form.phones.map((p, i) => (
              <Input
                key={i}
                label={i === 0 ? 'Phone 1 (tried first)' : `Phone ${i + 1}`}
                value={p}
                inputMode="tel"
                placeholder={i === 0 ? '(214) 555-0123' : 'Optional'}
                onChange={(e) => setPhone(i, e.target.value)}
                error={phoneErrors[i] || (i === 0 ? show(errors.phones) : undefined)}
              />
            ))}
            <Input label="City" value={form.city} onChange={(e) => set('city', e.target.value)} />
            <Select label="State" value={form.state} onChange={(e) => set('state', e.target.value)} options={STATE_OPTIONS} />
          </div>
          <SectionHeading as="h3">Status and owner</SectionHeading>
          <div className="adm-form-grid">
            <Select label="Status" value={form.status} onChange={(e) => set('status', e.target.value as LeadStatus)} options={LEAD_STATUSES.map((s) => ({ value: s.value, label: s.label }))} />
            <Select
              label="Assigned to"
              value={form.assignedTo}
              onChange={(e) => set('assignedTo', e.target.value)}
              options={[{ value: '', label: 'Shared pool (anyone)' }, ...callerOptions]}
            />
            <Select label="List" value={form.listId} onChange={(e) => set('listId', e.target.value)} options={lists.map((l) => ({ value: l.id, label: l.name }))} />
            {form.status === 'callback' && (
              <>
                <Input label="Call back at" type="datetime-local" value={form.callbackAt} onChange={(e) => set('callbackAt', e.target.value)} error={show(errors.callbackAt)} />
                <Select
                  label="Callback belongs to"
                  value={form.callbackOwner}
                  onChange={(e) => set('callbackOwner', e.target.value)}
                  placeholder="Choose a caller"
                  options={callerOptions}
                  error={show(errors.callbackOwner)}
                />
              </>
            )}
          </div>
          <Textarea label="Notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          <div className="lead-meta muted">
            {lead.lastCalledAt ? `Last called ${formatDateTime(lead.lastCalledAt)}${lead.lastCalledBy ? ` by ${userName.get(lead.lastCalledBy) ?? 'someone'}` : ''}` : 'Never called'}
            {lead.nextCallAt ? ` · next call ${formatDateTime(lead.nextCallAt)}` : ''}
          </div>
          <button type="submit" hidden />
        </form>

        <section className="lead-history">
          <SectionHeading as="h3" actions={history && history.length > 0 ? <span className="muted adm-small">{history.length}</span> : undefined}>
            Call history
          </SectionHeading>
          {historyError ? (
            <div className="form-error">{historyError}</div>
          ) : history === null ? (
            <div className="row muted">
              <Spinner size={14} /> Loading
            </div>
          ) : history.length === 0 ? (
            <p className="muted adm-small">No calls</p>
          ) : (
            <ul className="history-list">
              {history.map((c) => (
                <li key={c.id} className="history-item">
                  <div className="history-top">
                    <span className="history-when num">{formatDateTime(c.startedAt)}</span>
                    <span className="spacer" />
                    {c.disposition ? (
                      <Badge tone={dispositionInfo(c.disposition).tone}>{dispositionInfo(c.disposition).label}</Badge>
                    ) : (
                      c.result && <Badge tone={c.result === 'answered' ? 'good' : 'neutral'}>{CALL_RESULT_LABELS[c.result]}</Badge>
                    )}
                  </div>
                  <div className="history-sub muted">
                    {c.direction === 'inbound' ? 'Inbound' : `Ring ${c.ring}`} · <span className="num">{formatPhone(c.direction === 'inbound' ? c.fromNumber : c.toNumber)}</span> ·{' '}
                    {c.callerId ? userName.get(c.callerId) ?? 'Unknown caller' : 'Nobody'}
                    {c.talkSeconds > 0 ? ` · ${formatDuration(c.talkSeconds)}` : ''}
                    {c.disposition && c.result && c.result !== 'answered' ? ` · ${CALL_RESULT_LABELS[c.result]}` : ''}
                  </div>
                  {c.notes && <div className="history-notes">{c.notes}</div>}
                  {c.recordingUrl && <RecordingPlayer className="history-audio" callId={c.id} recordingUrl={c.recordingUrl} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
