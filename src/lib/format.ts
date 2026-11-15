/**
 * Formatting and normalising helpers. Pure functions, safe to use anywhere (including tests).
 * Dates use the machine's local time zone.
 */

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/**
 * Normalise user input to E.164. US/Canada (+1) is assumed when no country code is given.
 * Accepts "(214) 555-0123", "214.555.0123", "1-214-555-0123", "+44 20 7946 0958", etc.
 * Returns null if it cannot be a valid number.
 */
export function normalizePhone(input: string | null | undefined, defaultCountryCode = '1'): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (!trimmed) return null;
  // Strip extensions like "x123" / "ext. 12".
  const noExt = trimmed.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '');
  const hasPlus = noExt.startsWith('+') || noExt.startsWith('00');
  let digits = noExt.replace(/\D/g, '');
  if (noExt.startsWith('00')) digits = digits.slice(2);
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith('1') && !isValidNanp(digits.slice(1))) return null;
    return '+' + digits;
  }
  if (defaultCountryCode === '1') {
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10 || !isValidNanp(digits)) return null;
    return '+1' + digits;
  }
  if (digits.startsWith('0')) digits = digits.slice(1);
  const full = defaultCountryCode + digits;
  if (full.length < 8 || full.length > 15) return null;
  return '+' + full;
}

/** 10-digit NANP: area code and exchange can't start with 0 or 1. */
function isValidNanp(ten: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

/** True if `input` normalises to a valid number. */
export function isValidPhone(input: string | null | undefined): boolean {
  return normalizePhone(input) !== null;
}

/** "+12145550123" -> "(214) 555-0123"; other countries -> "+44 2079460958"; invalid -> input. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const n = e164.startsWith('+') ? e164 : normalizePhone(e164) ?? e164;
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  if (n.startsWith('+')) return n;
  return e164;
}

/** Area code of a +1 number ("214"), or null for non-NANP / invalid. */
export function areaCode(phone: string | null | undefined): string | null {
  const n = normalizePhone(phone ?? '');
  if (!n) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(n);
  return m ? m[1] : null;
}

/** Digits only, for searching. */
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Durations / numbers
// ---------------------------------------------------------------------------

/** 75 -> "1:15", 3725 -> "1:02:05". Negative / NaN -> "0:00". */
export function formatDuration(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** 75 -> "1m 15s", 3725 -> "1h 2m", 40 -> "40s". */
export function formatDurationLong(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** Fraction 0..1 -> "12.5%". */
export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 12345 -> "12,345". */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(Number.isFinite(n) ? n : 0);
}

/** Relative change (current vs previous) as a fraction; null when previous is 0. */
export function relativeChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return (current - previous) / previous;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

type DateInput = string | number | Date;

function toDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

/** "Nov 15, 2026". */
export function formatDate(d: DateInput | null | undefined): string {
  if (d === null || d === undefined || d === '') return '';
  return toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "3:05 PM". */
export function formatTime(d: DateInput | null | undefined): string {
  if (d === null || d === undefined || d === '') return '';
  return toDate(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "Nov 15, 3:05 PM". */
export function formatDateTime(d: DateInput | null | undefined): string {
  if (d === null || d === undefined || d === '') return '';
  return toDate(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "just now", "5 min ago", "in 2 h", "3 days ago". */
export function formatRelative(d: DateInput | null | undefined, now: DateInput = Date.now()): string {
  if (d === null || d === undefined || d === '') return '';
  const diff = toDate(d).getTime() - toDate(now).getTime();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const wrap = (s: string) => (future ? `in ${s}` : `${s} ago`);
  if (abs < 45_000) return 'just now';
  if (abs < 3_600_000) return wrap(`${Math.round(abs / 60_000)} min`);
  if (abs < 86_400_000) return wrap(`${Math.round(abs / 3_600_000)} h`);
  const days = Math.round(abs / 86_400_000);
  return wrap(`${days} day${days === 1 ? '' : 's'}`);
}

/** Local midnight at the start of the day containing `d`. */
export function startOfDay(d: DateInput): Date {
  const x = new Date(toDate(d).getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Local midnight at the start of the day after `d`. */
export function startOfNextDay(d: DateInput): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 1);
  return x;
}

/** Adds whole local days (DST-safe). */
export function addDays(d: DateInput, days: number): Date {
  const x = new Date(toDate(d).getTime());
  x.setDate(x.getDate() + days);
  return x;
}

/** Local 'YYYY-MM-DD'. */
export function toDateKey(d: DateInput): string {
  const x = toDate(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Whole local calendar days from `a` to `b` (b later -> positive). */
export function daysBetween(a: DateInput, b: DateInput): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86_400_000);
}

/** Value for <input type="datetime-local"> from an ISO string. */
export function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO string from an <input type="datetime-local"> value ('' -> null). */
export function fromDateTimeLocalValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
