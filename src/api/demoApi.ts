/**
 * Demo implementation of `Api`: in-memory state persisted to localStorage, seeded
 * deterministically, no network. Enforces the same permissions the real backend will.
 */
import {
  ApiError,
  type Api,
  type CallListRow,
  type CallPatch,
  type CallQuery,
  type DispositionInput,
  type ImportLeadsInput,
  type ImportResult,
  type LeadFilter,
  type LeadPatch,
  type LeadQuery,
  MAX_SCRIPT_LENGTH,
  type MyScript,
  type NewCallInput,
  type NewNumberInput,
  type ChangePasswordInput,
  type NewUserInput,
  type NumberPatch,
  type UserPatch,
} from './Api';
import {
  DISPOSITIONS,
  type CallRecord,
  type Disposition,
  type Lead,
  type LeadList,
  type Metrics,
  type MetricsRange,
  type MetricsTotals,
  type Paged,
  type PhoneNumber,
  type Presence,
  type PresenceStatus,
  type Profile,
  type Role,
  type Settings,
} from '../types';
import { addDays, normalizePhone, phoneDigits, startOfDay, toDateKey } from '../lib/format';
import { DEMO_LOGIN_DOMAIN, LOGIN_DOMAIN, displayLogin } from '../lib/login';
import { PASSWORD_MESSAGES, newPasswordProblem } from '../lib/password';
import {
  DEMO_STATE_VERSION,
  applyDisposition,
  applyMissedDay,
  buildSeedState,
  chooseNumber,
  nextId,
  rampedCap,
  rankClaimable,
  type DemoState,
  type StoredNumber,
} from './demoSeed';

export const DEMO_STATE_KEY = `questlabs.demo.state.v${DEMO_STATE_VERSION}`;
export const DEMO_SESSION_KEY = `questlabs.demo.session.v${DEMO_STATE_VERSION}`;

const DAY_MS = 86_400_000;
const SIM_MANUAL_GRACE_MS = 2 * 60_000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DemoApiOptions {
  /** Defaults to window.localStorage when available; null = memory only. */
  storage?: StorageLike | null;
  /** Clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Move other demo callers' presence on a timer while someone subscribes. Default: true in a browser. */
  simulatePresence?: boolean;
  /** Seed only users, settings and numbers (no lists/leads/calls). For tests. */
  empty?: boolean;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* access denied */
  }
  return null;
}

const clone = <T>(v: T): T => structuredClone(v);

const DIALABLE = new Set(['new', 'no_answer', 'callback']);

function emptyTotals(): MetricsTotals {
  return { dials: 0, pickups: 0, pickupRate: 0, conversations: 0, bookings: 0, talkSeconds: 0, droppedPickups: 0 };
}

function addCall(t: MetricsTotals, c: CallRecord): void {
  if (c.direction === 'outbound') {
    t.dials += 1;
    if (c.result === 'answered' || c.result === 'dropped_pickup') t.pickups += 1;
  }
  if (c.result === 'answered' && c.talkSeconds >= 20) t.conversations += 1;
  if (c.disposition === 'booked') t.bookings += 1;
  if (c.result === 'dropped_pickup') t.droppedPickups += 1;
  t.talkSeconds += c.talkSeconds || 0;
}

function finish<T extends MetricsTotals>(t: T): T {
  t.pickupRate = t.dials ? t.pickups / t.dials : 0;
  return t;
}

function totalsOf(calls: CallRecord[]): MetricsTotals {
  const t = emptyTotals();
  for (const c of calls) addCall(t, c);
  return finish(t);
}

export class DemoApi implements Api {
  readonly kind = 'demo' as const;

  private readonly storage: StorageLike | null;
  private readonly now: () => number;
  private readonly simulate: boolean;
  private readonly empty: boolean;
  private _state: DemoState | null = null;
  private sessionUserId: string | null = null;
  private sessionLoaded = false;
  private authListeners = new Set<(p: Profile | null) => void>();
  private presenceListeners = new Set<(list: Presence[]) => void>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DemoApiOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.now = opts.now ?? (() => Date.now());
    this.simulate = opts.simulatePresence ?? typeof window !== 'undefined';
    this.empty = opts.empty ?? false;

