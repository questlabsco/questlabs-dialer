import type {
  CallDirection,
  CallRecord,
  CallResult,
  Disposition,
  Lead,
  LeadList,
  LeadStatus,
  Metrics,
  MetricsRange,
  MetricsTotals,
  NewLead,
  Paged,
  PhoneNumber,
  Presence,
  PresenceStatus,
  Profile,
  Role,
  Settings,
} from '../types';

/**
 * The data layer contract. Implemented by `demoApi.ts` (in-memory, localStorage) and later by
 * `supabaseApi.ts`. Screens and the dialer engine import the `api` singleton from `src/api`
 * and must only depend on this interface.
 *
 * Rules shared by all implementations:
 * - Every method except the two `subscribe`-style ones returns a Promise.
 * - Methods marked (admin) reject with `ApiError('permission_denied')` for callers.
 * - Methods reject with `ApiError('not_authenticated')` when nobody is signed in
 *   (except signIn / signInDemo / getSession / onAuthChange).
 * - Returned objects are copies; mutating them does not change stored data.
 */
export interface Api {
  /** 'demo' or 'supabase'. */
  readonly kind: 'demo' | 'supabase';

  // ---- Auth ---------------------------------------------------------------
  /** Email + password sign-in. Demo: any non-empty password works for an existing active user. */
  signIn(email: string, password: string): Promise<Profile>;
  /** Demo only: sign in as the seeded admin or the first seeded caller. Real backend rejects. */
  signInDemo(role: Role): Promise<Profile>;
  signOut(): Promise<void>;
  /** Current signed-in profile, or null. */
  getSession(): Promise<Profile | null>;
  /** Called with the new profile (or null) whenever the session changes. Returns unsubscribe. */
  onAuthChange(cb: (profile: Profile | null) => void): () => void;
  /**
   * True when the signed-in person is still on a password an admin set for them (new account or
   * reset) and must choose their own. False when nobody is signed in. Synchronous: read it after
   * signIn / getSession / an onAuthChange callback.
   */
  mustChangePassword(): boolean;
  /**
   * Any signed-in user: changes my own password and clears the must-change flag.
   * Rejects 'invalid' with the messages in `src/lib/password.ts` ("Current password is wrong",
   * "At least 8 characters", "Must be different from your current password").
   */
  changeMyPassword(input: ChangePasswordInput): Promise<void>;

  // ---- Settings -----------------------------------------------------------
  /** Any signed-in user (callers need ringSeconds, script, calendlyUrl...). */
  getSettings(): Promise<Settings>;
  /** (admin) Shallow-merges and returns the full new settings. */
  saveSettings(patch: Partial<Settings>): Promise<Settings>;

  // ---- My script ------------------------------------------------------------
  /**
   * Any signed-in active user. `script` is my personal copy when I have one, else the team script
   * (`Settings.script`); `isPersonal` says which. `teamScript` is always the team script.
   */
  getMyScript(): Promise<MyScript>;
  /** Saves my personal copy. `null` or blank removes it (back to the team script). Rejects 'invalid' if too long. */
  saveMyScript(script: string | null): Promise<void>;

  // ---- Team (admin) ---------------------------------------------------------
  /** (admin) All users including inactive, sorted by fullName. */
  listUsers(): Promise<Profile[]>;
  /** (admin) Rejects with 'conflict' if the email exists, 'invalid' if password < 8 chars. */
  createUser(input: NewUserInput): Promise<Profile>;
  /** (admin) Deactivating a caller releases their locks; their assigned leads stay assigned. */
  updateUser(id: string, patch: UserPatch): Promise<Profile>;
  /** (admin) Rejects with 'invalid' if newPassword < 8 chars. */
  resetPassword(id: string, newPassword: string): Promise<void>;

  // ---- Lists & leads (admin unless stated) ---------------------------------
  /** (admin) Sorted newest first. */
  listLeadLists(): Promise<LeadList[]>;
  /** (admin) */
  createLeadList(name: string): Promise<LeadList>;
  /** (admin) Deletes the list and all its leads (call history is kept). */
  deleteLeadList(id: string): Promise<void>;
  /**
   * (admin) Normalises phones to E.164 (US default), drops rows with no valid phone or no
   * businessName (counted as `invalid`), and skips rows whose primary phone matches the primary
   * phone of any existing lead or an earlier row in the same import (counted as `duplicates`).
   */
  importLeads(input: ImportLeadsInput): Promise<ImportResult>;
  /** (admin) Filtered, sorted, paginated leads. */
  queryLeads(query: LeadQuery): Promise<Paged<Lead>>;
  /**
   * Admin: any lead. Caller: only a lead they have locked, own as callback, are assigned to, or
   * last dialed; otherwise 'permission_denied'. Rejects 'not_found' if missing.
   */
  getLead(id: string): Promise<Lead>;
  /**
   * Admin: any field in LeadPatch. Caller: only contactName / email / businessName / notes, and
   * only on a lead they currently hold (lockedBy = me) or own as callback.
   */
  updateLead(id: string, patch: LeadPatch): Promise<Lead>;
  /** (admin) assignTo = caller id, or null for the shared pool. Returns the number updated. */
  assignLeads(input: { leadIds: string[]; assignTo: string | null }): Promise<number>;
  /** (admin) Returns the number deleted. */
  deleteLeads(ids: string[]): Promise<number>;
  /** (admin) All matching leads (no pagination) for CSV export. */
  exportLeads(filter: LeadFilter): Promise<Lead[]>;
  /** Same access rule as getLead. Newest first. */
  getLeadHistory(leadId: string): Promise<CallRecord[]>;

