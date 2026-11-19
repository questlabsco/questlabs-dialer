/**
 * Shared data shapes for Quest Labs Dialer. Single source of truth: the demo
 * data layer, the future Supabase backend, the dialer engine and every screen
 * use these types.
 *
 * Conventions:
 * - All ids are opaque strings.
 * - All timestamps are ISO 8601 strings (`new Date().toISOString()`), or null.
 * - All phone numbers are stored in E.164 (`+12145550123`). Use `src/lib/format.ts`
 *   to normalise input and to display.
 * - Rates are fractions in 0..1 (format with `formatPercent`).
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type Role = 'admin' | 'caller';

export interface Profile {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  /** Inactive users cannot sign in and are never given leads. */
  active: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a lead.
 * Dialable statuses: `new`, `no_answer`, `callback` (only by its callbackOwner).
 * Terminal statuses: everything else.
 */
export type LeadStatus =
  | 'new'
  /** Missed on at least one day; retried from `nextCallAt`. */
  | 'no_answer'
  /** Caller scheduled a callback at `callbackAt`; only `callbackOwner` gets it. */
  | 'callback'
  | 'booked'
  | 'not_interested'
  | 'wrong_number'
  /** Every phone on the lead failed as invalid / disconnected. */
  | 'bad_number'
  | 'do_not_call'
  /** Missed on `Settings.retryDays` different days; no longer dialed. */
  | 'exhausted';

export const LEAD_STATUSES: readonly { value: LeadStatus; label: string; dialable: boolean }[] = [
  { value: 'new', label: 'New', dialable: true },
  { value: 'no_answer', label: 'No answer', dialable: true },
  { value: 'callback', label: 'Callback', dialable: true },
  { value: 'booked', label: 'Booked', dialable: false },
  { value: 'not_interested', label: 'Not interested', dialable: false },
  { value: 'wrong_number', label: 'Wrong number', dialable: false },
  { value: 'bad_number', label: 'Bad number', dialable: false },
  { value: 'do_not_call', label: 'Do not call', dialable: false },
  { value: 'exhausted', label: 'Exhausted', dialable: false },
];

/** Human label for a lead status. */
export function leadStatusLabel(status: LeadStatus): string {
  return LEAD_STATUSES.find((s) => s.value === status)?.label ?? status;
}

export interface Lead {
  attemptPlan?: Record<string, { ring: number; from: string | null }>;
  id: string;
  /** The LeadList this lead was imported into. */
  listId: string;
  businessName: string;
  /** Business owner's name ('' if unknown). */
  contactName: string;
  /** 1–3 numbers in E.164, tried in this order. Primary = phones[0]. */
  phones: string[];
  /** '' if unknown. Used to prefill the Calendly link on "booked". */
  email: string;
  city: string;
  /** Two-letter US state code, '' if unknown. */
  state: string;
  /** Free-text notes from the import or the admin. Call notes live on CallRecord. */
  notes: string;
  status: LeadStatus;
  /** Profile id of the caller this lead is reserved for; null = shared pool. */
  assignedTo: string | null;
  /** Number of distinct days on which every ring on every phone was missed (incl. voicemail / hung up). */
  attemptDays: number;
  lastCalledAt: string | null;
  /** Profile id of the caller who last dialed it. Inbound calls from this lead ring this caller. */
  lastCalledBy: string | null;
  /** Earliest time the lead may be dialed again; null = due now. */
  nextCallAt: string | null;
  /** When status is 'callback': when the caller should call back. */
  callbackAt: string | null;
  /** When status is 'callback': the caller who owns the callback. */
  callbackOwner: string | null;
  /** Profile id of the caller currently holding this lead in their dialer; null = unlocked. */
  lockedBy: string | null;
  /** When the lock was taken. Locks older than 10 minutes are considered stale. */
  lockedAt: string | null;
  createdAt: string;
}

/** A row to import. Phones may be in any format; the importer normalises to E.164 and drops invalid ones. */
export interface NewLead {
  businessName: string;
  contactName?: string;
  /** 1–3 phone numbers, in dialing order. */
  phones: string[];
  email?: string;
  city?: string;
  state?: string;
  notes?: string;
}

export interface LeadList {
  id: string;
  name: string;
  createdAt: string;
  /** Total leads currently in the list. */
  leadCount: number;
  /** Leads still dialable (status new / no_answer / callback). */
  remainingCount: number;
}

// ---------------------------------------------------------------------------
// Dispositions (what the caller picks after a conversation)
// ---------------------------------------------------------------------------

export type Disposition =
  | 'booked'
  | 'callback'
  | 'not_interested'
  | 'wrong_number'
  | 'do_not_call'
  | 'voicemail'
  | 'hung_up';

