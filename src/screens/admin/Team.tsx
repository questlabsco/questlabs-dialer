import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  HelpTip,
  IconAlert,
  IconButton,
  IconPlus,
  IconRefresh,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  useToast,
  type TableColumn,
} from '../../components/ui';
import { addDays, formatDate, formatNumber, formatPercent } from '../../lib/format';
import { displayLogin, isValidUsername, loginEmail, normalizeUsername } from '../../lib/login';
import type { CallerMetricsRow, Metrics, Presence, Profile, Role } from '../../types';
import { formatHoursMinutes } from './dashboard/chartMath';
import { generatePassword } from './team/password';
import { metricsCache } from './team/metricsSource';
import { LiveText, PersonDrawer } from './team/PersonDrawer';
import { DEFAULT_TEAM_RANGE, LIVE_SORT, TEAM_RANGES, indexByCaller, liveStatus, metricSortValue, teamRange, type HeadlineKey, type TeamRange } from './team/teamPerf';
import './team/team.css';

const ROLE_OPTIONS = [
  { value: 'caller', label: 'Caller' },
  { value: 'admin', label: 'Admin' },
];

/** Inline message for a username field ('' when fine). */
function usernameError(v: string): string {
  const s = normalizeUsername(v);
  if (!s) return 'Enter a username';
  if (s.length < 3) return 'At least 3 characters';
  if (s.length > 30) return 'At most 30 characters';
  if (!/^[a-z0-9]/.test(s)) return 'Start with a letter or number';
  if (!isValidUsername(s)) return 'Use only letters, numbers, dots, dashes and underscores (no spaces)';
  return '';
}

type Dialog =
  | null
  | { kind: 'create' }
  | { kind: 'edit'; user: Profile }
  | { kind: 'password'; user: Profile }
  | { kind: 'toggle'; user: Profile };

/** "Nov 9, 2026 - Nov 15, 2026" for a [from, to) range of whole days. */
function describeRange(from: string, to: string): string {
  const a = formatDate(from);
  const b = formatDate(addDays(new Date(to), -1));
  return a === b ? a : `${a} - ${b}`;
}

const NUMBER_COLUMNS: { key: HeadlineKey; header: string; format: (r: CallerMetricsRow) => string }[] = [
  { key: 'dials', header: 'Dials', format: (r) => formatNumber(r.dials) },
  { key: 'pickups', header: 'Pickups', format: (r) => formatNumber(r.pickups) },
  { key: 'pickupRate', header: 'Pickup rate', format: (r) => (r.dials > 0 ? formatPercent(r.pickupRate) : '-') },
  { key: 'conversations', header: 'Conversations', format: (r) => formatNumber(r.conversations) },
  { key: 'bookings', header: 'Bookings', format: (r) => formatNumber(r.bookings) },
  { key: 'talkSeconds', header: 'Talk time', format: (r) => formatHoursMinutes(r.talkSeconds) },
];

function zeroRow(u: Profile): CallerMetricsRow {
  return { callerId: u.id, label: u.fullName, dials: 0, pickups: 0, pickupRate: 0, conversations: 0, bookings: 0, talkSeconds: 0, droppedPickups: 0 };
}

