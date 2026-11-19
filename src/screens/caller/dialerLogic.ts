/**
 * Pure helpers for the caller screens (no React, no DOM): callback quick picks, callback grouping,
 * keyboard shortcut mapping, script placeholders, Calendly configuration check.
 */
import { DISPOSITIONS, type Disposition, type DispositionInfo, type Lead } from '../../types';
import type { DialerPhase } from '../../dialer/types';
import { startOfNextDay } from '../../lib/format';

// ---------------------------------------------------------------------------
// Callback quick picks
// ---------------------------------------------------------------------------

export type QuickPickId = 'in_1h' | 'in_3h' | 'tomorrow_10';

export interface QuickPick {
  id: QuickPickId;
  label: string;
  /** ISO time. */
  iso: string;
}

/** Quick callback times relative to `now` (seconds and ms zeroed). */
export function callbackQuickPicks(now: number | Date): QuickPick[] {
  const t = typeof now === 'number' ? now : now.getTime();
  const at = (ms: number) => {
    const d = new Date(ms);
    d.setSeconds(0, 0);
    return d.toISOString();
  };
  const tomorrow = startOfNextDay(t);
  tomorrow.setHours(10, 0, 0, 0);
  return [
    { id: 'in_1h', label: 'In 1 hour', iso: at(t + 3_600_000) },
    { id: 'in_3h', label: 'In 3 hours', iso: at(t + 3 * 3_600_000) },
    { id: 'tomorrow_10', label: 'Tomorrow 10:00', iso: tomorrow.toISOString() },
  ];
}

/** True when `iso` parses and is strictly after `now`. */
export function isFutureTime(iso: string | null | undefined, now: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > now;
}

/**
 * Validation message for the wrap-up form, or null when it can be saved.
 * `callbackAt` is only checked for outcomes that require it.
 */