export interface DispositionInfo {
  value: Disposition;
  label: string;
  /** Keyboard shortcut in the wrap-up panel ('1'..'7'). */
  hotkey: string;
  /**
   * Resulting lead status. 'missed_day' means: treat like a day on which nobody picked up
   * (attemptDays + 1, status no_answer, nextCallAt = start of next day, or 'exhausted'
   * once attemptDays >= Settings.retryDays).
   */
  leadStatus: LeadStatus | 'missed_day';
  /** If true the caller must provide `callbackAt`. */
  requiresCallbackAt: boolean;
  /** Tone for badges/buttons. */
  tone: 'good' | 'accent' | 'neutral' | 'warning' | 'critical';
}

/** Ordered list shown in the wrap-up panel; hotkeys 1–7. */
export const DISPOSITIONS: readonly DispositionInfo[] = [
  { value: 'booked', label: 'Booked', hotkey: '1', leadStatus: 'booked', requiresCallbackAt: false, tone: 'good' },
  { value: 'callback', label: 'Callback', hotkey: '2', leadStatus: 'callback', requiresCallbackAt: true, tone: 'accent' },
  { value: 'not_interested', label: 'Not interested', hotkey: '3', leadStatus: 'not_interested', requiresCallbackAt: false, tone: 'neutral' },
  { value: 'wrong_number', label: 'Wrong number', hotkey: '4', leadStatus: 'wrong_number', requiresCallbackAt: false, tone: 'warning' },
  { value: 'do_not_call', label: 'Do not call', hotkey: '5', leadStatus: 'do_not_call', requiresCallbackAt: false, tone: 'critical' },
  { value: 'voicemail', label: 'Voicemail', hotkey: '6', leadStatus: 'missed_day', requiresCallbackAt: false, tone: 'neutral' },
  { value: 'hung_up', label: 'Hung up', hotkey: '7', leadStatus: 'missed_day', requiresCallbackAt: false, tone: 'neutral' },
];

export function dispositionInfo(d: Disposition): DispositionInfo {
  const info = DISPOSITIONS.find((x) => x.value === d);
  if (!info) throw new Error(`Unknown disposition: ${d}`);
  return info;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type CallDirection = 'outbound' | 'inbound';

export type CallResult =
  /** A human picked up and was connected to the caller. */
  | 'answered'
  /** Rang for ringSeconds with no pickup. */
  | 'no_answer'
  /** Answering machine detected (auto-skipped when Settings.skipVoicemail). */
  | 'voicemail'
  | 'busy'
  /** Carrier / network failure. */
  | 'failed'
  /** Number invalid or disconnected. */
  | 'bad_number'
  /** Hung up by us because another line answered while this was still ringing. */
  | 'dropped'
  /** This person picked up but another line had already answered (we hung up on them). */
  | 'dropped_pickup'
  /** Inbound call nobody answered. */
  | 'missed_inbound';

export const CALL_RESULT_LABELS: Record<CallResult, string> = {
  answered: 'Answered',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  busy: 'Busy',
  failed: 'Failed',
  bad_number: 'Bad number',
  dropped: 'Dropped (other line answered)',
  dropped_pickup: 'Dropped pickup',
  missed_inbound: 'Missed inbound',
};

/** One leg / one ring. A double ring produces two CallRecords (ring 1 and ring 2). */
export interface CallRecord {
  id: string;
  /** Null for inbound calls from unknown numbers. */
  leadId: string | null;
  /** Denormalised lead.listId at call time (for per-list metrics); null if no lead. */
  listId: string | null;
  /** Caller who placed / took the call; null for an inbound call that reached nobody. */
  callerId: string | null;
  direction: CallDirection;
  /** E.164. Outbound: our number. Inbound: the lead's number. */
  fromNumber: string;
  /** E.164. Outbound: the lead's number. Inbound: our number. */
  toNumber: string;
  /** 1 = first ring, 2 = immediate re-ring of the same phone ("double ring"). Inbound: 1. */
  ring: 1 | 2;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  /** Seconds between answeredAt and endedAt (0 if never answered). */
  talkSeconds: number;
  /** Null while the call is still in progress. */
  result: CallResult | null;
  /** Set by saveDisposition on the call that was answered. */
  disposition: Disposition | null;
  notes: string;
  /** Playable URL (or data: URL in demo) when the call was recorded. */
  recordingUrl: string | null;
  /**
   * Telephony call id returned by Telephony.dial() / carried by the `incoming` event. Lets the
   * backend attach a recording to this record. Absent in demo seed data.
   */
  providerCallId?: string | null;
}

// ---------------------------------------------------------------------------
// Outbound phone numbers
// ---------------------------------------------------------------------------

export interface PhoneNumber {
  id: string;
  /** E.164. */
  number: string;
  label: string;
  /** Inactive numbers are never picked. */
  active: boolean;
  /** Max outbound dials per day once fully ramped. */
  dailyCap: number;
  /** When the number was added; drives the ramp-up. */
  addedAt: string;
  /**
   * Today's cap after ramp-up (derived): rises linearly from Settings.rampStartCap on the day the
   * number is added to dailyCap after Settings.rampDays days; never above dailyCap.
   */
  effectiveCapToday: number;
  /** Outbound dials placed from this number since local midnight (derived). */
  callsToday: number;
  /** Pickups / dials over the last 7 days, 0..1 (derived). */
  pickupRate7d: number;
  /** Outbound dials over the last 7 days (derived). */
  calls7d: number;
  /**
   * Derived: true when the number has >= 30 dials in 7 days and its 7-day pickup rate is below
   * half of the fleet's 7-day pickup rate (likely flagged as spam by carriers).
   */
  flagged: boolean;
  /** Provider id (Telnyx) once synced; null for numbers added manually / in demo. */
  providerId: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /** Simultaneous lines rung per caller. */
  linesPerCaller: number;
  /** How long one ring attempt lasts before it counts as no answer. */
  ringSeconds: number;
  /** If no pickup, immediately ring the same phone a second time from the same number. */
  doubleRing: boolean;
  /** Number of missed days before a lead becomes 'exhausted'. */
  retryDays: number;
  /** Hang up automatically when an answering machine is detected. */
  skipVoicemail: boolean;
  /** Admin's Calendly link; opened with name + email prefilled on "booked". */
  calendlyUrl: string;
  /** Call script shown to callers (plain text, may contain {contactName}, {businessName}, {callerName}). */
  script: string;
  /** Default dailyCap for newly added numbers. */
  defaultDailyCap: number;
  /** Days a new number takes to ramp up to its dailyCap. */
  rampDays: number;
  /** Cap on the day a number is added. */
  rampStartCap: number;
  /** Record answered calls. */
  recordCalls: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  linesPerCaller: 2,
  ringSeconds: 22,
  doubleRing: true,
  retryDays: 3,
  skipVoicemail: true,
  calendlyUrl: 'https://calendly.com/questlabsco/questlabs',
  script: '',
  defaultDailyCap: 100,
  rampDays: 14,
  rampStartCap: 25,
  recordCalls: true,
};

// ---------------------------------------------------------------------------
// Presence (live view)
// ---------------------------------------------------------------------------

export type PresenceStatus = 'offline' | 'idle' | 'dialing' | 'on_call' | 'wrap_up' | 'paused';

export const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  offline: 'Offline',
  idle: 'Idle',
  dialing: 'Dialing',
  on_call: 'On call',
  wrap_up: 'Wrap-up',
  paused: 'Paused',
};

