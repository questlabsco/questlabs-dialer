/**
 * Row <-> TypeScript mapping for the Supabase backend. One place, pure, unit-tested.
 * Database rows are snake_case (see supabase/migrations/0001_core.sql); the app uses `src/types.ts`.
 */
import type { CallListRow, CallPatch, LeadPatch, MyScript, NewCallInput } from './Api';
import {
  type NewLead,
  DEFAULT_SETTINGS,
  DISPOSITIONS,
  type CallDirection,
  type CallRecord,
  type CallResult,
  type Disposition,
  type Lead,
  type LeadList,
  type LeadStatus,
  type Metrics,
  type MetricsTotals,
  type PhoneNumber,
  type Presence,
  type PresenceStatus,
  type Profile,
  type Role,
  type Settings,
} from '../types';
import { normalizePhone } from '../lib/format';

export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 't' || v === 'true') return true;
  if (v === 'f' || v === 'false') return false;
  return fallback;
}

function idOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * Postgres timestamp text ("2026-11-15 14:00:00.123456+00", "2026-11-15T14:00:00+00:00", ...)
 * -> ISO 8601 with milliseconds, or null.
 */
export function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  let s = String(v).trim();
  s = s.replace(' ', 'T');
  s = s.replace(/(\.\d{3})\d+/, '$1');
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function iso(v: unknown): string {
  return isoOrNull(v) ?? new Date(0).toISOString();
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    return inner ? inner.split(',').map((x) => x.replace(/^"|"$/g, '')) : [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Rows -> types
// ---------------------------------------------------------------------------

export function profileFromRow(r: Row): Profile {
  return {
    id: str(r.id),
    email: str(r.email),
    fullName: str(r.full_name),
    role: (r.role === 'admin' ? 'admin' : 'caller') as Role,
    active: bool(r.active, true),
    createdAt: iso(r.created_at),
  };
}

export function leadFromRow(r: Row): Lead {
  return {
    id: str(r.id),
    listId: str(r.list_id),
    businessName: str(r.business_name),
    contactName: str(r.contact_name),
    phones: strArray(r.phones),
    ...(r.attempt_plan ? { attemptPlan: r.attempt_plan as Lead['attemptPlan'] } : {}),
    email: str(r.email),
    city: str(r.city),
    state: str(r.state),
    notes: str(r.notes),
    status: str(r.status, 'new') as LeadStatus,
    assignedTo: idOrNull(r.assigned_to),
    attemptDays: num(r.attempt_days),
    lastCalledAt: isoOrNull(r.last_called_at),
    lastCalledBy: idOrNull(r.last_called_by),
    nextCallAt: isoOrNull(r.next_call_at),
    callbackAt: isoOrNull(r.callback_at),
    callbackOwner: idOrNull(r.callback_owner),
    lockedBy: idOrNull(r.locked_by),
    lockedAt: isoOrNull(r.locked_at),
    createdAt: iso(r.created_at),
  };
}

export function leadListFromRow(r: Row): LeadList {
  return {
    id: str(r.id),
    name: str(r.name),
    createdAt: iso(r.created_at),
    leadCount: num(r.lead_count),
    remainingCount: num(r.remaining_count),
  };
}

export function callFromRow(r: Row): CallRecord {
  return {
    id: str(r.id),
    leadId: idOrNull(r.lead_id),
    listId: idOrNull(r.list_id),
    callerId: idOrNull(r.caller_id),
    direction: (r.direction === 'inbound' ? 'inbound' : 'outbound') as CallDirection,
    fromNumber: str(r.from_number),
    toNumber: str(r.to_number),
    ring: num(r.ring, 1) === 2 ? 2 : 1,
    startedAt: iso(r.started_at),
    answeredAt: isoOrNull(r.answered_at),
    endedAt: isoOrNull(r.ended_at),
    talkSeconds: num(r.talk_seconds),
    result: (idOrNull(r.result) as CallResult | null),
    disposition: (idOrNull(r.disposition) as Disposition | null),
    notes: str(r.notes),
    recordingUrl: idOrNull(r.recording_url),
    providerCallId: idOrNull(r.provider_call_id),
  };
}

export function callListRowFromRow(r: Row): CallListRow {
  return {
    ...callFromRow(r),
    businessName: idOrNull(r.business_name),
    contactName: idOrNull(r.contact_name),
    callerName: idOrNull(r.caller_name),
  };
}

export function numberFromRow(r: Row): PhoneNumber {
  return {
    id: str(r.id),
    number: str(r.number),
    label: str(r.label),
    active: bool(r.active, true),
    dailyCap: num(r.daily_cap),
    addedAt: iso(r.added_at),
    effectiveCapToday: num(r.effective_cap_today, num(r.daily_cap)),
    callsToday: num(r.calls_today),
    pickupRate7d: num(r.pickup_rate_7d),
    calls7d: num(r.calls_7d),
    flagged: bool(r.flagged),
    providerId: idOrNull(r.provider_id),
  };
}

const PRESENCE: readonly PresenceStatus[] = ['offline', 'idle', 'dialing', 'on_call', 'wrap_up', 'paused'];

export function presenceFromRow(r: Row): Presence {
  const status = PRESENCE.includes(r.status as PresenceStatus) ? (r.status as PresenceStatus) : 'offline';
  return {
    callerId: str(r.caller_id),
    fullName: str(r.full_name),
    status,
    since: iso(r.since),
    detail: idOrNull(r.detail),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_COLUMNS: Record<keyof Settings, string> = {
  linesPerCaller: 'lines_per_caller',
  ringSeconds: 'ring_seconds',
  doubleRing: 'double_ring',
  retryDays: 'retry_days',
  skipVoicemail: 'skip_voicemail',
  calendlyUrl: 'calendly_url',
  script: 'script',
  defaultDailyCap: 'default_daily_cap',
  rampDays: 'ramp_days',
  rampStartCap: 'ramp_start_cap',
  recordCalls: 'record_calls',
};

export function settingsFromRow(r: Row): Settings {
  const d = DEFAULT_SETTINGS;
  return {
    linesPerCaller: num(r.lines_per_caller, d.linesPerCaller),
    ringSeconds: num(r.ring_seconds, d.ringSeconds),
    doubleRing: bool(r.double_ring, d.doubleRing),
    retryDays: num(r.retry_days, d.retryDays),
    skipVoicemail: bool(r.skip_voicemail, d.skipVoicemail),
    calendlyUrl: str(r.calendly_url, d.calendlyUrl),
    script: str(r.script, d.script),
    defaultDailyCap: num(r.default_daily_cap, d.defaultDailyCap),
    rampDays: num(r.ramp_days, d.rampDays),
    rampStartCap: num(r.ramp_start_cap, d.rampStartCap),
    recordCalls: bool(r.record_calls, d.recordCalls),
  };
}

/** Only known Settings keys are written; unknown keys are ignored. */
export function settingsToRow(s: Partial<Settings>): Row {
  const out: Row = {};
  for (const [k, col] of Object.entries(SETTINGS_COLUMNS) as [keyof Settings, string][]) {
    if (s[k] !== undefined) out[col] = s[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const LEAD_PATCH_COLUMNS: Record<keyof LeadPatch, string> = {
  listId: 'list_id',
  businessName: 'business_name',
  contactName: 'contact_name',
  phones: 'phones',
  email: 'email',
  city: 'city',
  state: 'state',
  notes: 'notes',
  status: 'status',
  assignedTo: 'assigned_to',
  attemptDays: 'attempt_days',
  nextCallAt: 'next_call_at',
  callbackAt: 'callback_at',
  callbackOwner: 'callback_owner',
};

const TIMESTAMP_PATCH_KEYS = new Set(['nextCallAt', 'callbackAt']);

/** LeadPatch -> the snake_case JSON object `update_lead(p_patch)` expects. Unknown keys are dropped. */
export function leadPatchToRow(patch: LeadPatch): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = LEAD_PATCH_COLUMNS[k as keyof LeadPatch];
    if (!col || v === undefined) continue;
    out[col] = TIMESTAMP_PATCH_KEYS.has(k) && typeof v === 'string' ? isoOrNull(v) ?? v : v;
  }
  return out;
}

/**
 * Normalises phones to E.164. Returns the cleaned list, or the first input that is invalid.
 */
export function normalizePhoneList(phones: string[]): { phones: string[] } | { invalid: string } {
  const out: string[] = [];
  for (const p of phones) {
    const n = normalizePhone(p);
    if (!n) return { invalid: p };
    if (!out.includes(n)) out.push(n);
  }
  return { phones: out };
}

/** NewLead -> import row (phones normalised; invalid phones dropped, max 3). */
export function importRowToJson(row: NewLead): Row {
  const phones: string[] = [];
  for (const p of row.phones ?? []) {
    const n = normalizePhone(p);
    if (n && !phones.includes(n)) phones.push(n);
    if (phones.length === 3) break;
  }
  return {
    businessName: (row.businessName ?? '').trim(),
    contactName: (row.contactName ?? '').trim(),
    phones,
    email: (row.email ?? '').trim(),
    city: (row.city ?? '').trim(),
    state: (row.state ?? '').trim(),
    notes: (row.notes ?? '').trim(),
  };
}

export function newCallToRow(input: NewCallInput, meId: string): Row {
  return {
    lead_id: input.leadId,
    caller_id: input.callerId === undefined ? meId : input.callerId,
    direction: input.direction,
    from_number: normalizePhone(input.fromNumber) ?? input.fromNumber,
    to_number: normalizePhone(input.toNumber) ?? input.toNumber,
    ring: input.ring,
    started_at: input.startedAt ? isoOrNull(input.startedAt) ?? new Date().toISOString() : new Date().toISOString(),
    answered_at: isoOrNull(input.answeredAt ?? null),
    ended_at: isoOrNull(input.endedAt ?? null),
    talk_seconds: Math.max(0, Math.round(input.talkSeconds ?? 0)),
    result: input.result ?? null,
    notes: input.notes ?? '',
    recording_url: input.recordingUrl ?? null,
    provider_call_id: input.providerCallId ?? null,
  };
}

const CALL_PATCH_COLUMNS: Record<keyof CallPatch, string> = {
  answeredAt: 'answered_at',
  endedAt: 'ended_at',
  talkSeconds: 'talk_seconds',
  result: 'result',
  notes: 'notes',
  recordingUrl: 'recording_url',
  disposition: 'disposition',
};

export function callPatchToRow(patch: CallPatch): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    const col = CALL_PATCH_COLUMNS[k as keyof CallPatch];
    if (!col || v === undefined) continue;
    if (k === 'answeredAt' || k === 'endedAt') out[col] = isoOrNull(v);
    else if (k === 'talkSeconds') out[col] = Math.max(0, Math.round(num(v)));
    else out[col] = v;
  }
  return out;
}

const LEAD_SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  businessName: 'business_name',
  contactName: 'contact_name',
  status: 'status',
  lastCalledAt: 'last_called_at',
  nextCallAt: 'next_call_at',
  attemptDays: 'attempt_days',
};

export function leadSortColumn(field: string | undefined): string {
  return (field && LEAD_SORT_COLUMNS[field]) || 'created_at';
}

// ---------------------------------------------------------------------------
// Metrics (the SQL already returns camelCase with the Metrics shape)
// ---------------------------------------------------------------------------

/** get_my_script() jsonb -> MyScript. Accepts camelCase or snake_case keys; falls back to the team script. */
export function myScriptFromJson(j: unknown): MyScript {
  const r = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Row;
  const teamScript = str(r.teamScript ?? r.team_script);
  const personal = r.isPersonal ?? r.is_personal;
  const isPersonal = personal === true || personal === 'true' || personal === 't';
  const script = str(r.script, teamScript);
  if (isPersonal && script.trim()) return { script, isPersonal: true, teamScript };
  return { script: teamScript, isPersonal: false, teamScript };
}

export function totalsFromJson(j: unknown): MetricsTotals {
  const r = (j && typeof j === 'object' ? j : {}) as Row;
  const dials = num(r.dials);
  const pickups = num(r.pickups);
  return {
    dials,
    pickups,
    pickupRate: dials ? num(r.pickupRate, pickups / dials) : 0,
    conversations: num(r.conversations),
    bookings: num(r.bookings),
    talkSeconds: num(r.talkSeconds),
    droppedPickups: num(r.droppedPickups),
  };
}

function rowsOf(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : [];
}

export function metricsFromJson(j: unknown, range: { from: string; to: string }): Metrics {
  const r = (j && typeof j === 'object' ? j : {}) as Row;
  const counts = new Map(rowsOf(r.outcomes).map((o) => [str(o.disposition), num(o.count)]));
  return {
    range: { from: iso(range.from), to: iso(range.to) },
    totals: totalsFromJson(r.totals),
    previousTotals: totalsFromJson(r.previousTotals),
    byCaller: rowsOf(r.byCaller).map((x) => ({ ...totalsFromJson(x), callerId: str(x.callerId), label: str(x.label) })),
    byDay: rowsOf(r.byDay).map((x) => ({ ...totalsFromJson(x), date: str(x.date), label: str(x.label) })),
    byNumber: rowsOf(r.byNumber).map((x) => ({ ...totalsFromJson(x), number: str(x.number), numberId: idOrNull(x.numberId), label: str(x.label) })),
    byList: rowsOf(r.byList).map((x) => ({ ...totalsFromJson(x), listId: str(x.listId), label: str(x.label) })),
    outcomes: DISPOSITIONS.map((d) => ({ disposition: d.value, label: d.label, count: counts.get(d.value) ?? 0 })),
  };
}