export function wrapUpValidation(disposition: Disposition | null, callbackAt: string | null, now: number): string | null {
  if (!disposition) return 'Pick an outcome first.';
  const info = DISPOSITIONS.find((d) => d.value === disposition);
  if (info?.requiresCallbackAt) {
    if (!callbackAt) return 'Choose when to call back.';
    if (!isFutureTime(callbackAt, now)) return 'The callback time must be in the future.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Callback grouping
// ---------------------------------------------------------------------------

export interface CallbackGroups {
  overdue: Lead[];
  today: Lead[];
  upcoming: Lead[];
}

/**
 * Overdue: callbackAt before now (or missing). Due today: from now until local midnight.
 * Upcoming: later. Each group is sorted by callbackAt ascending.
 */
export function groupCallbacks(leads: readonly Lead[], now: number): CallbackGroups {
  const endOfToday = startOfNextDay(now).getTime();
  const groups: CallbackGroups = { overdue: [], today: [], upcoming: [] };
  const sorted = [...leads].sort((a, b) => (a.callbackAt ?? '').localeCompare(b.callbackAt ?? ''));
  for (const l of sorted) {
    const t = l.callbackAt ? new Date(l.callbackAt).getTime() : NaN;
    if (!Number.isFinite(t) || t < now) groups.overdue.push(l);
    else if (t < endOfToday) groups.today.push(l);
    else groups.upcoming.push(l);
  }
  return groups;
}

/** Callbacks that are due now (callbackAt <= now or missing). */
export function countDueCallbacks(leads: readonly Lead[], now: number): number {
  return leads.filter((l) => {
    const t = l.callbackAt ? new Date(l.callbackAt).getTime() : NaN;
    return !Number.isFinite(t) || t <= now;
  }).length;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export type ShortcutAction =
  | { type: 'mute' }
  | { type: 'hang_up' }
  | { type: 'pick'; disposition: Disposition }
  | { type: 'save' };

export interface ShortcutInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** True when focus is in an input / textarea / select / contenteditable. */
  inEditable: boolean;
  phase: DialerPhase;
  /** A manual call is ringing (H cancels it). */
  manualRinging?: boolean;
}

/** Disposition for a hotkey '1'..'7', or null. */
export function dispositionForHotkey(key: string): DispositionInfo | null {
  return DISPOSITIONS.find((d) => d.hotkey === key) ?? null;
}

/**
 * Maps a key press to a dialer action.
 * - Ctrl/Cmd+Enter in wrap-up saves (also from inside the notes box).
 * - Everything else never fires while typing in a field or with a modifier held:
 *   M = mute and H = hang up while connected (H also cancels a ringing manual call);
 *   1–7 = pick an outcome in wrap-up.
 */
export function resolveShortcut(e: ShortcutInput): ShortcutAction | null {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) {
    return e.phase === 'wrap_up' ? { type: 'save' } : null;
  }
  if (e.inEditable || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.phase === 'connected') {
    if (k === 'm') return { type: 'mute' };
    if (k === 'h') return { type: 'hang_up' };
    return null;
  }
  if (e.phase === 'dialing' && e.manualRinging) {
    return k === 'h' ? { type: 'hang_up' } : null;
  }
  if (e.phase === 'wrap_up') {
    const d = dispositionForHotkey(k);
    return d ? { type: 'pick', disposition: d.value } : null;
  }
  return null;
}

/** True for elements where typing must not trigger shortcuts. Works on any element-like object. */
export function isEditableTarget(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ---------------------------------------------------------------------------
// Script, Calendly, misc
// ---------------------------------------------------------------------------

export interface ScriptVars {
  contactName: string;
  businessName: string;
  callerName: string;
}

/** Replaces {contactName}, {businessName}, {callerName}; blanks become a readable fallback. */
export function renderScript(script: string, vars: Partial<ScriptVars>): string {
  const fallback: ScriptVars = { contactName: 'there', businessName: 'your business', callerName: 'me' };
  return script.replace(/\{(contactName|businessName|callerName)\}/g, (_m, name: keyof ScriptVars) => {
    const v = vars[name]?.trim();
    return v ? v : fallback[name];
  });
}

/** The placeholder that ships in the default settings. */
export const CALENDLY_PLACEHOLDER = 'https://calendly.com/your-link';

/** True when the admin has set a real http(s) Calendly link (not empty, not the placeholder). */
export function isCalendlyConfigured(url: string | null | undefined): boolean {
  const u = (url ?? '').trim();
  if (!u) return false;
  if (u.replace(/\/+$/, '') === CALENDLY_PLACEHOLDER) return false;
  if (/your-link/i.test(u)) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Loose email check for the inline email field. */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---------------------------------------------------------------------------
// Manual dialing
// ---------------------------------------------------------------------------

/**
 * Formats a US number while it is typed: "2145" -> "(214) 5", "2145550123" -> "(214) 555-0123",
 * "12145550123" / "+1 214..." -> "+1 (214) 555-0123". Anything else (another country, too many
 * digits, letters) is left as typed so the caller can see what they entered.
 */
export function formatPhoneAsTyped(input: string): string {
  const trimmed = input.trimStart();
  if (/[^\d\s().+-]/.test(trimmed)) return input;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && !digits.startsWith('1')) return input;
  let prefix = '';
  if (digits.startsWith('1')) {
    prefix = '+1 ';
    digits = digits.slice(1);
  }
  if (digits.length > 10) return input;
  if (digits.length === 0) return prefix ? '+1' : '';
  let body: string;
  if (digits.length <= 3) body = digits;
  else if (digits.length <= 6) body = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  else body = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return prefix + body;
}

/** Plain sentence for how a manual call ended without anyone connected. */
export function manualEndedText(result: string, phone: string): string {
  switch (result) {
    case 'voicemail':
      return 'Voicemail answered at '+phone;
    case 'busy':
      return `${phone} was busy`;
    case 'bad_number':
      return `${phone} is not a working number`;
    case 'failed':
      return `The call to ${phone} failed`;
    case 'no_answer':
    default:
      return `No answer from ${phone}`;
  }
}

/** Synthetic leads for inbound calls from unknown numbers have ids starting with 'unknown:'. */
export function isUnknownLead(lead: Pick<Lead, 'id'> | null | undefined): boolean {
  return !!lead && lead.id.startsWith('unknown:');
}

/** Whole seconds elapsed since `iso` (0 when missing or in the future). */
export function secondsSince(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 1000));
}