/** Admin: the team. Create users, track each person's numbers, edit, deactivate, reset passwords. */
export default function Team() {
  const toast = useToast();
  const { profile, refresh: refreshMe } = useAuth();
  const [users, setUsers] = useState<Profile[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [rangeId, setRangeId] = useState<TeamRange>(DEFAULT_TEAM_RANGE);
  const [reload, setReload] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');
  const [presence, setPresence] = useState<Presence[] | null>(null);

  // `reload` also re-reads the clock so "Today" moves on after midnight.
  const range = useMemo(() => teamRange(rangeId, Date.now()), [rangeId, reload]);

  const load = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
      setLoadError('');
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    setMetricsLoading(true);
    setMetricsError('');
    metricsCache.get(range).then(
      (m) => {
        if (!alive) return;
        setMetrics(m);
        setMetricsLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setMetricsError(errorMessage(e));
        setMetricsLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [range]);

  useEffect(() => {
    let alive = true;
    api.listPresence().then(
      (l) => {
        if (alive) setPresence(l);
      },
      () => undefined,
    );
    const unsubscribe = api.subscribePresence((l) => {
      if (alive) setPresence(l);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const refresh = () => {
    metricsCache.invalidateOpen();
    setReload((r) => r + 1);
    void load();
  };

  const toggleActive = async (u: Profile) => {
    setBusy(true);
    try {
      await api.updateUser(u.id, { active: !u.active });
      toast.success(u.active ? `${u.fullName} can no longer sign in.` : `${u.fullName} can sign in again.`);
      setDialog(null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const xs = users ?? [];
    return { callers: xs.filter((u) => u.role === 'caller' && u.active).length, admins: xs.filter((u) => u.role === 'admin' && u.active).length };
  }, [users]);

  const byCaller = useMemo(() => indexByCaller(metrics?.byCaller), [metrics]);
  const presenceMap = useMemo(() => (presence ? new Map(presence.map((p) => [p.callerId, p])) : null), [presence]);
  const rowFor = (u: Profile): CallerMetricsRow | undefined => (metrics ? byCaller.get(u.id) ?? zeroRow(u) : undefined);

  const columns: TableColumn<Profile>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (u) => u.fullName.toLowerCase(),
      render: (u) => (
        <span className="team-name">
          {u.fullName}
          {u.id === profile?.id && <span className="cell-sub"> (you)</span>}
        </span>
      ),
    },
    { key: 'username', header: 'Username', sortValue: (u) => displayLogin(u.email).toLowerCase(), render: (u) => displayLogin(u.email) },
    { key: 'role', header: 'Role', sortValue: (u) => u.role, render: (u) => (u.role === 'admin' ? 'Admin' : 'Caller') },
    {
      key: 'active',
      header: (
        <>
          Status
          <HelpTip text="Deactivated people can't sign in and get no new leads. Leads already assigned to them stay assigned until you move them on the Leads screen." />
        </>
      ),
      sortValue: (u) => (u.active ? 0 : 1),
      render: (u) => (
        <Badge tone={u.active ? 'good' : 'neutral'}>
          {u.active ? 'Active' : 'Deactivated'}
        </Badge>
      ),
    },
    {
      key: 'live',
      header: 'Live',
      sortValue: (u) => {
        const s = liveStatus(u, presenceMap);
        return s ? LIVE_SORT[s] : null;
      },
      render: (u) => {
        const s = liveStatus(u, presenceMap);
        return s ? <LiveText status={s} /> : <span className="tm-dash">-</span>;
      },
    },
    ...NUMBER_COLUMNS.map(
      (c): TableColumn<Profile> => ({
        key: c.key,
        header: c.header,
        align: 'right',
        sortValue: (u) => metricSortValue(u, rowFor(u), c.key),
        render: (u) => {
          const r = rowFor(u);
          if (u.role !== 'caller' || !r) return <span className="tm-dash">-</span>;
          return <span className={r.dials === 0 && r.talkSeconds === 0 ? 'num tm-dash' : 'num'}>{c.format(r)}</span>;
        },
      }),
    ),
    { key: 'created', header: 'Added', sortValue: (u) => u.createdAt, render: (u) => formatDate(u.createdAt) },
  ];

  const selected = users?.find((u) => u.id === selectedId) ?? null;
  const rangeLabel = TEAM_RANGES.find((r) => r.id === rangeId)?.label ?? '';
  const rangeText = describeRange(range.from, range.to);

  return (
    <div className="screen team-screen">
      <PageHeader
        title="Team"
        subtitle={
          users
            ? `${counts.callers} active caller${counts.callers === 1 ? '' : 's'} · ${counts.admins} admin${counts.admins === 1 ? '' : 's'}${users.some((u) => !u.active) ? ` · ${users.filter((u) => !u.active).length} deactivated` : ''} · ${rangeText}`
            : 'Users'
        }
        actions={
          <div className="tm-header-actions">
            <div className="tm-seg" role="group" aria-label="Range">
              {TEAM_RANGES.map((r) => (
                <button key={r.id} type="button" className="tm-seg-btn" aria-pressed={rangeId === r.id} onClick={() => setRangeId(r.id)}>
                  {r.label}
                </button>
              ))}
            </div>
            {metricsLoading && metrics !== null && <Spinner size={14} label="Updating" />}
            <IconButton label="Refresh" variant="secondary" icon={<IconRefresh size={14} />} onClick={refresh} disabled={metricsLoading} />
            <Button variant="primary" icon={<IconPlus />} onClick={() => setDialog({ kind: 'create' })}>
              Add person
            </Button>
          </div>
        }
      />
      {loadError && users === null ? (
        <EmptyState
          icon={<IconAlert size={32} />}
          title="Could not load the team"
          message={loadError}
          action={
            <Button variant="primary" onClick={() => void load()}>
              Retry
            </Button>
          }
        />
      ) : users === null ? (
        <div className="row muted">
          <Spinner size={14} /> Loading
        </div>
      ) : (
        <div className="data-panel">
          {metricsError && (
            <div className="tm-banner" role="alert">
              <span>
                Could not load numbers: {metricsError}
                {metrics ? '. Showing the last numbers loaded.' : ''}
              </span>
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          )}
          <div className={metricsLoading && metrics ? 'team-table tm-stale' : 'team-table'} aria-busy={metricsLoading || undefined}>
            <Table
              columns={columns}
              rows={users}
              rowKey={(u) => u.id}
              onRowClick={(u) => setSelectedId(u.id)}
              selectedKey={selectedId}
              defaultSort={{ key: 'name', dir: 'asc' }}
              caption="Team members"
              empty="No users."
            />
          </div>
        </div>
      )}

      {selected && (
        <PersonDrawer
          key={selected.id}
          user={selected}
          isSelf={selected.id === profile?.id}
          rangeId={rangeId}
          range={range}
          rangeLabel={rangeLabel}
          live={liveStatus(selected, presenceMap)}
          reloadKey={reload}
          onClose={() => setSelectedId(null)}
          onEdit={(u) => setDialog({ kind: 'edit', user: u })}
          onPassword={(u) => setDialog({ kind: 'password', user: u })}
          onToggle={(u) => setDialog({ kind: 'toggle', user: u })}
        />
      )}

      <UserFormModal
        dialog={dialog?.kind === 'create' || dialog?.kind === 'edit' ? dialog : null}
        isSelf={dialog?.kind === 'edit' && dialog.user.id === profile?.id}
        onClose={() => setDialog(null)}
        onSaved={async (self) => {
          setDialog(null);
          await load();
          if (self) await refreshMe();
        }}
      />
      <PasswordModal user={dialog?.kind === 'password' ? dialog.user : null} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog?.kind === 'toggle'}
        title={dialog?.kind === 'toggle' ? (dialog.user.active ? `Deactivate ${dialog.user.fullName}?` : `Reactivate ${dialog.user.fullName}?`) : ''}
        message={
          dialog?.kind === 'toggle'
            ? dialog.user.active
              ? "Signs them out of the dialer. They can't sign in or get new leads. Call history is kept; you can reactivate them later."
              : 'They can sign in and get leads again.'
            : ''
        }
        confirmLabel={dialog?.kind === 'toggle' && dialog.user.active ? 'Deactivate' : 'Reactivate'}
        danger={dialog?.kind === 'toggle' && dialog.user.active}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => dialog?.kind === 'toggle' && void toggleActive(dialog.user)}
      />
    </div>
  );
}

function UserFormModal({
  dialog,
  isSelf,
  onClose,
  onSaved,
}: {
  dialog: { kind: 'create' } | { kind: 'edit'; user: Profile } | null;
  isSelf: boolean;
  onClose: () => void;
  onSaved: (self: boolean) => void | Promise<void>;
}) {
  const toast = useToast();
  const editing = dialog?.kind === 'edit' ? dialog.user : null;
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('caller');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialog) return;
    setFullName(editing?.fullName ?? '');
    setUsername(editing ? displayLogin(editing.email) : '');
    setRole(editing?.role ?? 'caller');
    setPassword('');
    setSubmitted(false);
    setError('');
  }, [dialog, editing]);

  const usernameChanged = !editing || normalizeUsername(username) !== displayLogin(editing.email).toLowerCase();
  const errors = {
    fullName: !fullName.trim() ? 'Enter their name' : '',
    // An unchanged login (e.g. an older account made with a real address) is left alone.
    username: usernameChanged ? usernameError(username) : '',
    password: !editing && password.length < 8 ? 'At least 8 characters' : '',
  };
  const show = (m: string) => (submitted && m ? m : undefined);

  const save = async () => {
    setSubmitted(true);
    setError('');
    if (Object.values(errors).some(Boolean)) return;
    setSaving(true);
    try {
      if (editing) {
        const patch: { fullName?: string; role?: Role; email?: string } = {};
        if (fullName.trim() !== editing.fullName) patch.fullName = fullName.trim();
        if (role !== editing.role) patch.role = role;
        if (usernameChanged) patch.email = loginEmail(normalizeUsername(username));
        if (Object.keys(patch).length) await api.updateUser(editing.id, patch);
        toast.success('Saved.');
      } else {
        const u = await api.createUser({ fullName: fullName.trim(), email: loginEmail(normalizeUsername(username)), role, password });
        toast.success(`${u.fullName} added. Give them their username (${displayLogin(u.email)}) and temporary password to sign in.`);
      }
      setPassword('');
      await onSaved(isSelf);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      dismissible={!saving}
      title={editing ? `Edit ${editing.fullName}` : 'Add person'}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {editing ? 'Save' : 'Add person'}
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
        <Input label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} error={show(errors.fullName)} autoComplete="off" />
        <Input
          label="Username"
          name="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={show(errors.username)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          hint="Used to sign in. 3–30 letters, numbers, dots, dashes or underscores"
        />
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={ROLE_OPTIONS}
          disabled={isSelf}
          hint={isSelf ? "You can't change your own role" : 'Callers see only their current lead, callbacks and stats'}
        />
        {!editing && (
          <PasswordField value={password} onChange={setPassword} error={show(errors.password)} />
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PasswordField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <div className="password-row">
      <Input
        label="Temporary password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        autoComplete="new-password"
        spellCheck={false}
        className="mono"
        hint="Copy it now; it can't be viewed later. They choose their own at next sign-in"
        fieldClassName="password-input"
      />
      <Button icon={<IconRefresh />} onClick={() => onChange(generatePassword())} className="password-gen">
        Generate
      </Button>
    </div>
  );
}

function PasswordModal({ user, onClose }: { user: Profile | null; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPassword('');
    setSubmitted(false);
    setError('');
  }, [user]);

  const invalid = password.length < 8;
  const save = async () => {
    if (!user) return;
    setSubmitted(true);
    setError('');
    if (invalid) return;
    setSaving(true);
    try {
      await api.resetPassword(user.id, password);
      toast.success(`Password changed for ${user.fullName}.`);
      setPassword('');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      title={user ? `New password for ${user.fullName}` : ''}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Set password
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
        <PasswordField value={password} onChange={setPassword} error={submitted && invalid ? 'At least 8 characters' : undefined} />
        <p className="muted adm-small">The old password stops working immediately. They'll be asked to choose a new one when they sign in.</p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