    if (typeof window !== 'undefined' && this.storage && this.storage === defaultStorage()) {
      // Keep several windows (e.g. admin + caller) in sync.
      window.addEventListener('storage', (e) => {
        if (e.key === DEMO_STATE_KEY && e.newValue) {
          try {
            this._state = JSON.parse(e.newValue) as DemoState;
            this.emitPresence();
          } catch {
            /* ignore */
          }
        }
      });
      const flush = () => this.flush();
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', flush);
    }
  }

  // -------------------------------------------------------------------------
  // State plumbing
  // -------------------------------------------------------------------------

  private get state(): DemoState {
    if (!this._state) {
      let loaded: DemoState | null = null;
      if (this.storage) {
        try {
          const raw = this.storage.getItem(DEMO_STATE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as DemoState;
            if (parsed && parsed.version === DEMO_STATE_VERSION) loaded = parsed;
          }
        } catch {
          loaded = null;
        }
      }
      this._state = loaded ?? buildSeedState(this.now(), { empty: this.empty });
      if (!loaded) this.persistNow();
    }
    return this._state;
  }

  private persist(): void {
    if (!this.storage) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistNow();
    }, 150);
  }

  private persistNow(): void {
    if (!this.storage || !this._state) return;
    try {
      this.storage.setItem(DEMO_STATE_KEY, JSON.stringify(this._state));
    } catch {
      /* quota: keep in memory */
    }
  }

  /** Write pending changes to storage immediately. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.persistNow();
  }

  /** Wipe and re-seed. Keeps the session if that user still exists. */
  reset(): void {
    this._state = buildSeedState(this.now(), { empty: this.empty });
    this.flush();
    const me = this.currentUser();
    if (!me) this.setSession(null);
    this.emitPresence();
  }

  /** Raw state, for tests and debugging only. */
  debugState(): DemoState {
    return this.state;
  }

  private loadSession(): void {
    if (this.sessionLoaded) return;
    this.sessionLoaded = true;
    try {
      this.sessionUserId = this.storage?.getItem(DEMO_SESSION_KEY) ?? null;
    } catch {
      this.sessionUserId = null;
    }
  }

  private setSession(userId: string | null): void {
    this.sessionLoaded = true;
    this.sessionUserId = userId;
    try {
      if (userId) this.storage?.setItem(DEMO_SESSION_KEY, userId);
      else this.storage?.removeItem(DEMO_SESSION_KEY);
    } catch {
      /* ignore */
    }
    const p = this.currentUser();
    for (const cb of this.authListeners) cb(p ? clone(p) : null);
  }

  private currentUser(): Profile | null {
    this.loadSession();
    if (!this.sessionUserId) return null;
    const u = this.state.users.find((x) => x.id === this.sessionUserId);
    return u && u.active ? u : null;
  }

  private requireUser(): Profile {
    const u = this.currentUser();
    if (!u) throw new ApiError('not_authenticated', 'Please sign in.');
    return u;
  }

  private requireAdmin(): Profile {
    const u = this.requireUser();
    if (u.role !== 'admin') throw new ApiError('permission_denied', 'Only an admin can do that.');
    return u;
  }

  private requireCaller(): Profile {
    const u = this.requireUser();
    if (u.role !== 'caller') throw new ApiError('permission_denied', 'Only callers can dial leads.');
    return u;
  }

  private findLead(id: string): Lead {
    const l = this.state.leads.find((x) => x.id === id);
    if (!l) throw new ApiError('not_found', 'Lead not found.');
    return l;
  }

  private canCallerSee(lead: Lead, userId: string): boolean {
    return lead.lockedBy === userId || lead.callbackOwner === userId || lead.assignedTo === userId || lead.lastCalledBy === userId;
  }

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async signIn(email: string, password: string): Promise<Profile> {
    const e = email.trim().toLowerCase();
    let u = this.state.users.find((x) => x.email.toLowerCase() === e);
    if (!u) {
      // A bare username (or its internal address) also finds the demo account with that username.
      const at = e.lastIndexOf('@');
      const local = at < 0 ? e : e.slice(0, at);
      const domain = at < 0 ? LOGIN_DOMAIN : e.slice(at + 1);
      if (local && (domain === LOGIN_DOMAIN || domain === DEMO_LOGIN_DOMAIN)) {
        u = this.state.users.find((x) => {
          const xd = x.email.toLowerCase().split('@')[1];
          return (xd === LOGIN_DOMAIN || xd === DEMO_LOGIN_DOMAIN) && displayLogin(x.email).toLowerCase() === local;
        });
      }
    }
    if (!u || !password) throw new ApiError('invalid', 'Wrong username or password.');
    if (!u.active) throw new ApiError('permission_denied', 'This account has been deactivated.');
    this.setSession(u.id);
    // A caller who signs in shows as idle in the admin's live view straight away.
    if (u.role === 'caller') this.state.presence[u.id] = { status: 'idle', since: this.iso(), detail: null, manualAt: this.now() };
    this.persist();
    this.emitPresence();
    return clone(u);
  }

  async signInDemo(role: Role): Promise<Profile> {
    const u = [...this.state.users].filter((x) => x.role === role && x.active).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!u) throw new ApiError('not_found', `No active ${role} in the demo data.`);
    this.setSession(u.id);
    if (role === 'caller') this.state.presence[u.id] = { status: 'idle', since: this.iso(), detail: null, manualAt: this.now() };
    this.persist();
    this.emitPresence();
    return clone(u);
  }

  async signOut(): Promise<void> {
    const me = this.currentUser();
    if (me && me.role === 'caller') {
      for (const l of this.state.leads) if (l.lockedBy === me.id) {
        l.lockedBy = null;
        l.lockedAt = null;
      }
      this.state.presence[me.id] = { status: 'offline', since: this.iso(), detail: null, manualAt: this.now() };
      this.persist();
      this.emitPresence();
    }
    this.setSession(null);
  }

  async getSession(): Promise<Profile | null> {
    const u = this.currentUser();
    return u ? clone(u) : null;
  }

  onAuthChange(cb: (profile: Profile | null) => void): () => void {
    this.authListeners.add(cb);
    return () => {
      this.authListeners.delete(cb);
    };
  }

  mustChangePassword(): boolean {
    const u = this.currentUser();
    return Boolean(u && this.state.mustChangePassword?.[u.id]);
  }

  /** Demo: any non-empty current password is accepted; passwords are never stored. */
  async changeMyPassword(input: ChangePasswordInput): Promise<void> {
    const me = this.requireUser();
    if (!input.currentPassword) throw new ApiError('invalid', PASSWORD_MESSAGES.currentWrong);
    const problem = newPasswordProblem(input.newPassword, input.currentPassword);
    if (problem) throw new ApiError('invalid', problem);
    this.setMustChange(me.id, false);
  }

  private setMustChange(userId: string, on: boolean): void {
    const flags = (this.state.mustChangePassword ??= {});
    if (on) flags[userId] = true;
    else delete flags[userId];
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSettings(): Promise<Settings> {
    this.requireUser();
    return clone(this.state.settings);
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    this.requireAdmin();
    const next = { ...this.state.settings, ...patch };
    const intFields: (keyof Settings)[] = ['linesPerCaller', 'ringSeconds', 'retryDays', 'defaultDailyCap', 'rampDays', 'rampStartCap'];
    for (const f of intFields) {
      const v = next[f] as number;
      if (!Number.isFinite(v) || v < 0) throw new ApiError('invalid', `${f} must be a positive number.`);
    }
    if (next.linesPerCaller < 1 || next.linesPerCaller > 5) throw new ApiError('invalid', 'Lines per caller must be between 1 and 5.');
    if (next.ringSeconds < 5 || next.ringSeconds > 60) throw new ApiError('invalid', 'Ring time must be between 5 and 60 seconds.');
    if (next.retryDays < 1) throw new ApiError('invalid', 'Retry days must be at least 1.');
    this.state.settings = next;
    this.persist();
    return clone(next);
  }

  // -------------------------------------------------------------------------
  // My script
  // -------------------------------------------------------------------------

  async getMyScript(): Promise<MyScript> {
    const me = this.requireUser();
    const teamScript = this.state.settings.script;
    const mine = this.state.callerScripts?.[me.id];
    if (typeof mine === 'string' && mine.trim()) return { script: mine, isPersonal: true, teamScript };
    return { script: teamScript, isPersonal: false, teamScript };
  }

  async saveMyScript(script: string | null): Promise<void> {
    const me = this.requireUser();
    const scripts = (this.state.callerScripts ??= {});
    if (script == null || !script.trim()) {
      delete scripts[me.id];
    } else {
      if (script.length > MAX_SCRIPT_LENGTH) throw new ApiError('invalid', `Script is too long (max ${MAX_SCRIPT_LENGTH.toLocaleString('en-US')} characters).`);
      scripts[me.id] = script;
    }
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  /** Same address, or the same username across the internal and demo domains. */
  private loginTaken(email: string, exceptId?: string): boolean {
    const e = email.trim().toLowerCase();
    const name = displayLogin(e);
    return this.state.users.some((x) => x.id !== exceptId && (x.email.toLowerCase() === e || displayLogin(x.email.toLowerCase()) === name));
  }

  async listUsers(): Promise<Profile[]> {
    this.requireAdmin();
    return clone([...this.state.users].sort((a, b) => a.fullName.localeCompare(b.fullName)));
  }

  async createUser(input: NewUserInput): Promise<Profile> {
    this.requireAdmin();
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('invalid', 'Enter a valid username.');
    if (!input.fullName.trim()) throw new ApiError('invalid', 'Name is required.');
    if (!input.password || input.password.length < 8) throw new ApiError('invalid', 'Password must be at least 8 characters.');
    if (this.loginTaken(email)) throw new ApiError('conflict', 'That username is taken.');
    const u: Profile = { id: nextId(this.state, 'user'), email, fullName: input.fullName.trim(), role: input.role, active: true, createdAt: this.iso() };
    this.state.users.push(u);
    if (u.role === 'caller') this.state.presence[u.id] = { status: 'offline', since: this.iso(), detail: null, manualAt: this.now() };
    // The admin chose this password: the person picks their own at first sign-in.
    (this.state.mustChangePassword ??= {})[u.id] = true;
    this.persist();
    return clone(u);
  }

  async updateUser(id: string, patch: UserPatch): Promise<Profile> {
    const me = this.requireAdmin();
    const u = this.state.users.find((x) => x.id === id);
    if (!u) throw new ApiError('not_found', 'User not found.');
    if (id === me.id && (patch.active === false || (patch.role && patch.role !== 'admin'))) {
      throw new ApiError('invalid', 'You cannot deactivate or demote yourself.');
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (this.loginTaken(email, id)) throw new ApiError('conflict', 'That username is taken.');
      u.email = email;
    }
    if (patch.fullName !== undefined) u.fullName = patch.fullName.trim();
    if (patch.role !== undefined) u.role = patch.role;
    if (patch.active !== undefined) u.active = patch.active;
    if (!u.active || u.role !== 'caller') {
      for (const l of this.state.leads) if (l.lockedBy === u.id) {
        l.lockedBy = null;
        l.lockedAt = null;
      }
      if (this.state.presence[u.id]) this.state.presence[u.id] = { status: 'offline', since: this.iso(), detail: null, manualAt: this.now() };
    }
    this.persist();
    this.emitPresence();
    return clone(u);
  }

  async resetPassword(id: string, newPassword: string): Promise<void> {
    this.requireAdmin();
    if (!this.state.users.some((u) => u.id === id)) throw new ApiError('not_found', 'User not found.');
    if (!newPassword || newPassword.length < 8) throw new ApiError('invalid', 'Password must be at least 8 characters.');
    // Demo never stores passwords; it only remembers that this one was set by an admin.
    this.setMustChange(id, true);
  }

  // -------------------------------------------------------------------------
  // Lists & leads
  // -------------------------------------------------------------------------

  private toLeadList(l: { id: string; name: string; createdAt: string }): LeadList {
    let leadCount = 0;
    let remainingCount = 0;
    for (const x of this.state.leads) {
      if (x.listId !== l.id) continue;
      leadCount++;
      if (DIALABLE.has(x.status)) remainingCount++;
    }
    return { id: l.id, name: l.name, createdAt: l.createdAt, leadCount, remainingCount };
  }

  async listLeadLists(): Promise<LeadList[]> {
    this.requireAdmin();
    return [...this.state.lists].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((l) => this.toLeadList(l));
  }

  async createLeadList(name: string): Promise<LeadList> {
    this.requireAdmin();
    const n = name.trim();
    if (!n) throw new ApiError('invalid', 'List name is required.');
    const l = { id: nextId(this.state, 'list'), name: n, createdAt: this.iso() };
    this.state.lists.push(l);
    this.persist();
    return this.toLeadList(l);
  }

  async deleteLeadList(id: string): Promise<void> {
    this.requireAdmin();
    if (!this.state.lists.some((l) => l.id === id)) throw new ApiError('not_found', 'List not found.');
    this.state.lists = this.state.lists.filter((l) => l.id !== id);
    this.state.leads = this.state.leads.filter((l) => l.listId !== id);
    this.persist();
  }

  async importLeads(input: ImportLeadsInput): Promise<ImportResult> {
    this.requireAdmin();
    const callerIds = new Set(this.state.users.filter((u) => u.role === 'caller' && u.active).map((u) => u.id));
    const assign = input.assign;
    if (assign.mode === 'caller' && !callerIds.has(assign.callerId)) throw new ApiError('invalid', 'Choose an active caller.');
    if (assign.mode === 'round_robin') {
      if (assign.callerIds.length === 0) throw new ApiError('invalid', 'Choose at least one caller.');
      if (assign.callerIds.some((c) => !callerIds.has(c))) throw new ApiError('invalid', 'Round robin includes a user who is not an active caller.');
    }
    let listId: string;
    if (input.listId) {
      if (!this.state.lists.some((l) => l.id === input.listId)) throw new ApiError('not_found', 'List not found.');
      listId = input.listId;
    } else {
      const name = (input.newListName ?? '').trim();
      if (!name) throw new ApiError('invalid', 'List name is required.');
      listId = nextId(this.state, 'list');
      this.state.lists.push({ id: listId, name, createdAt: this.iso() });
    }
    const primaries = new Set(this.state.leads.flatMap((l) => l.phones).filter(Boolean));
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let rr = 0;
    const createdAt = this.now();
    for (const row of input.rows) {
      const phones: string[] = [];
      for (const p of row.phones ?? []) {
        const n = normalizePhone(p);
        if (n && !phones.includes(n)) phones.push(n);
        if (phones.length === 3) break;
      }
      const businessName = (row.businessName ?? '').trim();
      if (!businessName || phones.length === 0) {
        invalid++;
        continue;
      }
      if (phones.some(p=>primaries.has(p))) {
        duplicates++;
        continue;
      }
      phones.forEach(p=>primaries.add(p));
      let assignedTo: string | null = null;
      if (assign.mode === 'caller') assignedTo = assign.callerId;
      else if (assign.mode === 'round_robin') assignedTo = assign.callerIds[rr++ % assign.callerIds.length];
      this.state.leads.push({
        id: nextId(this.state, 'lead'),
        listId,
        businessName,
        contactName: (row.contactName ?? '').trim(),
        phones,
        email: (row.email ?? '').trim(),
        city: (row.city ?? '').trim(),
        state: (row.state ?? '').trim().toUpperCase().slice(0, 2),
        notes: (row.notes ?? '').trim(),
        status: 'new',
        assignedTo,
        attemptDays: 0,
        lastCalledAt: null,
        lastCalledBy: null,
        nextCallAt: null,
        callbackAt: null,
        callbackOwner: null,
        lockedBy: null,
        lockedAt: null,
        createdAt: this.iso(createdAt + imported),
      });
      imported++;
    }
    this.persist();
    return { listId, imported, duplicates, invalid };
  }

  private filterLeads(f: LeadFilter): Lead[] {
    const statuses = f.status === undefined ? null : new Set(Array.isArray(f.status) ? f.status : [f.status]);
    const q = (f.search ?? '').trim().toLowerCase();
    const qDigits = phoneDigits(q);
    return this.state.leads.filter((l) => {
      if (f.listId && l.listId !== f.listId) return false;
      if (statuses && !statuses.has(l.status)) return false;
      if (f.assignedTo === 'pool' && l.assignedTo !== null) return false;
      if (f.assignedTo && f.assignedTo !== 'pool' && l.assignedTo !== f.assignedTo) return false;
      if (q) {
        const text = `${l.businessName} ${l.contactName} ${l.email} ${l.city}`.toLowerCase();
        const phoneHit = qDigits.length >= 3 && l.phones.some((p) => p.replace(/\D/g, '').includes(qDigits));
        if (!text.includes(q) && !phoneHit) return false;
      }
      return true;
    });
  }

  async queryLeads(query: LeadQuery): Promise<Paged<Lead>> {
    this.requireAdmin();
    const rows = this.filterLeads(query);
    const sort = query.sort ?? { field: 'createdAt', dir: 'desc' as const };
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = a[sort.field];
      const bv = b[sort.field];
      if (av === bv) return a.id.localeCompare(b.id);
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    const size = Math.max(1, query.pageSize);
    const page = Math.max(1, query.page);
    return { rows: clone(rows.slice((page - 1) * size, page * size)), total: rows.length };
  }

  async getLead(id: string): Promise<Lead> {
    const me = this.requireUser();
    const l = this.findLead(id);
    if (me.role !== 'admin' && !this.canCallerSee(l, me.id)) throw new ApiError('permission_denied', 'You do not have access to this lead.');
    return clone(l);
  }

  async updateLead(id: string, patch: LeadPatch): Promise<Lead> {
    const me = this.requireUser();
    const l = this.findLead(id);
    if (me.role !== 'admin') {
      if (l.lockedBy !== me.id && l.callbackOwner !== me.id) throw new ApiError('permission_denied', 'You can only edit the lead you are working.');
      const allowed = new Set(['contactName', 'email', 'businessName', 'notes']);
      for (const k of Object.keys(patch)) if (!allowed.has(k)) throw new ApiError('permission_denied', `Callers cannot change ${k}.`);
    }
    if (patch.phones !== undefined) {
      const phones: string[] = [];
      for (const p of patch.phones) {
        const n = normalizePhone(p);
        if (!n) throw new ApiError('invalid', `Invalid phone number: ${p}`);
        if (!phones.includes(n)) phones.push(n);
      }
      if (phones.length > 3) throw new ApiError('invalid', 'A lead can have at most 3 phone numbers.');
      patch = { ...patch, phones };
    }
    if (patch.listId !== undefined && !this.state.lists.some((x) => x.id === patch.listId)) throw new ApiError('not_found', 'List not found.');
    if (patch.status === 'callback' && !(patch.callbackAt ?? l.callbackAt)) throw new ApiError('invalid', 'A callback needs a callback time.');
    Object.assign(l, patch);
    if (patch.status === 'callback' && patch.nextCallAt === undefined) l.nextCallAt = l.callbackAt;
    this.persist();
    return clone(l);
  }

  async assignLeads(input: { leadIds: string[]; assignTo: string | null }): Promise<number> {
    this.requireAdmin();
    if (input.assignTo !== null && !this.state.users.some((u) => u.id === input.assignTo && u.role === 'caller')) {
      throw new ApiError('invalid', 'Leads can only be assigned to a caller.');
    }
    const ids = new Set(input.leadIds);
    let n = 0;
    for (const l of this.state.leads) if (ids.has(l.id)) {
      l.assignedTo = input.assignTo;
      n++;
    }
    this.persist();
    return n;
  }

  async deleteLeads(ids: string[]): Promise<number> {
    this.requireAdmin();
    const set = new Set(ids);
    const before = this.state.leads.length;
    this.state.leads = this.state.leads.filter((l) => !set.has(l.id));
    this.persist();
    return before - this.state.leads.length;
  }

  async exportLeads(filter: LeadFilter): Promise<Lead[]> {
    this.requireAdmin();
    return clone(this.filterLeads(filter));
  }

  async getLeadHistory(leadId: string): Promise<CallRecord[]> {
    const me = this.requireUser();
    const l = this.findLead(leadId);
    if (me.role !== 'admin' && !this.canCallerSee(l, me.id)) throw new ApiError('permission_denied', 'You do not have access to this lead.');
    return clone(this.state.calls.filter((c) => c.leadId === leadId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }

  // -------------------------------------------------------------------------
  // Caller queue
  // -------------------------------------------------------------------------

  async claimNextLeads(count: number): Promise<Lead[]> {
    const me = this.requireCaller();
    const n = Math.max(0, Math.min(10, Math.floor(count)));
    if (n === 0) return [];
    const now = this.now();
    const picked = rankClaimable(this.state.leads, me.id, now).slice(0, n);
    const at = this.iso(now);
    for (const l of picked) {
      l.lockedBy = me.id;
      l.lockedAt = at;
    }
    this.persist();
    return clone(picked);
  }

  async releaseLeads(ids: string[]): Promise<void> {
    const me = this.requireUser();
    const set = new Set(ids);
    for (const l of this.state.leads) if (set.has(l.id) && l.lockedBy === me.id) {
      l.lockedBy = null;
      l.lockedAt = null;
    }
    this.persist();
  }

  private requireWorkable(leadId: string, me: Profile): Lead {
    const l = this.findLead(leadId);
    if (me.role !== 'admin' && l.lockedBy && l.lockedBy !== me.id && !this.canCallerSee(l, me.id)) {
      throw new ApiError('permission_denied', 'This lead is held by another caller.');
    }
    return l;
  }

  async reportMissedDay(leadId: string): Promise<Lead> {
    const me = this.requireUser();
    const l = this.requireWorkable(leadId, me);
    applyMissedDay(l, me.id, this.now(), this.state.settings);
    this.persist();
    return clone(l);
  }

  async reportBadNumber(leadId: string, phone: string): Promise<Lead> {
    const me = this.requireUser();
    const l = this.requireWorkable(leadId, me);
    const target = normalizePhone(phone) ?? phone;
    l.phones = l.phones.filter((p) => p !== target);
    if (l.phones.length === 0) {
      l.status = 'bad_number';
      l.nextCallAt = null;
      l.lockedBy = null;
      l.lockedAt = null;
      l.lastCalledAt = this.iso();
      l.lastCalledBy = me.id;
    }
    this.persist();
    return clone(l);
  }

  async getMyCallbacks(): Promise<Lead[]> {
    const me = this.requireUser();
    return clone(
      this.state.leads
        .filter((l) => l.status === 'callback' && l.callbackOwner === me.id)
        .sort((a, b) => (a.callbackAt ?? '').localeCompare(b.callbackAt ?? '')),
    );
  }

  async findLeadByPhone(phone: string): Promise<Lead | null> {
    this.requireUser();
    const n = normalizePhone(phone);
    if (!n) return null;
    const l = this.state.leads.find((x) => x.phones.includes(n));
    return l ? clone(l) : null;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  async createCall(input: NewCallInput): Promise<CallRecord> {
    const me = this.requireUser();
    const callerId = input.callerId === undefined ? me.id : input.callerId;
    if (me.role !== 'admin' && callerId !== me.id) throw new ApiError('permission_denied', 'You can only log your own calls.');
    const lead = input.leadId ? this.state.leads.find((l) => l.id === input.leadId) ?? null : null;
    if (input.leadId && !lead) throw new ApiError('not_found', 'Lead not found.');
    const rec: CallRecord = {
      id: nextId(this.state, 'call'),
      leadId: input.leadId,
      listId: lead?.listId ?? null,
      callerId,
      direction: input.direction,
      fromNumber: normalizePhone(input.fromNumber) ?? input.fromNumber,
      toNumber: normalizePhone(input.toNumber) ?? input.toNumber,
      ring: input.ring,
      startedAt: input.startedAt ? new Date(input.startedAt).toISOString() : this.iso(),
      answeredAt: input.answeredAt ?? null,
      endedAt: input.endedAt ?? null,
      talkSeconds: input.talkSeconds ?? 0,
      result: input.result ?? null,
      disposition: null,
      notes: input.notes ?? '',
      recordingUrl: input.recordingUrl ?? null,
      providerCallId: input.providerCallId ?? null,
    };
    this.state.calls.push(rec);
    if (lead && input.direction === 'outbound' && callerId) {
      lead.lastCalledAt = rec.startedAt;
      lead.lastCalledBy = callerId;
    }
    this.persist();
    return clone(rec);
  }

  async updateCall(id: string, patch: CallPatch): Promise<CallRecord> {
    const me = this.requireUser();
    const c = this.state.calls.find((x) => x.id === id);
    if (!c) throw new ApiError('not_found', 'Call not found.');
    if (me.role !== 'admin' && c.callerId !== me.id) throw new ApiError('permission_denied', 'You can only update your own calls.');
    Object.assign(c, patch);
    this.persist();
    return clone(c);
  }

  async saveDisposition(input: DispositionInput): Promise<Lead> {
    const me = this.requireUser();
    const c = this.state.calls.find((x) => x.id === input.callId);
    if (!c) throw new ApiError('not_found', 'Call not found.');
    if (me.role !== 'admin' && c.callerId !== me.id) throw new ApiError('permission_denied', 'You can only disposition your own calls.');
    const lead = this.requireWorkable(input.leadId, me);
    if (!DISPOSITIONS.some((d) => d.value === input.disposition)) throw new ApiError('invalid', 'Unknown outcome.');
    let callbackAt: string | null = null;
    if (input.disposition === 'callback') {
      if (!input.callbackAt || Number.isNaN(Date.parse(input.callbackAt))) throw new ApiError('invalid', 'Pick a callback time.');
      callbackAt = new Date(input.callbackAt).toISOString();
    }
    c.disposition = input.disposition;
    c.notes = input.notes ?? '';
    applyDisposition(lead, input.disposition, c.callerId ?? me.id, this.now(), this.state.settings, callbackAt);
    this.persist();
    return clone(lead);
  }

  async listCalls(query: CallQuery): Promise<Paged<CallListRow>> {
    const me = this.requireUser();
    const callerId = me.role === 'admin' ? query.callerId : me.id;
    const results = query.results ? new Set(query.results) : null;
    const rows = this.state.calls.filter((c) => {
      if (callerId && c.callerId !== callerId) return false;
      if (query.leadId && c.leadId !== query.leadId) return false;
      if (query.from && c.startedAt < query.from) return false;
      if (query.to && c.startedAt >= query.to) return false;
      if (query.onlyRecorded && !c.recordingUrl) return false;
      if (results && (!c.result || !results.has(c.result))) return false;
      return true;
    });
    rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const size = Math.max(1, query.pageSize);
    const page = Math.max(1, query.page);
    const leads = new Map(this.state.leads.map((l) => [l.id, l]));
    const users = new Map(this.state.users.map((u) => [u.id, u]));
    const out: CallListRow[] = rows.slice((page - 1) * size, page * size).map((c) => {
      const l = c.leadId ? leads.get(c.leadId) : undefined;
      return {
        ...clone(c),
        businessName: l?.businessName ?? null,
        contactName: l?.contactName ?? null,
        callerName: c.callerId ? users.get(c.callerId)?.fullName ?? null : null,
      };
    });
    return { rows: out, total: rows.length };
  }

  // -------------------------------------------------------------------------
  // Numbers
  // -------------------------------------------------------------------------

  private deriveNumbers(): PhoneNumber[] {
    const now = this.now();
    const todayStart = startOfDay(now).toISOString();
    const weekAgo = this.iso(now - 7 * DAY_MS);
    const stats = new Map<string, { today: number; d7: number; p7: number }>();
    let fleetDials = 0;
    let fleetPickups = 0;
    for (const c of this.state.calls) {
      if (c.direction !== 'outbound') continue;
      let s = stats.get(c.fromNumber);
      if (!s) {
        s = { today: 0, d7: 0, p7: 0 };
        stats.set(c.fromNumber, s);
      }
      if (c.startedAt >= todayStart) s.today++;
      if (c.startedAt >= weekAgo) {
        s.d7++;
        fleetDials++;
        if (c.result === 'answered' || c.result === 'dropped_pickup') {
          s.p7++;
          fleetPickups++;
        }
      }
    }
    const fleetRate = fleetDials ? fleetPickups / fleetDials : 0;
    return this.state.numbers.map((n: StoredNumber) => {
      const s = stats.get(n.number) ?? { today: 0, d7: 0, p7: 0 };
      const rate = s.d7 ? s.p7 / s.d7 : 0;
      return {
        ...n,
        effectiveCapToday: rampedCap(n.dailyCap, n.addedAt, now, this.state.settings),
        callsToday: s.today,
        calls7d: s.d7,
        pickupRate7d: rate,
        flagged: s.d7 >= 30 && fleetRate > 0 && rate < fleetRate * 0.5,
      };
    });
  }

  async listNumbers(): Promise<PhoneNumber[]> {
    this.requireAdmin();
    return this.deriveNumbers().sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  async pickFromNumber(toPhone: string): Promise<PhoneNumber | null> {
    this.requireUser();
    const candidates = this.deriveNumbers().filter((n) => n.active && n.callsToday < n.effectiveCapToday);
    const picked = chooseNumber(candidates, normalizePhone(toPhone) ?? toPhone);
    return picked ? clone(picked) : null;
  }

  async addNumber(input: NewNumberInput): Promise<PhoneNumber> {
    this.requireAdmin();
    const number = normalizePhone(input.number);
    if (!number) throw new ApiError('invalid', 'Enter a valid phone number.');
    if (this.state.numbers.some((n) => n.number === number)) throw new ApiError('conflict', 'That number is already added.');
    const cap = input.dailyCap ?? this.state.settings.defaultDailyCap;
    if (!Number.isFinite(cap) || cap < 1) throw new ApiError('invalid', 'Daily cap must be at least 1.');
    const n: StoredNumber = {
      id: nextId(this.state, 'num'),
      number,
      label: (input.label ?? '').trim(),
      active: input.active ?? true,
      dailyCap: Math.floor(cap),
      addedAt: this.iso(),
      providerId: null,
    };
    this.state.numbers.push(n);
    this.persist();
    return this.deriveNumbers().find((x) => x.id === n.id)!;
  }

  async updateNumber(id: string, patch: NumberPatch): Promise<PhoneNumber> {
    this.requireAdmin();
    const n = this.state.numbers.find((x) => x.id === id);
    if (!n) throw new ApiError('not_found', 'Number not found.');
    if (patch.dailyCap !== undefined && (!Number.isFinite(patch.dailyCap) || patch.dailyCap < 1)) throw new ApiError('invalid', 'Daily cap must be at least 1.');
    if (patch.label !== undefined) n.label = patch.label.trim();
    if (patch.active !== undefined) n.active = patch.active;
    if (patch.dailyCap !== undefined) n.dailyCap = Math.floor(patch.dailyCap);
    this.persist();
    return this.deriveNumbers().find((x) => x.id === id)!;
  }

  async removeNumber(id: string): Promise<void> {
    this.requireAdmin();
    if (!this.state.numbers.some((n) => n.id === id)) throw new ApiError('not_found', 'Number not found.');
    this.state.numbers = this.state.numbers.filter((n) => n.id !== id);
    this.persist();
  }

  async syncNumbersFromTelnyx(): Promise<PhoneNumber[]> {
    return this.listNumbers();
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  private presenceList(): Presence[] {
    return this.state.users
      .filter((u) => u.role === 'caller' && u.active)
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((u) => {
        const p = this.state.presence[u.id];
        return {
          callerId: u.id,
          fullName: u.fullName,
          status: p?.status ?? 'offline',
          since: p?.since ?? u.createdAt,
          detail: p?.detail ?? null,
        };
      });
  }

  private emitPresence(): void {
    if (this.presenceListeners.size === 0) return;
    const list = this.presenceList();
    for (const cb of this.presenceListeners) cb(clone(list));
  }

  async setPresence(status: PresenceStatus, detail?: string | null): Promise<void> {
    const me = this.requireUser();
    if (me.role !== 'caller') return;
    const prev = this.state.presence[me.id];
    const since = prev && prev.status === status ? prev.since : this.iso();
    this.state.presence[me.id] = { status, since, detail: detail ?? null, manualAt: this.now() };
    this.persist();
    this.emitPresence();
  }

  async listPresence(): Promise<Presence[]> {
    this.requireAdmin();
    return this.presenceList();
  }

  subscribePresence(cb: (list: Presence[]) => void): () => void {
    this.presenceListeners.add(cb);
    const me = this.currentUser();
    queueMicrotask(() => {
      if (this.presenceListeners.has(cb)) cb(me && me.role === 'admin' ? this.presenceList() : []);
    });
    this.ensurePresenceTimer();
    return () => {
      this.presenceListeners.delete(cb);
      if (this.presenceListeners.size === 0 && this.presenceTimer) {
        clearInterval(this.presenceTimer);
        this.presenceTimer = null;
      }
    };
  }

  private ensurePresenceTimer(): void {
    if (!this.simulate || this.presenceTimer) return;
    this.presenceTimer = setInterval(() => this.tickPresence(), 3500);
  }

  /** Moves one simulated caller to a plausible next status. */
  private tickPresence(): void {
    const now = this.now();
    const me = this.currentUser();
    const sims = this.state.users.filter((u) => {
      if (u.role !== 'caller' || !u.active || u.id === me?.id) return false;
      const p = this.state.presence[u.id];
      return !(p?.manualAt && now - p.manualAt < SIM_MANUAL_GRACE_MS);
    });
    if (sims.length === 0) return;
    const u = sims[Math.floor(Math.random() * sims.length)];
    const p = this.state.presence[u.id] ?? { status: 'idle' as PresenceStatus, since: this.iso(now), detail: null, manualAt: null };
    const r = Math.random();
    let next: PresenceStatus = p.status;
    switch (p.status) {
      case 'offline':
      case 'idle':
        next = r < 0.7 ? 'dialing' : p.status;
        break;
      case 'dialing':
        next = r < 0.35 ? 'on_call' : r < 0.4 ? 'paused' : 'dialing';
        break;
      case 'on_call':
        next = r < 0.4 ? 'wrap_up' : 'on_call';
        break;
      case 'wrap_up':
        next = r < 0.7 ? 'dialing' : 'wrap_up';
        break;
      case 'paused':
        next = r < 0.3 ? 'dialing' : 'paused';
        break;
    }
    if (next === p.status) return;
    let detail: string | null = null;
    if (next === 'on_call' || next === 'wrap_up') {
      const leads = this.state.leads;
      detail = next === 'wrap_up' && p.detail ? p.detail : leads.length ? leads[Math.floor(Math.random() * leads.length)].businessName : null;
    }
    this.state.presence[u.id] = { status: next, since: this.iso(now), detail, manualAt: null };
    this.emitPresence();
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  private callsIn(fromIso: string, toIso: string): CallRecord[] {
    return this.state.calls.filter((c) => c.startedAt >= fromIso && c.startedAt < toIso);
  }

  async getMetrics(range: MetricsRange): Promise<Metrics> {
    this.requireAdmin();
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new ApiError('invalid', 'Invalid date range.');
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const calls = this.callsIn(from, to);
    const prev = this.callsIn(new Date(fromMs - (toMs - fromMs)).toISOString(), from);

    const users = new Map(this.state.users.map((u) => [u.id, u]));
    const byCaller = new Map<string, MetricsTotals>();
    for (const u of this.state.users) if (u.role === 'caller') byCaller.set(u.id, emptyTotals());

    const byDay = new Map<string, MetricsTotals>();
    const dayLabels: { date: string; label: string }[] = [];
    for (let d = startOfDay(fromMs); d.getTime() < toMs; d = addDays(d, 1)) {
      const key = toDateKey(d);
      byDay.set(key, emptyTotals());
      dayLabels.push({ date: key, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) });
    }

    const numberIds = new Map(this.state.numbers.map((n) => [n.number, n]));
    const byNumber = new Map<string, MetricsTotals>();
    for (const n of this.state.numbers) byNumber.set(n.number, emptyTotals());

    const lists = new Map(this.state.lists.map((l) => [l.id, l]));
    const byList = new Map<string, MetricsTotals>();
    for (const l of this.state.lists) byList.set(l.id, emptyTotals());

    const outcomes = new Map<Disposition, number>(DISPOSITIONS.map((d) => [d.value, 0]));

    const get = (m: Map<string, MetricsTotals>, k: string) => {
      let t = m.get(k);
      if (!t) {
        t = emptyTotals();
        m.set(k, t);
      }
      return t;
    };

    for (const c of calls) {
      if (c.callerId) addCall(get(byCaller, c.callerId), c);
      addCall(get(byDay, toDateKey(c.startedAt)), c);
      addCall(get(byNumber, c.direction === 'outbound' ? c.fromNumber : c.toNumber), c);
      if (c.listId) addCall(get(byList, c.listId), c);
      if (c.disposition) outcomes.set(c.disposition, (outcomes.get(c.disposition) ?? 0) + 1);
    }

    return {
      range: { from, to },
      totals: totalsOf(calls),
      previousTotals: totalsOf(prev),
      byCaller: [...byCaller.entries()]
        .map(([callerId, t]) => finish({ ...t, callerId, label: users.get(callerId)?.fullName ?? 'Unknown user' }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      byDay: dayLabels.map(({ date, label }) => finish({ ...(byDay.get(date) ?? emptyTotals()), date, label })),
      byNumber: [...byNumber.entries()].map(([number, t]) => {
        const n = numberIds.get(number);
        return finish({ ...t, number, numberId: n?.id ?? null, label: n ? n.label || number : `${number} (removed)` });
      }),
      byList: [...byList.entries()].map(([listId, t]) => finish({ ...t, listId, label: lists.get(listId)?.name ?? 'Deleted list' })),
      outcomes: DISPOSITIONS.map((d) => ({ disposition: d.value, label: d.label, count: outcomes.get(d.value) ?? 0 })),
    };
  }

  async getMyStatsToday(): Promise<MetricsTotals> {
    const me = this.requireUser();
    const from = startOfDay(this.now()).toISOString();
    return totalsOf(this.state.calls.filter((c) => c.callerId === me.id && c.startedAt >= from));
  }

  async getTelephonyToken(): Promise<string> {
    this.requireUser();
    return 'demo';
  }
}

/** The app-wide demo instance (used by `src/api/index.ts` when Supabase isn't configured). */
export const demoApi = new DemoApi();

/** Wipes demo data in localStorage and re-seeds. Reload the page afterwards for a clean UI. */
export function resetDemoData(): void {
  demoApi.reset();
}