export interface Presence {
  callerId: string;
  fullName: string;
  status: PresenceStatus;
  /** When the caller entered this status. */
  since: string;
  /** Optional context, e.g. the business name on the active call. */
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** `from` inclusive, `to` exclusive, both ISO. */
export interface MetricsRange {
  from: string;
  to: string;
}

/**
 * Definitions (all derived from CallRecords whose startedAt is in range):
 * - dials: outbound CallRecords (each ring counts, incl. dropped lines).
 * - pickups: outbound records with result 'answered' or 'dropped_pickup' (a human picked up).
 * - pickupRate: pickups / dials (0 when no dials).
 * - conversations: records (either direction) with result 'answered' and talkSeconds >= 20.
 * - bookings: records with disposition 'booked'.
 * - talkSeconds: sum of talkSeconds (either direction).
 * - droppedPickups: records with result 'dropped_pickup'.
 */
export interface MetricsTotals {
  dials: number;
  pickups: number;
  pickupRate: number;
  conversations: number;
  bookings: number;
  talkSeconds: number;
  droppedPickups: number;
}

export interface CallerMetricsRow extends MetricsTotals {
  callerId: string;
  label: string;
}

export interface DayMetricsRow extends MetricsTotals {
  /** Local date 'YYYY-MM-DD'. Every day in the range is present (zeros if no calls). */
  date: string;
  label: string;
}

export interface NumberMetricsRow extends MetricsTotals {
  /** E.164 of the outbound number. */
  number: string;
  /** PhoneNumber id, or null if the number has since been removed. */
  numberId: string | null;
  label: string;
}

export interface ListMetricsRow extends MetricsTotals {
  listId: string;
  label: string;
}

export interface OutcomeCount {
  disposition: Disposition;
  label: string;
  count: number;
}

export interface Metrics {
  range: MetricsRange;
  totals: MetricsTotals;
  /** Same-length period immediately before `range`. */
  previousTotals: MetricsTotals;
  /** One row per caller (role caller, plus anyone with calls in range). */
  byCaller: CallerMetricsRow[];
  /** One row per local day in range, ascending. */
  byDay: DayMetricsRow[];
  /** One row per outbound number (current numbers plus any used in range). */
  byNumber: NumberMetricsRow[];
  /** One row per lead list. */
  byList: ListMetricsRow[];
  /** One entry per Disposition, in DISPOSITIONS order. */
  outcomes: OutcomeCount[];
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** A page of results. `total` is the count across all pages. */
export interface Paged<T> {
  rows: T[];
  total: number;
}