  // ---- Caller queue -------------------------------------------------------
  /**
   * Atomically locks up to `count` leads for the current caller and returns them in dialing order.
   * Priority: (1) own callbacks with callbackAt <= now (oldest first); (2) leads assigned to me;
   * (3) shared pool (assignedTo null). Groups 2–3 only include status new / no_answer with
   * nextCallAt null or <= now, ordered by (nextCallAt ?? createdAt) ascending.
   * Never returns do_not_call or other terminal statuses, leads with no phones, or leads locked by
   * someone else unless that lock is older than 10 minutes. Leads already locked by me are eligible.
   * Callers only; admins get 'permission_denied'.
   */
  claimNextLeads(count: number): Promise<Lead[]>;
  /** Unlocks leads held by me (others' locks are ignored). Lead state is otherwise unchanged. */
  releaseLeads(ids: string[]): Promise<void>;
  /**
   * All rings on all phones were missed today: attemptDays + 1, lastCalledAt/By = now/me,
   * status 'no_answer', nextCallAt = start of next local day, unlocked; status becomes 'exhausted'
   * (nextCallAt null) once attemptDays >= settings.retryDays.
   */
  reportMissedDay(leadId: string): Promise<Lead>;
  /**
   * Removes `phone` from the lead. If no phones remain the status becomes 'bad_number' and the lead
   * is unlocked; otherwise status and lock are unchanged so the dialer can try the next phone.
   */
  reportBadNumber(leadId: string, phone: string): Promise<Lead>;
  /** Current caller's leads with status 'callback' and callbackOwner = me, by callbackAt ascending (due and future). */
  getMyCallbacks(): Promise<Lead[]>;
  /** For inbound calls: lead whose phones include `phone` (any format), or null. Any signed-in user. */
  findLeadByPhone(phone: string): Promise<Lead | null>;

  // ---- Calls --------------------------------------------------------------
  /**
   * Creates a CallRecord. callerId defaults to me; listId is filled from the lead; startedAt
   * defaults to now; result null (in progress) unless given.
   */
  createCall(input: NewCallInput): Promise<CallRecord>;
  /** Callers may only update their own calls. */
  updateCall(id: string, patch: CallPatch): Promise<CallRecord>;
  /**
   * Wrap-up. `callId` is the CallRecord id (NOT the telephony call id). Sets disposition + notes on
   * the call, sets lead.lastCalledAt/By, unlocks the lead and applies the DISPOSITIONS status rule:
   * booked / not_interested / wrong_number / do_not_call -> that status, nextCallAt null;
   * callback -> status 'callback', callbackAt (required, else 'invalid'), callbackOwner = me,
   * nextCallAt = callbackAt; voicemail / hung_up -> same as reportMissedDay.
   * Returns the updated lead.
   */
  saveDisposition(input: DispositionInput): Promise<Lead>;
  /** Callers always get only their own calls (callerId filter is forced). Newest first. */
  listCalls(query: CallQuery): Promise<Paged<CallListRow>>;

  // ---- Outbound numbers ---------------------------------------------------
  /** (admin) With derived fields (effectiveCapToday, callsToday, pickupRate7d, calls7d, flagged). */
  listNumbers(): Promise<PhoneNumber[]>;
  /**
   * Any signed-in user. Choose the outbound number for a dial to `toPhone`: among active numbers
   * with callsToday < effectiveCapToday, prefer those with the same area code; within the chosen
   * group pick the one with the fewest callsToday (ties: oldest addedAt). Null if none available.
   */
  pickFromNumber(toPhone: string): Promise<PhoneNumber | null>;
  /** (admin) dailyCap defaults to settings.defaultDailyCap. Rejects 'invalid' / 'conflict'. */
  addNumber(input: NewNumberInput): Promise<PhoneNumber>;
  /** (admin) */
  updateNumber(id: string, patch: NumberPatch): Promise<PhoneNumber>;
  /** (admin) Call history keeps the E.164 string. */
  removeNumber(id: string): Promise<void>;
  /** (admin) Pull numbers from the telephony provider. Demo: no-op, returns listNumbers(). */
  syncNumbersFromTelnyx(): Promise<PhoneNumber[]>;

