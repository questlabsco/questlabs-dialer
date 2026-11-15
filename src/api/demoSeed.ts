/**
 * Deterministic seed data + pure business rules shared by the demo Api and its seed simulation.
 * Everything here is pure (no storage, no timers) so it can be unit-tested.
 */
import {
  DEFAULT_SETTINGS,
  dispositionInfo,
  type CallRecord,
  type CallResult,
  type Disposition,
  type Lead,
  type PhoneNumber,
  type PresenceStatus,
  type Profile,
  type Settings,
} from '../types';
import { addDays, areaCode, daysBetween, startOfDay, startOfNextDay, toDateKey } from '../lib/format';

export const DEMO_STATE_VERSION = 2;
export const DEMO_SEED = 20261115;
export const LOCK_STALE_MS = 10 * 60 * 1000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type StoredNumber = Pick<PhoneNumber, 'id' | 'number' | 'label' | 'active' | 'dailyCap' | 'addedAt' | 'providerId'>;

export interface StoredList {
  id: string;
  name: string;
  createdAt: string;
}

export interface StoredPresence {
  status: PresenceStatus;
  since: string;
  detail: string | null;
  /** ms timestamp of the last real setPresence call; the simulator leaves these callers alone. */
  manualAt: number | null;
}

export interface DemoState {
  version: number;
  seededAt: string;
  /** Monotonic id counter. */
  seq: number;
  users: Profile[];
  settings: Settings;
  lists: StoredList[];
  leads: Lead[];
  calls: CallRecord[];
  numbers: StoredNumber[];
  presence: Record<string, StoredPresence>;
  /** Personal script copies keyed by user id. Optional so state saved before this field still loads. */
  callerScripts?: Record<string, string>;
  /** User ids still on a password an admin set (created / reset). Optional for older saved state. */
  mustChangePassword?: Record<string, true>;
}

