import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, isDemo } from '../../api';
import {
  Badge,
  Button,
  ConfirmDialog,
  HelpTip,
  IconAlert,
  IconFlag,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Spinner,
  StatTile,
  Table,
  Toolbar,
  useToast,
  type TableColumn,
} from '../../components/ui';
import { addDays, daysBetween, formatNumber, formatPercent, formatPhone, normalizePhone, startOfDay } from '../../lib/format';
import type { PhoneNumber, Settings } from '../../types';
import { PhoneSetupSection, TelnyxNumbers, usePhoneSetup } from './numbers/PhoneSetup';
import './numbers/numbers.css';

/** "Day 5 of 14 — up to 52 calls today" / "Fully ramped". */
function rampText(n: PhoneNumber, s: Settings | null): string {
  if (!s || s.rampDays <= 0) return 'Fully ramped';
  const age = Math.max(0, daysBetween(n.addedAt, Date.now()));
  if (age >= s.rampDays || n.effectiveCapToday >= n.dailyCap) return 'Fully ramped';
  return `Day ${age + 1} of ${s.rampDays}, max ${n.effectiveCapToday} today`;
}

/** Admin: outbound numbers — rotation caps, ramp-up, pickup rate health. */
export default function Numbers() {
  const toast = useToast();
  const [numbers, setNumbers] = useState<PhoneNumber[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [avgDailyDials, setAvgDailyDials] = useState<number | null>(null);
  const [activeCallers, setActiveCallers] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<PhoneNumber | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setNumbers(await api.listNumbers());
      setLoadError('');
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  const phone = usePhoneSetup(load);

  useEffect(() => {
    void load();
    api.getSettings().then(setSettings, () => undefined);
    api.listUsers().then(
      (us) => setActiveCallers(us.filter((u) => u.role === 'caller' && u.active).length),
      () => setActiveCallers(null),
    );
    // Average dials per day over the last 7 full days (today excluded: it isn't over yet).
    const today = startOfDay(Date.now());
    api.getMetrics({ from: addDays(today, -7).toISOString(), to: today.toISOString() }).then(
      (m) => {
        const days = m.byDay.filter((d) => d.dials > 0);
        setAvgDailyDials(days.length ? days.reduce((s, d) => s + d.dials, 0) / days.length : 0);
      },
      () => setAvgDailyDials(null),
    );
  }, [load]);

  const replace = (n: PhoneNumber) => setNumbers((xs) => (xs ? xs.map((x) => (x.id === n.id ? n : x)) : xs));

  const patch = async (n: PhoneNumber, p: Partial<Pick<PhoneNumber, 'label' | 'active' | 'dailyCap'>>) => {
    try {
      replace(await api.updateNumber(n.id, p));
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };

  const sync = async () => {
    // With a backend (or a dev fixture): the richer sync that also lists the account's other numbers.
    if (phone.client) {
      await phone.sync();
      return;
    }
    setSyncing(true);
    try {
      const before = numbers?.length ?? 0;
      const list = await api.syncNumbersFromTelnyx();
      setNumbers(list);
      if (isDemo) toast.info('Demo mode: there is no Telnyx account connected, so nothing changed.');
      else toast.success(list.length > before ? `Found ${list.length - before} new number${list.length - before === 1 ? '' : 's'}.` : 'Numbers are up to date.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (n: PhoneNumber) => {
    setBusy(true);
    try {
      await api.removeNumber(n.id);
      toast.success(`${formatPhone(n.number)} removed.`);
      setRemoving(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    const active = (numbers ?? []).filter((n) => n.active);
    return {
      active: active.length,
      capacity: active.reduce((s, n) => s + n.effectiveCapToday, 0),
      used: active.reduce((s, n) => s + n.callsToday, 0),
      flagged: (numbers ?? []).filter((n) => n.flagged).length,
    };
  }, [numbers]);

  const lowCapacity = avgDailyDials !== null && avgDailyDials > 0 && numbers !== null && totals.capacity < avgDailyDials * 1.1;

  const columns: TableColumn<PhoneNumber>[] = [
    {
      key: 'number',
      header: 'Number',
      sortValue: (n) => n.number,
      render: (n) => (
        <div className="num-cell">
          <span className="num num-strong">{formatPhone(n.number)}</span>
          {n.flagged && (
            <Badge tone="critical" title="Pickup rate is less than half your average. Carriers may be labelling it as spam.">
              Low pickup rate
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'label', header: 'Label', sortValue: (n) => n.label, render: (n) => <LabelEditor key={n.id + n.label} value={n.label} onSave={(label) => patch(n, { label })} /> },
    {
      key: 'active',
      header: 'In use',
      sortValue: (n) => (n.active ? 0 : 1),
      render: (n) => (
        <label className="num-switch" title={n.active ? 'On: calls go out from this number' : 'Off: not used for calls'}>
          <input type="checkbox" role="switch" checked={n.active} onChange={(e) => void patch(n, { active: e.target.checked })} aria-label={`Use ${formatPhone(n.number)}`} />
          <span className="num-switch-track" aria-hidden />
          <span className="num-switch-text">{n.active ? 'On' : 'Off'}</span>
        </label>
      ),
    },
    {
      key: 'ramp',
      header: 'Warm-up',
      render: (n) => {
        // Short form in the cell (the day's limit is in "Calls today"); the full sentence in the tooltip.
        const full = rampText(n, settings);
        return full === 'Fully ramped' ? <span className="muted">{full}</span> : <span title={full}>{full.split(',')[0]}</span>;
      },
    },
    {
      key: 'today',
      header: 'Calls today',
      sortValue: (n) => n.callsToday,
      render: (n) => {
        const pct = n.effectiveCapToday ? Math.min(1, n.callsToday / n.effectiveCapToday) : 0;
        return (
          <div className="num-meter-cell" title={`${n.callsToday} of ${n.effectiveCapToday} allowed today`}>
            <div className={`num-meter ${pct >= 1 ? 'full' : pct >= 0.8 ? 'high' : ''}`} aria-hidden>
              <div className="num-meter-fill" style={{ width: `${pct * 100}%` }} />
            </div>
            <span className="num">
              {n.callsToday} / {n.effectiveCapToday}
            </span>
          </div>
        );
      },
    },
    { key: 'calls7d', header: '7-day calls', align: 'right', sortValue: (n) => n.calls7d, render: (n) => <span className="num">{formatNumber(n.calls7d)}</span> },
    {
      key: 'pickup',
      header: '7-day pickup',
      align: 'right',
      sortValue: (n) => n.pickupRate7d,
      render: (n) => <span className={`num ${n.flagged ? 'num-critical' : ''}`}>{n.calls7d ? formatPercent(n.pickupRate7d) : '-'}</span>,
    },
    { key: 'cap', header: 'Daily limit', sortValue: (n) => n.dailyCap, render: (n) => <CapEditor key={n.id + n.dailyCap} value={n.dailyCap} onSave={(dailyCap) => patch(n, { dailyCap })} /> },
    {
      key: 'remove',
      header: <span className="visually-hidden">Remove</span>,
      align: 'right',
      render: (n) => <IconButton label={`Remove ${formatPhone(n.number)}`} icon={<IconTrash />} size="sm" onClick={() => setRemoving(n)} />,
    },
  ];

  const flaggedNumbers = (numbers ?? []).filter((n) => n.flagged);

  return (
    <div className="screen numbers-screen">
      <PageHeader
        title="Numbers"
        subtitle={numbers ? `${numbers.length} numbers · ${totals.active} in use · calls rotate across numbers up to each daily limit` : 'Outbound caller IDs'}
        actions={
          <>
            <Button
              icon={<IconRefresh />}
              loading={syncing || phone.syncing}
              disabled={phone.client === undefined}
              onClick={() => void sync()}
              title="Reads the numbers on your Telnyx account. Adds the ones on the dialer to the table; never buys numbers or changes other apps."
            >
              Sync from Telnyx
            </Button>
            <Button variant="primary" icon={<IconPlus />} onClick={() => setAddOpen(true)}>
              Add number
            </Button>
          </>
        }
      />

      <PhoneSetupSection ps={phone} activeCallers={activeCallers} linesPerCaller={settings?.linesPerCaller ?? null} />
      <TelnyxNumbers ps={phone} />

      <div className="stat-grid">
        <StatTile label="In use" value={totals.active} sub={numbers ? `of ${numbers.length}` : undefined} />
        <StatTile label="Allowed today" value={formatNumber(totals.capacity)} sub="calls, numbers in use" />
        <StatTile label="Made today" value={formatNumber(totals.used)} sub={totals.capacity ? `${formatPercent(totals.used / totals.capacity, 0)} of limit` : undefined} />
        <StatTile label="Low pickup rate" value={totals.flagged} sub={totals.flagged ? 'flagged' : 'none'} />
      </div>

      {lowCapacity && (
        <div className="adm-callout adm-callout-warning">
          <IconAlert />
          <span>
            <strong>Low capacity:</strong> about {formatNumber(Math.round(avgDailyDials!))} calls a day last week, {formatNumber(totals.capacity)} allowed today. Add numbers or raise daily limits.
          </span>
        </div>
      )}

      {flaggedNumbers.length > 0 && (
        <div className="adm-callout adm-callout-critical">
          <IconFlag />
          <span>
            <strong>{flaggedNumbers.length === 1 ? formatPhone(flaggedNumbers[0].number) : `${flaggedNumbers.length} numbers`}:</strong> 7-day pickup rate under half the team average, likely shown as spam. Turn off for 1 to 2 weeks or replace.
          </span>
        </div>
      )}

      {loadError ? (
        <div className="form-error">{loadError}</div>
      ) : numbers === null ? (
        <div className="row muted">
          <Spinner size={14} /> Loading
        </div>
      ) : (
        <div className="data-panel">
          <Toolbar
            count={
              settings ? (
                <>
                  Warm-up: {settings.rampStartCap}/day for {settings.rampDays} days
                  <HelpTip text={`New numbers start at ${settings.rampStartCap} calls a day and warm up to their daily limit over ${settings.rampDays} days, which keeps carriers from flagging them. Change this in Settings.`} />
                </>
              ) : undefined
            }
            right={isDemo ? <span className="tb-count">Demo: Telnyx sync is off</span> : undefined}
          />
          <Table columns={columns} rows={numbers} rowKey={(n) => n.id} dense caption="Outbound numbers" empty="No numbers. Sync from Telnyx or add one." />
        </div>
      )}

      <AddNumberModal
        open={addOpen}
        defaultCap={settings?.defaultDailyCap ?? 100}
        onClose={() => setAddOpen(false)}
        onAdded={async () => {
          setAddOpen(false);
          await load();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        title="Remove this number?"
        message={removing ? `${formatPhone(removing.number)} won't be used for calls any more. Past calls from it stay in the history.` : ''}
        confirmLabel="Remove"
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </div>
  );
}

function LabelEditor({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value);
  const commit = async () => {
    if (v.trim() === value) return;
    if (!(await onSave(v.trim()))) setV(value);
  };
  return (
    <input
      className="input num-inline num-label-input"
      value={v}
      placeholder="Add a label"
      aria-label="Label"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

function CapEditor({ value, onSave }: { value: number; onSave: (v: number) => Promise<boolean> }) {
  const [v, setV] = useState(String(value));
  const n = Number(v);
  const valid = Number.isInteger(n) && n >= 1 && n <= 2000;
  const commit = async () => {
    if (!valid) {
      setV(String(value));
      return;
    }
    if (n === value) return;
    if (!(await onSave(n))) setV(String(value));
  };
  return (
    <input
      className="input num-inline num-cap-input num"
      type="number"
      min={1}
      max={2000}
      value={v}
      aria-label="Daily limit"
      aria-invalid={!valid || undefined}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(String(value));
      }}
    />
  );
}

function AddNumberModal({ open, defaultCap, onClose, onAdded }: { open: boolean; defaultCap: number; onClose: () => void; onAdded: () => void | Promise<void> }) {
  const toast = useToast();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [cap, setCap] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setNumber('');
    setLabel('');
    setCap(String(defaultCap));
    setSubmitted(false);
    setError('');
  }, [open, defaultCap]);

  const numberError = !normalizePhone(number) ? 'Enter a valid phone number, e.g. (214) 555-0123' : '';
  const capN = Number(cap);
  const capError = !Number.isInteger(capN) || capN < 1 ? 'Enter a whole number of at least 1' : '';

  const save = async () => {
    setSubmitted(true);
    setError('');
    if (numberError || capError) return;
    setSaving(true);
    try {
      const n = await api.addNumber({ number, label: label.trim(), dailyCap: capN });
      toast.success(`${formatPhone(n.number)} added. Warm-up starts today.`);
      await onAdded();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title="Add number"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Add number
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <div className="form-error">{error}</div>}
        <Input label="Phone number" value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" placeholder="(214) 555-0123" error={submitted ? numberError || undefined : undefined} hint="Must already exist in your Telnyx account" />
        <Input label="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Dallas 214 #3" />
        <Input label="Daily limit" type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} error={submitted ? capError || undefined : undefined} hint="Max calls per day after warm-up" />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