  // ---- Presence -----------------------------------------------------------
  /** Sets the current user's presence (callers; admins are ignored silently). */
  setPresence(status: PresenceStatus, detail?: string | null): Promise<void>;
  /** (admin) One entry per active caller. */
  listPresence(): Promise<Presence[]>;
  /** (admin, not enforced synchronously) cb receives the full list on every change and once right away. Returns unsubscribe. */
  subscribePresence(cb: (list: Presence[]) => void): () => void;

  // ---- Metrics ------------------------------------------------------------
  /** (admin) See MetricsTotals for definitions. */
  getMetrics(range: MetricsRange): Promise<Metrics>;
  /** Current user's totals since local midnight. */
  getMyStatsToday(): Promise<MetricsTotals>;

  // ---- Telephony support --------------------------------------------------
  /** Short-lived credential for the WebRTC client. Demo: 'demo'. */
  getTelephonyToken(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface MyScript {
  script: string;
  isPersonal: boolean;
  teamScript: string;
}

/** Longest personal script accepted (characters). */
export const MAX_SCRIPT_LENGTH = 20_000;

export interface NewUserInput {
  email: string;
  fullName: string;
  role: Role;
  /** Initial password, >= 8 characters. Never stored by the demo. */
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export type UserPatch = Partial<Pick<Profile, 'fullName' | 'role' | 'active' | 'email'>>;

/** Where imported leads go. */
export type AssignTarget =
  | { mode: 'pool' }
  | { mode: 'caller'; callerId: string }
  /** Distributed evenly in row order across callerIds. */
  | { mode: 'round_robin'; callerIds: string[] };

/** Exactly one of listId (existing list) or newListName (create a list). */
export type ImportLeadsInput = {
  rows: NewLead[];
  assign: AssignTarget;
} & ({ listId: string; newListName?: undefined } | { newListName: string; listId?: undefined });

export interface ImportResult {
  /** The list the leads went into (new or existing). */
  listId: string;
  imported: number;
  duplicates: number;
  invalid: number;
}

export type LeadSortField = 'createdAt' | 'businessName' | 'contactName' | 'status' | 'lastCalledAt' | 'nextCallAt' | 'attemptDays';

export interface LeadFilter {
  listId?: string;
  /** One status or any of several. */
  status?: LeadStatus | LeadStatus[];
  /** A caller id, 'pool' for unassigned, or undefined for everyone. */
  assignedTo?: string | 'pool';
  /** Case-insensitive match on businessName, contactName, email, city, or phone digits. */
  search?: string;
}

export interface LeadQuery extends LeadFilter {
  /** 1-based page number. */
  page: number;
  pageSize: number;
  /** Default: createdAt desc. */
  sort?: { field: LeadSortField; dir: 'asc' | 'desc' };
}

export type LeadPatch = Partial<
  Pick<
    Lead,
    | 'listId'
    | 'businessName'
    | 'contactName'
    | 'phones'
    | 'email'
    | 'city'
    | 'state'
    | 'notes'
    | 'status'
    | 'assignedTo'
    | 'attemptDays'
    | 'nextCallAt'
    | 'callbackAt'
    | 'callbackOwner'
  >
>;

export interface NewCallInput {
  leadId: string | null;
  direction: CallDirection;
  fromNumber: string;
  toNumber: string;
  ring: 1 | 2;
  /** Defaults to the signed-in user. Pass null for an inbound call that reached nobody. */
  callerId?: string | null;
  startedAt?: string;
  answeredAt?: string | null;
  endedAt?: string | null;
  talkSeconds?: number;
  result?: CallResult | null;
  notes?: string;
  recordingUrl?: string | null;
  /** Telephony call id (from Telephony.dial() or the `incoming` event). */
  providerCallId?: string | null;
}

export type CallPatch = Partial<
  Pick<CallRecord, 'answeredAt' | 'endedAt' | 'talkSeconds' | 'result' | 'notes' | 'recordingUrl' | 'disposition'>
>;

export interface DispositionInput {
  /** CallRecord id of the answered call. */
  callId: string;
  leadId: string;
  disposition: Disposition;
  notes: string;
  /** ISO; required when disposition is 'callback'. */
  callbackAt?: string | null;
}

export interface CallQuery {
  /** Forced to the current user for callers. */
  callerId?: string;
  leadId?: string;
  /** ISO, inclusive (startedAt). */
  from?: string;
  /** ISO, exclusive (startedAt). */
  to?: string;
  /** Only calls with a recordingUrl. */
  onlyRecorded?: boolean;
  /** Only these results. */
  results?: CallResult[];
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** CallRecord enriched with display names for tables (e.g. Recordings). */
export interface CallListRow extends CallRecord {
  businessName: string | null;
  contactName: string | null;
  callerName: string | null;
}

export interface NewNumberInput {
  /** Any format; normalised to E.164. */
  number: string;
  label?: string;
  dailyCap?: number;
  active?: boolean;
}

export type NumberPatch = Partial<Pick<PhoneNumber, 'label' | 'active' | 'dailyCap'>>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'not_authenticated'
  | 'permission_denied'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'not_implemented';

/** All Api implementations reject with this. Show `message` to the user. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Best-effort user-facing message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