export function nextId(state: DemoState, prefix: string): string {
  state.seq += 1;
  return `${prefix}_${state.seq.toString(36).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  /** mulberry32, uniform in [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    return items[items.length - 1][0];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Ramp-up: linear from rampStartCap (day 0) to dailyCap (day rampDays), never above dailyCap. */
export function rampedCap(dailyCap: number, addedAt: string, nowMs: number, settings: Settings): number {
  const age = Math.max(0, daysBetween(addedAt, nowMs));
  const start = Math.min(settings.rampStartCap, dailyCap);
  if (settings.rampDays <= 0 || age >= settings.rampDays) return dailyCap;
  return Math.min(dailyCap, Math.round(start + ((dailyCap - start) * age) / settings.rampDays));
}

/**
 * Number choice rule (see Api.pickFromNumber). `candidates` must already be filtered to active
 * numbers under their cap.
 */
export function chooseNumber<T extends { number: string; addedAt: string; callsToday: number }>(
  candidates: T[],
  toPhone: string,
): T | null {
  if (candidates.length === 0) return null;
  const ac = areaCode(toPhone);
  const same = ac ? candidates.filter((c) => areaCode(c.number) === ac) : [];
  const group = same.length > 0 ? same : candidates;
  return [...group].sort((a, b) => a.callsToday - b.callsToday || a.addedAt.localeCompare(b.addedAt))[0];
}

/** Applies a missed day to `lead` in place. */
export function applyMissedDay(lead: Lead, callerId: string, nowMs: number, settings: Settings): void {
  lead.attemptDays += 1;
  lead.lastCalledAt = new Date(nowMs).toISOString();
  lead.lastCalledBy = callerId;
  lead.lockedBy = null;
  lead.lockedAt = null;
  lead.callbackAt = null;
  if (lead.attemptDays >= settings.retryDays) {
    lead.status = 'exhausted';
    lead.nextCallAt = null;
  } else {
    lead.status = 'no_answer';
    lead.nextCallAt = startOfNextDay(nowMs).toISOString();
  }
}

/** Applies the DISPOSITIONS status rule to `lead` in place. */
export function applyDisposition(
  lead: Lead,
  disposition: Disposition,
  callerId: string,
  nowMs: number,
  settings: Settings,
  callbackAt: string | null,
): void {
  const info = dispositionInfo(disposition);
  if (info.leadStatus === 'missed_day') {
    applyMissedDay(lead, callerId, nowMs, settings);
    return;
  }
  lead.lastCalledAt = new Date(nowMs).toISOString();
  lead.lastCalledBy = callerId;
  lead.lockedBy = null;
  lead.lockedAt = null;
  lead.status = info.leadStatus;
  if (info.leadStatus === 'callback') {
    lead.callbackAt = callbackAt;
    lead.callbackOwner = callerId;
    lead.nextCallAt = callbackAt;
  } else {
    lead.callbackAt = null;
    lead.callbackOwner = null;
    lead.nextCallAt = null;
  }
}

export function isLockedByOther(lead: Lead, userId: string, nowMs: number): boolean {
  if (!lead.lockedBy || lead.lockedBy === userId) return false;
  const at = lead.lockedAt ? Date.parse(lead.lockedAt) : 0;
  return nowMs - at < LOCK_STALE_MS;
}

function isDue(iso: string | null, nowMs: number): boolean {
  return iso === null || Date.parse(iso) <= nowMs;
}

/**
 * Claim ordering (see Api.claimNextLeads). Returns candidate leads in priority order; caller
 * slices to `count`. `extraFilter` lets the seed simulation skip leads already worked today.
 */
export function rankClaimable(
  leads: Lead[],
  userId: string,
  nowMs: number,
  extraFilter?: (lead: Lead) => boolean,
): Lead[] {
  const callbacks: Lead[] = [];
  const mine: Lead[] = [];
  const pool: Lead[] = [];
  for (const l of leads) {
    if (l.phones.length === 0) continue;
    if (isLockedByOther(l, userId, nowMs)) continue;
    if (extraFilter && !extraFilter(l)) continue;
    if (l.status === 'callback') {
      if (l.callbackOwner === userId && isDue(l.callbackAt ?? l.nextCallAt, nowMs)) callbacks.push(l);
      else if (l.callbackOwner === null && isDue(l.nextCallAt, nowMs)) {
        if (l.assignedTo === userId) mine.push(l);
        else if (l.assignedTo === null) pool.push(l);
      }
      continue;
    }
    if (l.status !== 'new' && l.status !== 'no_answer') continue;
    if (!isDue(l.nextCallAt, nowMs)) continue;
    if (l.assignedTo === userId) mine.push(l);
    else if (l.assignedTo === null) pool.push(l);
  }
  const key = (l: Lead) => l.nextCallAt ?? l.createdAt;
  callbacks.sort((a, b) => (a.callbackAt ?? '').localeCompare(b.callbackAt ?? ''));
  mine.sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
  pool.sort((a, b) => key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
  return [...callbacks, ...mine, ...pool];
}

// ---------------------------------------------------------------------------
// Demo recording: a short, quiet tone as a WAV data URL (generated, no external asset).
// ---------------------------------------------------------------------------

let cachedWav: string | null = null;
export function demoRecordingUrl(): string {
  if (cachedWav) return cachedWav;
  const rate = 8000;
  const seconds = 1.5;
  const n = Math.floor(rate * seconds);
  const bytes = new Uint8Array(44 + n);
  const view = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  str(36, 'data');
  view.setUint32(40, n, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 800, (n - i) / 800);
    bytes[44 + i] = 128 + Math.round(18 * fade * Math.sin((2 * Math.PI * 440 * i) / rate));
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  cachedWav = 'data:audio/wav;base64,' + btoa(bin);
  return cachedWav;
}

// ---------------------------------------------------------------------------
// Seed content
// ---------------------------------------------------------------------------

const AREAS: readonly { code: string; city: string; state: string }[] = [
  { code: '214', city: 'Dallas', state: 'TX' },
  { code: '713', city: 'Houston', state: 'TX' },
  { code: '512', city: 'Austin', state: 'TX' },
  { code: '305', city: 'Miami', state: 'FL' },
  { code: '404', city: 'Atlanta', state: 'GA' },
  { code: '602', city: 'Phoenix', state: 'AZ' },
  { code: '312', city: 'Chicago', state: 'IL' },
  { code: '615', city: 'Nashville', state: 'TN' },
  { code: '702', city: 'Las Vegas', state: 'NV' },
  { code: '614', city: 'Columbus', state: 'OH' },
  { code: '303', city: 'Denver', state: 'CO' },
  { code: '919', city: 'Raleigh', state: 'NC' },
];

const FIRST = ['James', 'Maria', 'Robert', 'Linda', 'Michael', 'Patricia', 'David', 'Jennifer', 'Carlos', 'Elizabeth', 'Daniel', 'Susan', 'Marcus', 'Angela', 'Kevin', 'Rosa', 'Brian', 'Tanya', 'Luis', 'Denise', 'Greg', 'Monica', 'Tyrone', 'Heather', 'Anthony', 'Keisha', 'Steven', 'Lauren', 'Raj', 'Megan', 'Victor', 'Brenda', 'Derek', 'Nicole', 'Hector', 'Crystal'];
const LAST = ['Henderson', 'Garcia', 'Walker', 'Nguyen', 'Patel', 'Brooks', 'Coleman', 'Ramirez', 'Foster', 'Bennett', 'Hayes', 'Morales', 'Price', 'Sullivan', 'Jenkins', 'Ortiz', 'Barnes', 'Fisher', 'Reyes', 'Murphy', 'Grant', 'Holloway', 'Castillo', 'Dawson', 'Whitaker', 'Pruitt', 'Lowell', 'Kendrick'];
const PREFIX = ['Precision', 'Summit', 'Blue Sky', 'Reliable', 'Elite', 'Hometown', 'Lone Star', 'Sunrise', 'Cornerstone', 'Evergreen', 'Patriot', 'Northside', 'Allied', 'Golden', 'Metro', 'Riverbend', 'True North', 'Ironwood', 'Crystal Clear', 'Prime'];
const TRADES_A = ['Plumbing', 'Roofing', 'HVAC', 'Landscaping', 'Auto Repair', 'Electric', 'Pest Control', 'Cleaning Services', 'Painting', 'Fencing', 'Pool Service', 'Tree Service', 'Garage Doors', 'Flooring', 'Moving', 'Towing', 'Concrete', 'Remodeling'];
const TRADES_B = ['Dental', 'Family Dentistry', 'Chiropractic', 'Physical Therapy', 'Med Spa', 'Veterinary Clinic', 'Optometry', 'Urgent Care', 'Dermatology', 'Orthodontics'];
const SUFFIX = ['', '', '', ' LLC', ' Co.', ' & Sons', ' Pros', ' Group', ' Inc.'];

const CALL_NOTES: Record<Disposition, readonly string[]> = {
  booked: ['Booked for Thursday, wants pricing deck first.', 'Owner keen - booked intro call.', 'Booked; partner will join.', 'Booked demo, mentioned slow season.'],
  callback: ['Busy with a customer, call back tomorrow.', 'Asked to call after 2pm.', 'Driving - call back later this week.', 'Wants to talk to spouse first.'],
  not_interested: ['Happy with current provider.', 'No budget this quarter.', 'Not interested, polite.', 'Does all marketing in-house.'],
  wrong_number: ['Number belongs to a different business.', 'Personal number, not the owner.', 'Wrong person, no longer with company.'],
  do_not_call: ['Asked to be removed from list.', 'Requested do not call.'],
  voicemail: ['Went to voicemail.'],
  hung_up: ['Hung up after intro.', 'Hung up immediately.', 'Line went dead.'],
};

const SAMPLE_SCRIPT = `Hi {contactName}, this is {callerName} with Quest Labs - did I catch you at a bad time?

We help {businessName} and other local businesses get more booked jobs from their existing website and Google profile, without adding ad spend.

Quick question: how are most of your new customers finding you right now?

[Listen. Mirror one pain point back.]

That's exactly what we fix. I'd love to show you what that looks like for your area - it takes about 15 minutes. Would later this week work, or is early next week better?

If not interested: "Totally fair - mind if I ask what you're using today?" Then thank them and wrap up.`;

interface NumberSeed {
  number: string;
  label: string;
  ageDays: number;
  /** Multiplier on pickup probability (1 = average). */
  quality: number;
}

const NUMBER_SEEDS: readonly NumberSeed[] = [
  { number: '+12145550100', label: 'Dallas main', ageDays: 120, quality: 1.05 },
  { number: '+12145550101', label: 'Dallas 2', ageDays: 60, quality: 1.0 },
  { number: '+17135550100', label: 'Houston', ageDays: 90, quality: 1.1 },
  { number: '+15125550100', label: 'Austin', ageDays: 45, quality: 0.95 },
  { number: '+13055550100', label: 'Miami', ageDays: 75, quality: 0.25 },
  { number: '+14045550100', label: 'Atlanta', ageDays: 30, quality: 1.0 },
  { number: '+16025550100', label: 'Phoenix (new)', ageDays: 10, quality: 1.15 },
  { number: '+13125550100', label: 'Chicago (new)', ageDays: 6, quality: 1.1 },
  { number: '+16155550100', label: 'Nashville (new)', ageDays: 3, quality: 1.0 },
  { number: '+17025550100', label: 'Las Vegas (new)', ageDays: 0, quality: 1.0 },
];

export const DEMO_USERS: readonly { id: string; email: string; fullName: string; role: 'admin' | 'caller' }[] = [
  { id: 'user_admin', email: 'admin@questlabs.demo', fullName: 'Avery Quinn', role: 'admin' },
  { id: 'user_jordan', email: 'jordan@questlabs.demo', fullName: 'Jordan Blake', role: 'caller' },
  { id: 'user_sam', email: 'sam@questlabs.demo', fullName: 'Sam Rivera', role: 'caller' },
  { id: 'user_taylor', email: 'taylor@questlabs.demo', fullName: 'Taylor Brooks', role: 'caller' },
];

// ---------------------------------------------------------------------------
// Seed builder
// ---------------------------------------------------------------------------

export interface SeedOptions {
  /** Only users, settings and numbers (no lists, leads, calls). For tests. */
  empty?: boolean;
  seed?: number;
}

export function buildSeedState(nowMs: number, opts: SeedOptions = {}): DemoState {
  const rng = new Rng(opts.seed ?? DEMO_SEED);
  const today = startOfDay(nowMs).getTime();
  const iso = (ms: number) => new Date(ms).toISOString();

  const state: DemoState = {
    version: DEMO_STATE_VERSION,
    seededAt: iso(nowMs),
    seq: 0,
    users: DEMO_USERS.map((u, i) => ({
      ...u,
      active: true,
      createdAt: iso(addDays(today, -200 + i * 10).getTime() + 10 * HOUR),
    })),
    settings: { ...DEFAULT_SETTINGS, script: SAMPLE_SCRIPT },
    lists: [],
    leads: [],
    calls: [],
    numbers: [],
    presence: {},
    callerScripts: {},
  };

  const quality = new Map<string, number>();
  for (const ns of NUMBER_SEEDS) {
    const id = nextId(state, 'num');
    quality.set(id, ns.quality);
    state.numbers.push({
      id,
      number: ns.number,
      label: ns.label,
      active: true,
      dailyCap: state.settings.defaultDailyCap,
      addedAt: iso(addDays(today, -ns.ageDays).getTime() + 8 * HOUR),
      providerId: null,
    });
  }

  const callers = state.users.filter((u) => u.role === 'caller');
  const presenceStart: PresenceStatus[] = ['dialing', 'on_call', 'paused'];
  callers.forEach((c, i) => {
    state.presence[c.id] = { status: presenceStart[i % 3], since: iso(nowMs - (i + 1) * 95_000), detail: null, manualAt: null };
  });

  if (opts.empty) return state;

  // ---- Phones: 555-0110..0199 in each area code, shuffled; outbound numbers use 0100-0109.
  const phonePool: string[] = [];
  for (const a of AREAS) for (let x = 110; x <= 199; x++) phonePool.push(`+1${a.code}5550${x}`);
  const byArea = new Map<string, string[]>();
  for (const a of AREAS) byArea.set(a.code, rng.shuffle(phonePool.filter((p) => p.startsWith(`+1${a.code}`))));
  const takePhone = (code: string): string | null => {
    const own = byArea.get(code);
    if (own && own.length) return own.pop()!;
    for (const list of byArea.values()) if (list.length) return list.pop()!;
    return null;
  };

  // ---- Lists and leads
  const listDefs = [
    { name: 'Fall sweep - Sunbelt trades', ageDays: 16, count: 400, areas: AREAS, trades: TRADES_A },
    { name: 'Texas home services', ageDays: 4, count: 180, areas: AREAS.slice(0, 3), trades: TRADES_A },
    { name: 'Southeast dental & clinics', ageDays: 0, count: 120, areas: [AREAS[3], AREAS[4], AREAS[7], AREAS[11]], trades: TRADES_B },
  ];
  const usedNames = new Set<string>();
  for (const def of listDefs) {
    const createdMs = addDays(today, -def.ageDays).getTime() + 7.5 * HOUR;
    const list: StoredList = { id: nextId(state, 'list'), name: def.name, createdAt: iso(createdMs) };
    state.lists.push(list);
    for (let i = 0; i < def.count; i++) {
      const area = rng.pick(def.areas);
      let businessName = '';
      for (let tries = 0; tries < 8; tries++) {
        const base = rng.chance(0.5) ? rng.pick(LAST) : rng.pick(PREFIX);
        const trade = rng.pick(def.trades);
        businessName = `${base} ${trade}${rng.pick(SUFFIX)}`;
        if (!usedNames.has(businessName)) break;
        businessName = `${businessName} of ${area.city}`;
        if (!usedNames.has(businessName)) break;
      }
      usedNames.add(businessName);
      const first = rng.pick(FIRST);
      const last = rng.pick(LAST);
      const phoneCount = rng.weighted([
        [1, 85],
        [2, 10],
        [3, 5],
      ] as const);
      const phones: string[] = [];
      for (let p = 0; p < phoneCount; p++) {
        const ph = takePhone(p === 0 ? area.code : rng.chance(0.7) ? area.code : rng.pick(AREAS).code);
        if (ph) phones.push(ph);
      }
      const slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20);
      const r = rng.next();
      const assignedTo = r < 0.11 ? callers[0].id : r < 0.22 ? callers[1].id : r < 0.33 ? callers[2].id : null;
      state.leads.push({
        id: nextId(state, 'lead'),
        listId: list.id,
        businessName,
        contactName: rng.chance(0.92) ? `${first} ${last}` : '',
        phones,
        email: rng.chance(0.8) ? `${first.toLowerCase()}@${slug}.example` : '',
        city: area.city,
        state: area.state,
        notes: rng.chance(0.12) ? rng.pick(['Owner-operated.', 'Has 2 locations.', 'Referred by a past client.', 'Google rating 4.8.', 'Seasonal business.']) : '',
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
        createdAt: iso(createdMs + i * 1000),
      });
    }
  }

  simulateHistory(state, rng, nowMs, quality);
  return state;
}

/** Simulates ~14 days of dialing so leads' statuses and the call history agree. */
function simulateHistory(state: DemoState, rng: Rng, nowMs: number, quality: Map<string, number>): void {
  const settings = state.settings;
  const callers = state.users.filter((u) => u.role === 'caller');
  const today = startOfDay(nowMs).getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const touched = new Map<string, string>(); // leadId -> dateKey worked
  const numberCount = new Map<string, number>(); // numberId|dateKey -> dials
  const lastFrom = new Map<string, string>(); // leadId -> our number last used
  const listCreated = new Map(state.lists.map((l) => [l.id, Date.parse(l.createdAt)]));
  const isAvailable = (l: Lead, t: number) => (listCreated.get(l.listId) ?? 0) <= t;

  const pickNumber = (toPhone: string, t: number, dayKey: string): StoredNumber | null => {
    const candidates = state.numbers
      .filter((n) => n.active && Date.parse(n.addedAt) <= t)
      .map((n) => ({ ...n, callsToday: numberCount.get(`${n.id}|${dayKey}`) ?? 0 }))
      .filter((n) => n.callsToday < rampedCap(n.dailyCap, n.addedAt, t, settings));
    return chooseNumber(candidates, toPhone);
  };

  const push = (rec: Omit<CallRecord, 'id'>) => {
    const full: CallRecord = { id: nextId(state, 'call'), ...rec };
    state.calls.push(full);
    return full;
  };

  const humanP = 0.105;
  const vmP = 0.17;

  for (let offset = -14; offset <= 0; offset++) {
    const dayStart = addDays(today, offset).getTime();
    const dow = new Date(dayStart).getDay();
    const weekend = dow === 0 || dow === 6;
    const dayKey = toDateKey(dayStart);
    const workStart = dayStart + 9 * HOUR;
    const workEnd = Math.min(dayStart + 17 * HOUR, nowMs - 60_000);
    if (workEnd <= workStart) continue;

    for (const caller of callers) {
      let target = weekend ? (rng.chance(0.35) ? rng.int(8, 30) : 0) : rng.int(80, 115);
      if (offset === 0) target = Math.round((target * (workEnd - workStart)) / (8 * HOUR));
      let t = workStart + rng.int(0, 25 * 60) * 1000;
      let dials = 0;

      while (dials < target && t < workEnd) {
        const candidates = rankClaimable(state.leads, caller.id, t, (l) => isAvailable(l, t) && touched.get(l.id) !== dayKey);
        const lead = candidates[0];
        if (!lead) break;
        touched.set(lead.id, dayKey);

        let cursor = t;
        let answered = false;
        let outOfNumbers = false;
        for (const phone of [...lead.phones]) {
          for (let ring: 1 | 2 = 1; ring <= 2; ring = (ring + 1) as 1 | 2) {
            const num = pickNumber(phone, cursor, dayKey);
            if (!num) {
              outOfNumbers = true;
              break;
            }
            numberCount.set(`${num.id}|${dayKey}`, (numberCount.get(`${num.id}|${dayKey}`) ?? 0) + 1);
            lastFrom.set(lead.id, num.number);
            const q = quality.get(num.id) ?? 1;
            const neverDialed = lead.attemptDays === 0 && ring === 1;
            let result: CallResult;
            if (neverDialed && rng.chance(0.025)) result = 'bad_number';
            else
              result = rng.weighted([
                ['answered', humanP * q],
                ['voicemail', vmP],
                ['busy', 0.02],
                ['failed', 0.008],
                ['no_answer', 1 - humanP * q - vmP - 0.028],
              ] as const);
            dials++;
            const base = {
              leadId: lead.id,
              listId: lead.listId,
              callerId: caller.id,
              direction: 'outbound' as const,
              fromNumber: num.number,
              toNumber: phone,
              ring,
              startedAt: iso(cursor),
              disposition: null,
              notes: '',
              recordingUrl: null,
            };
            if (result === 'answered') {
              const answerAt = cursor + rng.int(4, 16) * 1000;
              let talk: number;
              let disp: Disposition;
              if (rng.chance(0.22)) {
                talk = rng.int(3, 18);
                disp = 'hung_up';
              } else {
                talk = rng.int(20, 70) + (rng.chance(0.5) ? rng.int(0, 360) : 0);
                disp = rng.weighted([
                  ['booked', 0.1],
                  ['callback', 0.17],
                  ['not_interested', 0.55],
                  ['wrong_number', 0.07],
                  ['do_not_call', 0.06],
                  ['hung_up', 0.05],
                ] as const);
              }
              const endAt = answerAt + talk * 1000;
              push({ ...base, answeredAt: iso(answerAt), endedAt: iso(endAt), talkSeconds: talk, result, disposition: disp, notes: rng.chance(0.85) ? rng.pick(CALL_NOTES[disp]) : '' });
              // The other line, which was still ringing when this one answered.
              if (rng.chance(0.55)) {
                const other = rankClaimable(state.leads, caller.id, cursor, (l) => l.id !== lead.id && isAvailable(l, cursor) && touched.get(l.id) !== dayKey)[0];
                const otherNum = other ? pickNumber(other.phones[0], cursor, dayKey) : null;
                if (other && otherNum) {
                  numberCount.set(`${otherNum.id}|${dayKey}`, (numberCount.get(`${otherNum.id}|${dayKey}`) ?? 0) + 1);
                  const pickedUp = rng.chance(0.07);
                  dials++;
                  push({
                    leadId: other.id,
                    listId: other.listId,
                    callerId: caller.id,
                    direction: 'outbound',
                    fromNumber: otherNum.number,
                    toNumber: other.phones[0],
                    ring: 1,
                    startedAt: iso(cursor + 500),
                    answeredAt: pickedUp ? iso(answerAt + 1500) : null,
                    endedAt: iso(answerAt + (pickedUp ? 2500 : 200)),
                    talkSeconds: 0,
                    result: pickedUp ? 'dropped_pickup' : 'dropped',
                    disposition: null,
                    notes: '',
                    recordingUrl: null,
                  });
                }
              }
              let callbackAt: string | null = null;
              if (disp === 'callback') {
                callbackAt = iso(addDays(startOfDay(endAt), rng.int(1, 6)).getTime() + rng.int(10, 16) * HOUR + rng.pick([0, 15, 30, 45]) * 60_000);
              }
              applyDisposition(lead, disp, caller.id, endAt, settings, callbackAt);
              cursor = endAt + rng.int(20, 70) * 1000;
              answered = true;
              break;
            }
            let endAt: number;
            let answeredAt: string | null = null;
            if (result === 'voicemail') {
              answeredAt = iso(cursor + rng.int(8, 18) * 1000);
              endAt = Date.parse(answeredAt) + 3000;
            } else if (result === 'busy') endAt = cursor + 3000;
            else if (result === 'failed') endAt = cursor + 1500;
            else if (result === 'bad_number') endAt = cursor + 2500;
            else endAt = cursor + settings.ringSeconds * 1000;
            push({ ...base, answeredAt, endedAt: iso(endAt), talkSeconds: 0, result });
            cursor = endAt + 1000;
            if (result === 'bad_number') {
              lead.phones = lead.phones.filter((p) => p !== phone);
              break;
            }
            if (!settings.doubleRing) break;
          }
          if (answered || outOfNumbers) break;
        }
        if (!answered) {
          if (lead.phones.length === 0) {
            lead.status = 'bad_number';
            lead.nextCallAt = null;
            lead.lastCalledAt = iso(cursor);
            lead.lastCalledBy = caller.id;
          } else if (!outOfNumbers) {
            applyMissedDay(lead, caller.id, cursor, settings);
          }
        }
        t = cursor + rng.int(60, 300) * 1000;
      }
    }

    // A few leads call back in.
    if (!weekend && offset < 0) {
      const inboundCount = rng.int(0, 2);
      for (let k = 0; k < inboundCount; k++) {
        const t = dayStart + rng.int(10, 16) * HOUR + rng.int(0, 59) * 60_000;
        const called = state.leads.filter((l) => l.lastCalledBy && l.lastCalledAt && Date.parse(l.lastCalledAt) < t && l.phones.length > 0 && l.status !== 'do_not_call');
        if (!called.length) continue;
        const lead = rng.pick(called);
        const callerId = lead.lastCalledBy!;
        const ours = lastFrom.get(lead.id) ?? state.numbers[0].number;
        const pickedUp = rng.chance(0.7);
        if (pickedUp) {
          const talk = rng.int(30, 240);
          const disp = rng.weighted([
            ['booked', 0.35],
            ['callback', 0.25],
            ['not_interested', 0.4],
          ] as const);
          push({
            leadId: lead.id,
            listId: lead.listId,
            callerId,
            direction: 'inbound',
            fromNumber: lead.phones[0],
            toNumber: ours,
            ring: 1,
            startedAt: iso(t),
            answeredAt: iso(t + 6000),
            endedAt: iso(t + 6000 + talk * 1000),
            talkSeconds: talk,
            result: 'answered',
            disposition: disp,
            notes: 'Called back. ' + rng.pick(CALL_NOTES[disp]),
            recordingUrl: null,
          });
          const cb = disp === 'callback' ? iso(addDays(startOfDay(t), 2).getTime() + 11 * HOUR) : null;
          applyDisposition(lead, disp, callerId, t + 6000 + talk * 1000, settings, cb);
        } else {
          push({
            leadId: lead.id,
            listId: lead.listId,
            callerId,
            direction: 'inbound',
            fromNumber: lead.phones[0],
            toNumber: ours,
            ring: 1,
            startedAt: iso(t),
            answeredAt: null,
            endedAt: iso(t + 25_000),
            talkSeconds: 0,
            result: 'missed_inbound',
            disposition: null,
            notes: '',
            recordingUrl: null,
          });
        }
      }
    }
  }

  state.calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  // Recordings on the most recent conversations.
  const convs = state.calls.filter((c) => c.result === 'answered' && c.talkSeconds >= 20);
  for (const c of convs.slice(-14)) c.recordingUrl = demoRecordingUrl();
}
