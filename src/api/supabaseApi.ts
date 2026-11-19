/**
 * Supabase implementation of `Api`. Talks to the schema, RLS policies and functions in
 * `supabase/migrations/0001_core.sql` and to the `admin-users` Edge Function. Only the public URL
 * and the anon key are used here; every rule is enforced server-side.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
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
import { normalizePhone } from '../lib/format';
import { getSupabase } from './supabaseClient';
import { newPasswordProblem } from '../lib/password';
import {
  callFromRow,
  callListRowFromRow,
  callPatchToRow,
  importRowToJson,
  leadFromRow,
  leadListFromRow,
  leadPatchToRow,
  leadSortColumn,
  metricsFromJson,
  myScriptFromJson,
  newCallToRow,
  normalizePhoneList,
  numberFromRow,
  presenceFromRow,
  profileFromRow,
  settingsFromRow,
  settingsToRow,
  totalsFromJson,
  type Row,
} from './supabaseMappers';
import {
  DEACTIVATED_MESSAGE,
  mustChangeFromUser,
  translatePasswordChangeError,
  isDeactivationError,
  translateError,
  translateFunctionResponse,
  type MessageOverrides,
} from './supabaseErrors';

const HEARTBEAT_MS = 30_000;
const PRESENCE_REFRESH_MS = 30_000;
const IMPORT_CHUNK = 500;
const EXPORT_PAGE = 1000;
const EXPORT_PARALLEL = 4;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clone = <T>(v: T): T => structuredClone(v);

export class SupabaseApi implements Api {
  readonly kind = 'supabase' as const;

  /** Why the user was signed out automatically (e.g. deactivated), for the login screen. */
  signOutReason: string | null = null;

  private _sb: SupabaseClient | null = null;
  private profile: Profile | null = null;
  /** user_metadata.must_change_password of the signed-in Auth user. */
  private mustChange = false;
  private ready: Promise<void> | null = null;
  private authListeners = new Set<(p: Profile | null) => void>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastPresence: { status: PresenceStatus; detail: string | null } | null = null;

  constructor(
    readonly url: string,
    readonly anonKey: string,
  ) {}

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private get sb(): SupabaseClient {
    if (!this._sb) this._sb = getSupabase();
    return this._sb;
  }

  /** Loads the session once and keeps the cached profile in sync with Supabase Auth. */
  private init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const sb = this.sb;
      sb.auth.onAuthStateChange((event, session) => {
        // Never await Supabase calls inside this callback (supabase-js may deadlock); defer.
        setTimeout(() => {
          if (event === 'SIGNED_OUT' || !session) {
            this.mustChange = false;
            this.setProfile(null);
            return;
          }
          this.mustChange = mustChangeFromUser(session.user);
          if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
            if (this.profile && this.profile.id === session.user.id && event === 'SIGNED_IN') return;
            void this.loadProfile(session.user.id).catch(() => undefined);
          }
        }, 0);
      });
      try {
        const { data } = await sb.auth.getSession();
        if (data.session) {
          this.mustChange = mustChangeFromUser(data.session.user);
          await this.loadProfile(data.session.user.id);
        }
      } catch {
        this.profile = null;
      }
    })();
    return this.ready;
  }

  private setProfile(p: Profile | null): void {
    const before = this.profile ? JSON.stringify(this.profile) : null;
    this.profile = p;
    if (!p) this.stopHeartbeat();
    const after = p ? JSON.stringify(p) : null;
    if (before === after) return;
    for (const cb of this.authListeners) cb(p ? clone(p) : null);
  }

  /** Reads my profile; signs out (with a reason) when it is missing or inactive. */
  private async loadProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw translateError(error);
    if (!data) {
      await this.forceSignOut('Your account has no profile. Ask an admin to add you.');
      return null;
    }
    const p = profileFromRow(data as Row);
    if (!p.active) {
      await this.forceSignOut(DEACTIVATED_MESSAGE);
      return null;
    }
    this.signOutReason = null;
    this.setProfile(p);
    return p;
  }

  private async forceSignOut(reason: string): Promise<void> {
    this.signOutReason = reason;
    this.stopHeartbeat();
    try {
      await this.sb.auth.signOut({ scope: 'local' });
    } catch {
      /* ignore */
    }
    this.setProfile(null);
  }

  private async me(): Promise<Profile> {
    await this.init();
    if (!this.profile) throw new ApiError('not_authenticated', 'Please sign in.');
    return this.profile;
  }

  private async admin(): Promise<Profile> {
    const me = await this.me();
    if (me.role !== 'admin') throw new ApiError('permission_denied', 'Only an admin can do that.');
    return me;
  }

  private async caller(): Promise<Profile> {
    const me = await this.me();
    if (me.role !== 'caller') throw new ApiError('permission_denied', 'Only callers can dial leads.');
    return me;
  }

  /** Converts an error and signs out locally when it says the account is deactivated. */
  private fail(error: unknown, overrides?: MessageOverrides): ApiError {
    if (isDeactivationError(error)) void this.forceSignOut(DEACTIVATED_MESSAGE);
    return translateError(error, overrides);
  }

  private async rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}, overrides?: MessageOverrides): Promise<T> {
    let res;
    try {
      res = await this.sb.rpc(fn, args);
    } catch (e) {
      throw this.fail(e, overrides);
    }
    if (res.error) throw this.fail(res.error, overrides);
    return res.data as T;
  }

  /** Invokes one of our Edge Functions and returns its JSON body. */
  private async invoke<T = unknown>(fn: string, body?: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await this.sb.functions.invoke(fn, { body: body ?? {} });
    } catch (e) {
      throw this.fail(e);
    }
    if (res.error) {
      const err = res.error as { name?: string; context?: unknown };
      if (err.name === 'FunctionsHttpError' && err.context instanceof Response) {
        let parsed: unknown = null;
        try {
          parsed = await err.context.clone().json();
        } catch {
          parsed = null;
        }
        const apiErr = translateFunctionResponse(fn, err.context.status, parsed);
        if (apiErr.message === DEACTIVATED_MESSAGE) void this.forceSignOut(DEACTIVATED_MESSAGE);
        throw apiErr;
      }
      throw this.fail(res.error);
    }
    return res.data as T;
  }

  private rows(data: unknown): Row[] {
    return Array.isArray(data) ? (data as Row[]) : data && typeof data === 'object' ? [data as Row] : [];
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async signIn(email: string, password: string): Promise<Profile> {
    await this.init();
    const e = email.trim().toLowerCase();
    if (!e || !password) throw new ApiError('invalid', 'Wrong username or password.');
    const { data, error } = await this.sb.auth.signInWithPassword({ email: e, password });
    if (error || !data.user) throw translateError(error ?? new Error('Sign-in failed.'));
    this.mustChange = mustChangeFromUser(data.user);
    const p = await this.loadProfile(data.user.id);
    if (!p) throw new ApiError('permission_denied', this.signOutReason ?? DEACTIVATED_MESSAGE);
    return clone(p);
  }

  async signInDemo(_role: Role): Promise<Profile> {
    throw new ApiError('not_implemented', 'Demo sign-in is only available in demo mode.');
  }

  async signOut(): Promise<void> {
    await this.init();
    this.stopHeartbeat();
    if (this.profile) {
      try {
        await this.sb.rpc('go_offline');
      } catch {
        /* best effort */
      }
    }
    try {
      await this.sb.auth.signOut();
    } catch {
      await this.sb.auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
    this.signOutReason = null;
    this.setProfile(null);
  }

  async getSession(): Promise<Profile | null> {
    await this.init();
    return this.profile ? clone(this.profile) : null;
  }

  onAuthChange(cb: (profile: Profile | null) => void): () => void {
    this.authListeners.add(cb);
    void this.init();
    return () => {
      this.authListeners.delete(cb);
    };
  }

  mustChangePassword(): boolean {
    return Boolean(this.profile) && this.mustChange;
  }

  async changeMyPassword(input: ChangePasswordInput): Promise<void> {
    const me = await this.me();
    const problem = newPasswordProblem(input.newPassword, input.currentPassword);
    if (problem) throw new ApiError('invalid', problem);
    // Verify the current password by signing in again with it (same account, fresh session).
    let verify;
    try {
      verify = await this.sb.auth.signInWithPassword({ email: me.email.trim().toLowerCase(), password: input.currentPassword });
    } catch (e) {
      throw translatePasswordChangeError(e, 'verify');
    }
    if (verify.error || !verify.data.user) throw translatePasswordChangeError(verify.error ?? new Error('Could not check your password.'), 'verify');
    if (verify.data.user.id !== me.id) throw new ApiError('invalid', 'Could not check your password.');
    let res;
    try {
      res = await this.sb.auth.updateUser({ password: input.newPassword, data: { must_change_password: false } });
    } catch (e) {
      throw translatePasswordChangeError(e, 'update');
    }
    if (res.error) throw translatePasswordChangeError(res.error, 'update');
    this.mustChange = mustChangeFromUser(res.data.user);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSettings(): Promise<Settings> {
    await this.me();
    const { data, error } = await this.sb.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw this.fail(error);
    if (!data) throw new ApiError('not_found', 'Settings are missing (run supabase/migrations/0001_core.sql).');
    return settingsFromRow(data as Row);
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.admin();
    const next = { ...(await this.getSettings()), ...patch };
    const intFields: (keyof Settings)[] = ['linesPerCaller', 'ringSeconds', 'retryDays', 'defaultDailyCap', 'rampDays', 'rampStartCap'];
    for (const f of intFields) {
      const v = next[f] as number;
      if (!Number.isFinite(v) || v < 0) throw new ApiError('invalid', `${f} must be a positive number.`);
    }
    if (next.linesPerCaller < 1 || next.linesPerCaller > 5) throw new ApiError('invalid', 'Lines per caller must be between 1 and 5.');
    if (next.ringSeconds < 5 || next.ringSeconds > 60) throw new ApiError('invalid', 'Ring time must be between 5 and 60 seconds.');
    if (next.retryDays < 1) throw new ApiError('invalid', 'Retry days must be at least 1.');
    const cleaned: Partial<Settings> = { ...patch };
    for (const f of intFields) {
      if (cleaned[f] !== undefined) (cleaned as Record<string, unknown>)[f] = Math.floor(cleaned[f] as number);
    }
    const row = settingsToRow(cleaned);
    if (Object.keys(row).length === 0) return next;
    const { data, error } = await this.sb.from('settings').update(row).eq('id', 1).select('*').maybeSingle();
    if (error) throw this.fail(error);
    if (!data) throw new ApiError('permission_denied', 'Only an admin can do that.');
    return settingsFromRow(data as Row);
  }

  // -------------------------------------------------------------------------
  // My script
  // -------------------------------------------------------------------------

  async getMyScript(): Promise<MyScript> {
    await this.me();
    return myScriptFromJson(await this.rpc('get_my_script'));
  }

  async saveMyScript(script: string | null): Promise<void> {
    await this.me();
    const value = script == null || !script.trim() ? null : script;
    if (value && value.length > MAX_SCRIPT_LENGTH) {
      throw new ApiError('invalid', `Script is too long (max ${MAX_SCRIPT_LENGTH.toLocaleString('en-US')} characters).`);
    }
    await this.rpc('save_my_script', { p_script: value });
  }

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  async listUsers(): Promise<Profile[]> {
    await this.admin();
    const { data, error } = await this.sb.from('profiles').select('*');
    if (error) throw this.fail(error);
    return this.rows(data).map(profileFromRow).sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async createUser(input: NewUserInput): Promise<Profile> {
    await this.admin();
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new ApiError('invalid', 'Enter a valid username.');
    if (!input.fullName.trim()) throw new ApiError('invalid', 'Name is required.');
    if (!input.password || input.password.length < 8) throw new ApiError('invalid', 'Password must be at least 8 characters.');
    const res = await this.invoke<{ profile: Row }>('admin-users', {
      action: 'create',
      email,
      fullName: input.fullName.trim(),
      role: input.role,
      password: input.password,
    });
    return profileFromRow(res.profile);
  }

  async updateUser(id: string, patch: UserPatch): Promise<Profile> {
    const me = await this.admin();
    if (id === me.id && (patch.active === false || (patch.role && patch.role !== 'admin'))) {
      throw new ApiError('invalid', 'You cannot deactivate or demote yourself.');
    }
    const res = await this.invoke<{ profile: Row }>('admin-users', { action: 'update', id, patch });
    const p = profileFromRow(res.profile);
    if (p.id === me.id) this.setProfile(p);
    return p;
  }

  async resetPassword(id: string, newPassword: string): Promise<void> {
    await this.admin();
    if (!newPassword || newPassword.length < 8) throw new ApiError('invalid', 'Password must be at least 8 characters.');
    await this.invoke('admin-users', { action: 'reset_password', id, password: newPassword });
  }

  // -------------------------------------------------------------------------
  // Lists & leads
  // -------------------------------------------------------------------------

  async listLeadLists(): Promise<LeadList[]> {
    await this.admin();
    return this.rows(await this.rpc('list_lead_lists')).map(leadListFromRow);
  }

  async createLeadList(name: string): Promise<LeadList> {
    await this.admin();
    const n = name.trim();
    if (!n) throw new ApiError('invalid', 'List name is required.');
    const { data, error } = await this.sb.from('lead_lists').insert({ name: n }).select('*').single();
    if (error) throw this.fail(error);
    return leadListFromRow({ ...(data as Row), lead_count: 0, remaining_count: 0 });
  }

  async deleteLeadList(id: string): Promise<void> {
    await this.admin();
    const { data, error } = await this.sb.from('lead_lists').delete().eq('id', id).select('id');
    if (error) throw this.fail(error, { invalid: 'List not found.' });
    if (this.rows(data).length === 0) throw new ApiError('not_found', 'List not found.');
  }

  async importLeads(input: ImportLeadsInput): Promise<ImportResult> {
    await this.admin();
    if (!input.listId && !(input.newListName ?? '').trim()) throw new ApiError('invalid', 'List name is required.');
    const rows = input.rows.map(importRowToJson);
    const total: ImportResult = { listId: input.listId ?? '', imported: 0, duplicates: 0, invalid: 0 };
    let listId: string | null = input.listId ?? null;
    let offset = 0;
    do {
      const chunk = rows.slice(offset, offset + IMPORT_CHUNK);
      const res = await this.rpc<Row>('import_leads', {
        p_list_id: listId,
        p_new_list_name: listId ? null : (input.newListName ?? '').trim(),
        p_rows: chunk,
        p_assign: input.assign,
        p_rr_offset: total.imported,
      });
      listId = String(res.listId);
      total.listId = listId;
      total.imported += Number(res.imported) || 0;
      total.duplicates += Number(res.duplicates) || 0;
      total.invalid += Number(res.invalid) || 0;
      offset += IMPORT_CHUNK;
    } while (offset < rows.length);
    return total;
  }

  private leadQueryArgs(f: LeadFilter): Record<string, unknown> {
    const statuses = f.status === undefined ? null : Array.isArray(f.status) ? f.status : [f.status];
    return {
      p_list_id: f.listId || null,
      p_statuses: statuses,
      p_assigned_to: f.assignedTo ?? null,
      p_search: f.search?.trim() || null,
    };
  }

  async queryLeads(query: LeadQuery): Promise<Paged<Lead>> {
    await this.admin();
    const res = await this.rpc<{ rows: Row[]; total: number }>('query_leads', {
      ...this.leadQueryArgs(query),
      p_sort_field: leadSortColumn(query.sort?.field),
      p_sort_dir: query.sort?.dir ?? 'desc',
      p_page: Math.max(1, Math.floor(query.page || 1)),
      p_page_size: Math.max(1, Math.floor(query.pageSize || 1)),
    });
    return { rows: this.rows(res?.rows).map(leadFromRow), total: Number(res?.total) || 0 };
  }

  async getLead(id: string): Promise<Lead> {
    await this.me();
    return leadFromRow(this.rows(await this.rpc('get_lead', { p_id: id }, { invalid: 'Lead not found.' }))[0] ?? {});
  }

  async updateLead(id: string, patch: LeadPatch): Promise<Lead> {
    await this.me();
    let p = patch;
    if (patch.phones !== undefined) {
      const n = normalizePhoneList(patch.phones);
      if ('invalid' in n) throw new ApiError('invalid', `Invalid phone number: ${n.invalid}`);
      if (n.phones.length > 3) throw new ApiError('invalid', 'A lead can have at most 3 phone numbers.');
      p = { ...patch, phones: n.phones };
    }
    const row = await this.rpc('update_lead', { p_id: id, p_patch: leadPatchToRow(p) });
    return leadFromRow(this.rows(row)[0] ?? {});
  }

  async assignLeads(input: { leadIds: string[]; assignTo: string | null }): Promise<number> {
    await this.admin();
    if (input.leadIds.length === 0) return 0;
    return Number(await this.rpc('assign_leads', { p_ids: input.leadIds, p_assign_to: input.assignTo })) || 0;
  }

  async deleteLeads(ids: string[]): Promise<number> {
    await this.admin();
    if (ids.length === 0) return 0;
    return Number(await this.rpc('delete_leads', { p_ids: ids })) || 0;
  }

  async exportLeads(filter: LeadFilter): Promise<Lead[]> {
    await this.admin();
    const fetchPage = async (page: number) => {
      const res = await this.rpc<{ rows: Row[]; total: number }>('query_leads', {
        ...this.leadQueryArgs(filter),
        p_sort_field: 'created_at',
        p_sort_dir: 'asc',
        p_page: page,
        p_page_size: EXPORT_PAGE,
      });
      return { leads: this.rows(res?.rows).map(leadFromRow), total: Number(res?.total) || 0 };
    };
    const first = await fetchPage(1);
    const pages = Math.ceil(first.total / EXPORT_PAGE);
    if (first.leads.length < EXPORT_PAGE || pages <= 1) return first.leads;
    // The first page says how many there are; the rest load a few at a time, not one by one.
    const out = first.leads;
    for (let page = 2; page <= pages; page += EXPORT_PARALLEL) {
      const count = Math.min(EXPORT_PARALLEL, pages - page + 1);
      const batch = await Promise.all(Array.from({ length: count }, (_, i) => fetchPage(page + i)));
      for (const b of batch) out.push(...b.leads);
    }
    return out;
  }

  async getLeadHistory(leadId: string): Promise<CallRecord[]> {
    await this.me();
    return this.rows(await this.rpc('get_lead_history', { p_lead_id: leadId }, { invalid: 'Lead not found.' })).map(callFromRow);
  }

  // -------------------------------------------------------------------------
  // Caller queue
  // -------------------------------------------------------------------------

  async claimNextLeads(count: number): Promise<Lead[]> {
    await this.caller();
    const n = Math.max(0, Math.min(10, Math.floor(count)));
    if (n === 0) return [];
    return this.rows(await this.rpc('claim_dial_batch', { p_count: n })).map(leadFromRow);
  }

  async releaseLeads(ids: string[]): Promise<void> {
    await this.me();
    const valid = ids.filter((x) => typeof x === 'string' && x.length > 0);
    if (valid.length === 0) return;
    await this.rpc('release_leads', { p_ids: valid });
  }

  async reportMissedDay(leadId: string): Promise<Lead> {
    await this.me();
    return leadFromRow(this.rows(await this.rpc('report_missed_day', { p_lead_id: leadId }))[0] ?? {});
  }

  async reportBadNumber(leadId: string, phone: string): Promise<Lead> {
    await this.me();
    const target = normalizePhone(phone) ?? phone;
    return leadFromRow(this.rows(await this.rpc('report_bad_number', { p_lead_id: leadId, p_phone: target }))[0] ?? {});
  }

  async getMyCallbacks(): Promise<Lead[]> {
    await this.me();
    return this.rows(await this.rpc('get_my_callbacks')).map(leadFromRow);
  }

  async findLeadByPhone(phone: string): Promise<Lead | null> {
    await this.me();
    const n = normalizePhone(phone);
    if (!n) return null;
    const row = this.rows(await this.rpc('find_lead_by_phone', { p_phone: n }))[0];
    return row ? leadFromRow(row) : null;
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  async createCall(input: NewCallInput): Promise<CallRecord> {
    const me = await this.me();
    const callerId = input.callerId === undefined ? me.id : input.callerId;
    if (me.role !== 'admin' && callerId !== me.id) throw new ApiError('permission_denied', 'You can only log your own calls.');
    const { data, error } = await this.sb.from('calls').insert(newCallToRow(input, me.id)).select('*').single();
    if (error) throw this.fail(error, { not_found: 'Lead not found.', permission_denied: 'You can only log your own calls.' });
    return callFromRow(data as Row);
  }

  async updateCall(id: string, patch: CallPatch): Promise<CallRecord> {
    await this.me();
    const row = callPatchToRow(patch);
    let q;
    if (Object.keys(row).length === 0) q = this.sb.from('calls').select('*').eq('id', id);
    else q = this.sb.from('calls').update(row).eq('id', id).select('*');
    const { data, error } = await q;
    if (error) throw this.fail(error, { invalid: 'Call not found.' });
    const r = this.rows(data)[0];
    // RLS hides other callers' calls, so "not yours" and "missing" look the same here.
    if (!r) throw new ApiError('not_found', 'Call not found.');
    return callFromRow(r);
  }

  async saveDisposition(input: DispositionInput): Promise<Lead> {
    await this.me();
    if (!DISPOSITIONS.some((d) => d.value === input.disposition)) throw new ApiError('invalid', 'Unknown outcome.');
    let callbackAt: string | null = null;
    if (input.disposition === 'callback') {
      if (!input.callbackAt || Number.isNaN(Date.parse(input.callbackAt))) throw new ApiError('invalid', 'Pick a callback time.');
      callbackAt = new Date(input.callbackAt).toISOString();
    }
    const row = await this.rpc('save_disposition', {
      p_call_id: input.callId,
      p_lead_id: input.leadId,
      p_disposition: input.disposition,
      p_notes: input.notes ?? '',
      p_callback_at: callbackAt,
    });
    return leadFromRow(this.rows(row)[0] ?? {});
  }

  async listCalls(query: CallQuery): Promise<Paged<CallListRow>> {
    await this.me();
    const res = await this.rpc<{ rows: Row[]; total: number }>('list_calls', {
      p_caller_id: query.callerId || null,
      p_lead_id: query.leadId || null,
      p_from: query.from ? new Date(query.from).toISOString() : null,
      p_to: query.to ? new Date(query.to).toISOString() : null,
      p_only_recorded: !!query.onlyRecorded,
      p_results: query.results && query.results.length ? query.results : query.results ? ['__none__'] : null,
      p_page: Math.max(1, Math.floor(query.page || 1)),
      p_page_size: Math.max(1, Math.floor(query.pageSize || 1)),
    });
    return { rows: this.rows(res?.rows).map(callListRowFromRow), total: Number(res?.total) || 0 };
  }

  // -------------------------------------------------------------------------
  // Numbers
  // -------------------------------------------------------------------------

  async listNumbers(): Promise<PhoneNumber[]> {
    await this.admin();
    return this.rows(await this.rpc('list_numbers')).map(numberFromRow);
  }

  async pickFromNumber(toPhone: string): Promise<PhoneNumber | null> {
    await this.me();
    const row = this.rows(await this.rpc('pick_from_number', { p_to_phone: normalizePhone(toPhone) ?? toPhone }))[0];
    return row ? numberFromRow(row) : null;
  }

  private async numberById(id: string): Promise<PhoneNumber> {
    const n = (await this.listNumbers()).find((x) => x.id === id);
    if (!n) throw new ApiError('not_found', 'Number not found.');
    return n;
  }

  async addNumber(input: NewNumberInput): Promise<PhoneNumber> {
    await this.admin();
    const number = normalizePhone(input.number);
    if (!number) throw new ApiError('invalid', 'Enter a valid phone number.');
    if (input.dailyCap !== undefined && (!Number.isFinite(input.dailyCap) || input.dailyCap < 1)) {
      throw new ApiError('invalid', 'Daily cap must be at least 1.');
    }
    const row: Row = { number, label: (input.label ?? '').trim(), active: input.active ?? true };
    if (input.dailyCap !== undefined) row.daily_cap = Math.floor(input.dailyCap);
    const { data, error } = await this.sb.from('phone_numbers').insert(row).select('id').single();
    if (error) throw this.fail(error, { conflict: 'That number is already added.', invalid: 'Daily cap must be at least 1.' });
    return this.numberById(String((data as Row).id));
  }

  async updateNumber(id: string, patch: NumberPatch): Promise<PhoneNumber> {
    await this.admin();
    if (patch.dailyCap !== undefined && (!Number.isFinite(patch.dailyCap) || patch.dailyCap < 1)) {
      throw new ApiError('invalid', 'Daily cap must be at least 1.');
    }
    const row: Row = {};
    if (patch.label !== undefined) row.label = patch.label.trim();
    if (patch.active !== undefined) row.active = patch.active;
    if (patch.dailyCap !== undefined) row.daily_cap = Math.floor(patch.dailyCap);
    if (Object.keys(row).length > 0) {
      const { data, error } = await this.sb.from('phone_numbers').update(row).eq('id', id).select('id');
      if (error) throw this.fail(error, { invalid: 'Number not found.' });
      if (this.rows(data).length === 0) throw new ApiError('not_found', 'Number not found.');
    }
    return this.numberById(id);
  }

  async removeNumber(id: string): Promise<void> {
    await this.admin();
    const { data, error } = await this.sb.from('phone_numbers').delete().eq('id', id).select('id');
    if (error) throw this.fail(error, { invalid: 'Number not found.' });
    if (this.rows(data).length === 0) throw new ApiError('not_found', 'Number not found.');
  }

  async syncNumbersFromTelnyx(): Promise<PhoneNumber[]> {
    await this.admin();
    await this.invoke('telnyx-sync-numbers');
    return this.listNumbers();
  }

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  async setPresence(status: PresenceStatus, detail?: string | null): Promise<void> {
    const me = await this.me();
    if (me.role !== 'caller') return;
    this.lastPresence = { status, detail: detail ?? null };
    await this.rpc('set_presence', { p_status: status, p_detail: detail ?? null });
    if (status === 'offline') {
      this.stopHeartbeat();
    } else if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        const last = this.lastPresence;
        if (!last || !this.profile || last.status === 'offline') {
          this.stopHeartbeat();
          return;
        }
        this.sb.rpc('set_presence', { p_status: last.status, p_detail: last.detail }).then(
          (r) => {
            if (r.error && isDeactivationError(r.error)) void this.forceSignOut(DEACTIVATED_MESSAGE);
          },
          () => undefined,
        );
      }, HEARTBEAT_MS);
    }
  }

  async listPresence(): Promise<Presence[]> {
    await this.admin();
    return this.rows(await this.rpc('list_presence')).map(presenceFromRow);
  }

  subscribePresence(cb: (list: Presence[]) => void): () => void {
    let stopped = false;
    let channel: RealtimeChannel | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      if (stopped) return;
      this.listPresence().then(
        (list) => {
          if (!stopped) cb(list);
        },
        () => undefined,
      );
    };
    const schedule = () => {
      if (pending || stopped) return;
      pending = setTimeout(() => {
        pending = null;
        refresh();
      }, 250);
    };

    void this.init().then(() => {
      if (stopped) return;
      if (!this.profile || this.profile.role !== 'admin') {
        cb([]);
        return;
      }
      refresh();
      try {
        channel = this.sb
          .channel(`presence-live-${Math.random().toString(36).slice(2)}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, schedule)
          .subscribe();
      } catch {
        channel = null;
      }
      // Staleness (no heartbeat for 90 s -> offline) and new callers are picked up by polling.
      timer = setInterval(refresh, PRESENCE_REFRESH_MS);
    });

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (pending) clearTimeout(pending);
      if (channel) void this.sb.removeChannel(channel);
    };
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  async getMetrics(range: MetricsRange): Promise<Metrics> {
    await this.admin();
    const fromMs = Date.parse(range.from);
    const toMs = Date.parse(range.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) throw new ApiError('invalid', 'Invalid date range.');
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    const data = await this.rpc('get_metrics', { p_from: from, p_to: to });
    return metricsFromJson(data, { from, to });
  }

  async getMyStatsToday(): Promise<MetricsTotals> {
    await this.me();
    return totalsFromJson(await this.rpc('get_my_stats_today'));
  }

  // -------------------------------------------------------------------------
  // Telephony
  // -------------------------------------------------------------------------

  async getTelephonyToken(): Promise<string> {
    await this.me();
    const data = await this.invoke<{ token?: unknown }>('telnyx-token');
    if (!data || typeof data.token !== 'string' || !data.token) {
      throw new ApiError('invalid', 'The telephony service did not return a token.');
    }
    return data.token;
  }
}
