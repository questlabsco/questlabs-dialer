/**
 * Pure logic for the "Phone setup" section of the Numbers screen: server responses -> what the
 * admin sees, in plain English. No React, no network (unit-tested in node).
 */
import type { StatusItem, TelnyxSetupResult, TelnyxStatusResult, TelnyxSyncResult } from '../../../telephony/telnyxAdmin';

// ---------------------------------------------------------------------------
// Errors from the phone functions
// ---------------------------------------------------------------------------

export type PhoneErrorKind =
  | 'server_off'
  | 'missing_key'
  | 'bad_key'
  | 'not_configured'
  | 'in_use_elsewhere'
  | 'not_admin'
  | 'signed_out'
  | 'other';

/**
 * The client wrappers only pass on the function's `error` text (not its `code`), so classify by
 * the messages the functions and supabase-js are known to produce.
 */
export function classifyPhoneError(message: string): PhoneErrorKind {
  const m = message || '';
  // supabase-js: FunctionsFetchError / FunctionsRelayError / FunctionsHttpError without our JSON body
  // (a function that is not deployed answers 404 {"code":"NOT_FOUND",...}, which has no `error`).
  if (
    /Failed to send a request to the Edge Function|Relay Error invoking the Edge Function|Edge Function returned a non-2xx|Requested function was not found|Failed to fetch|NetworkError|fetch failed|Load failed/i.test(
      m,
    )
  )
    return 'server_off';
  if (/TELNYX_API_KEY secret (is not set|for this Supabase project first)/i.test(m)) return 'missing_key';
  if (/Telnyx rejected the API key/i.test(m)) return 'bad_key';
  if (/not set up yet/i.test(m)) return 'not_configured';
  if (/is in use by "/i.test(m)) return 'in_use_elsewhere';
  if (/Only an admin/i.test(m)) return 'not_admin';
  if (/Not signed in|session has expired/i.test(m)) return 'signed_out';
  return 'other';
}

/** The app name inside an in_use_elsewhere message: `+1214... is in use by "Vapi". It was not changed.` */
export function inUseAppName(message: string): string | null {
  const m = /is in use by "([^"]*)"/.exec(message);
  return m && m[1] ? m[1] : null;
}

/** One plain sentence for an error from any phone function. */
export function plainPhoneError(message: string): string {
  switch (classifyPhoneError(message)) {
    case 'server_off':
      return "The server side of phone setup isn't switched on yet, or the app can't reach it.";
    case 'missing_key':
      return 'No Telnyx API key has been saved in Supabase yet.';
    case 'bad_key':
      return "Telnyx didn't accept the API key saved in Supabase.";
    case 'not_configured':
      return 'Telnyx is not set up yet. Click Set up Telnyx first.';
    case 'in_use_elsewhere': {
      const app = inUseAppName(message);
      return `Not changed: this number is being used by ${app ? `"${app}"` : 'another app'}. The dialer never takes numbers from other apps.`;
    }
    case 'not_admin':
      return 'Only an admin can do this.';
    case 'signed_out':
      return 'Your session has expired. Sign out and sign in again.';
    default:
      return message || 'Something went wrong.';
  }
}

// ---------------------------------------------------------------------------
// Status checklist -> view model
// ---------------------------------------------------------------------------

export type SetupStage =
  /** Phone functions not deployed or unreachable. */
  | 'server_off'
  /** No TELNYX_API_KEY secret. */
  | 'no_key'
  /** Telnyx rejected the key. */
  | 'bad_key'
  /** Key works, but "Set up Telnyx" has never been run (no app, no connection). */
  | 'needs_setup'
  /** Some checks fail. */
  | 'partial'
  /** Every check passes. */
  | 'ok'
  /** Some other error from the status call. */
  | 'error';

export interface ChecklistRow {
  key: string;
  label: string;
  /** Explanation for the "i" tooltip, or null. */
  tip: string | null;
  ok: boolean;
  detail: string;
  /** What to do, shown only for failing rows. */
  hint: string | null;
  /** The server's original wording, for the row's tooltip. */
  technical: string;
}

const SETUP_FIX = 'Click Set up Telnyx to fix this.';

interface Copy {
  label: string;
  tip: string | null;
  ok?: string;
  fail?: string;
  hint?: string;
}

const UPDATES_TIP =
  'Telnyx tells the dialer what happens on each call (ringing, answered, hung up) by sending updates to an address on your Supabase server. This checks the address is right.';
const PROFILE_TIP = 'An outbound profile is the Telnyx setting that allows calls out to US and Canadian numbers.';

const COPY: Record<string, Copy> = {
  api_key: {
    label: 'Telnyx API key',
    tip: 'The key that lets the dialer use your Telnyx account. It is saved on your Supabase server, never in this app.',
    ok: 'Saved and accepted by Telnyx.',
  },
  voice_app: {
    label: 'Calling app',
    tip: 'A Telnyx "Voice API app" that belongs only to the dialer. It places the calls. Other apps on your account (such as Vapi) are left alone.',
    fail: 'Not created yet.',
    hint: SETUP_FIX,
  },
  voice_app_webhook: {
    label: 'Call updates (calling app)',
    tip: UPDATES_TIP,
    ok: 'Sent to this dialer.',
    fail: "Sent to the wrong address, so the dialer can't see calls ring or get answered.",
    hint: SETUP_FIX,
  },
  voice_app_profile: {
    label: 'Outbound calling (calling app)',
    tip: PROFILE_TIP,
    fail: 'Not allowed to call out yet.',
    hint: SETUP_FIX,
  },
  webrtc_connection: {
    label: 'Headset line',
    tip: "The connection each caller's computer uses to talk and listen through the app (Telnyx calls it a credential connection).",
    fail: 'Not created yet.',
    hint: SETUP_FIX,
  },
  webrtc_webhook: {
    label: 'Call updates (headset line)',
    tip: UPDATES_TIP,
    ok: 'Sent to this dialer.',
    fail: "Sent to the wrong address, so callers' lines won't connect.",
    hint: SETUP_FIX,
  },
  webrtc_parking: {
    label: 'Hold callers on the line',
    tip: "Keeps each caller's audio line open between calls so a lead who answers is connected straight away (Telnyx calls this call parking).",
    ok: 'On.',
    fail: "Off, so callers can't be connected to the people who answer.",
    hint: SETUP_FIX,
  },
  webrtc_profile: {
    label: 'Outbound calling (headset line)',
    tip: PROFILE_TIP,
    ok: 'Allowed.',
    fail: 'Not allowed to call out yet.',
    hint: SETUP_FIX,
  },
  webhook_public_key: {
    label: 'Security key for call updates',
    tip: 'A public key from Telnyx that lets the dialer check call updates really come from Telnyx.',
    ok: 'Saved. Call updates are checked.',
    fail: 'Missing, so call updates are refused.',
    hint: 'Click Set up Telnyx again. If it is still missing, copy the public key from the Telnyx portal (Account > Public Key) into Supabase as a secret named TELNYX_PUBLIC_KEY.',
  },
  numbers: {
    label: 'Phone numbers for the dialer',
    tip: 'Numbers on your Telnyx account that the dialer calls from. Numbers used by other apps are never taken.',
    fail: 'No numbers on the dialer yet.',
    hint: 'Buy a local number on Telnyx (the app never buys numbers), then click Sync from Telnyx and Use for dialer.',
  },
};

/** Generic clean-up of server wording for rows the app has no copy for. */
export function plainText(text: string): string {
  return text
    .replace(/Press "Set up Telnyx" \(runs telnyx-setup\) to fix this automatically\./g, SETUP_FIX)
    .replace(/\s*\(runs telnyx-setup\)/g, '')
    .replace(/\btelnyx-[a-z-]+\b/g, 'the phone setup')
    .replace(/\bwebhooks?\b/gi, 'call updates')
    .replace(/\bWebRTC\b/g, 'headset line');
}

export function checklistRows(items: StatusItem[]): ChecklistRow[] {
  return items.map((it) => {
    const c = COPY[it.key];
    const technical = [it.detail, it.hint].filter(Boolean).join(' ');
    if (!c) {
      return { key: it.key, label: plainText(it.label), tip: null, ok: it.ok, detail: plainText(it.detail), hint: it.ok || !it.hint ? null : plainText(it.hint), technical };
    }
    // Passing details without our own copy are plain already ('Found "Quest Labs Dialer - WebRTC".'),
    // and must keep the real Telnyx names untouched.
    let detail = it.ok ? c.ok ?? it.detail : c.fail ?? plainText(it.detail);
    let hint = it.ok ? null : c.hint ?? (it.hint ? plainText(it.hint) : null);
    if (it.key === 'api_key' && !it.ok) {
      const missing = /No API key/i.test(it.detail);
      detail = missing ? 'Not saved in Supabase yet.' : 'Saved, but Telnyx rejected it.';
      hint = missing
        ? 'Create an API key in Telnyx and save it in Supabase as a secret named TELNYX_API_KEY.'
        : 'Create a new API key in Telnyx and replace the TELNYX_API_KEY secret in Supabase.';
    }
    if (it.key === 'voice_app_profile' && it.ok) {
      const name = /\((.*)\)\.?$/.exec(it.detail)?.[1];
      detail = name ? `Allowed (profile "${name}").` : 'Allowed.';
    }
    return { key: it.key, label: c.label, tip: c.tip, ok: it.ok, detail, hint, technical };
  });
}

export interface SetupView {
  stage: SetupStage;
  rows: ChecklistRow[];
  passed: number;
  failed: number;
  /** One line for the top of the section. */
  summary: string;
  /** Set up Telnyx can help in this stage. */
  canRunSetup: boolean;
  /** Everything OK: the section collapses to one line. */
  collapsible: boolean;
}

export function statusStage(s: TelnyxStatusResult): SetupStage {
  const key = s.items.find((i) => i.key === 'api_key');
  if (key && !key.ok) return /No API key/i.test(key.detail) ? 'no_key' : 'bad_key';
  if (s.ok && s.items.every((i) => i.ok)) return 'ok';
  const app = s.items.find((i) => i.key === 'voice_app');
  const conn = s.items.find((i) => i.key === 'webrtc_connection');
  if (app && !app.ok && conn && !conn.ok) return 'needs_setup';
  return 'partial';
}

export function statusView(s: TelnyxStatusResult): SetupView {
  const stage = statusStage(s);
  const rows = checklistRows(s.items);
  const passed = rows.filter((r) => r.ok).length;
  const failed = rows.length - passed;
  const onlyNumbers = failed === 1 && rows.some((r) => r.key === 'numbers' && !r.ok);
  const summary =
    stage === 'no_key'
      ? 'Not connected to Telnyx yet.'
      : stage === 'bad_key'
        ? "Telnyx didn't accept the API key."
        : stage === 'needs_setup'
          ? 'Connected to Telnyx. Click Set up Telnyx to finish.'
          : stage === 'ok'
            ? 'All checks passed.'
            : onlyNumbers
              ? 'Set up done, but no phone numbers on the dialer yet.'
              : `${failed} of ${rows.length} checks need fixing.`;
  return {
    stage,
    rows,
    passed,
    failed,
    summary,
    canRunSetup: stage !== 'no_key' && stage !== 'bad_key',
    collapsible: stage === 'ok',
  };
}

/** The view when the status call itself failed. */
export function statusErrorView(message: string): SetupView {
  const kind = classifyPhoneError(message);
  const stage: SetupStage = kind === 'server_off' ? 'server_off' : kind === 'missing_key' ? 'no_key' : kind === 'bad_key' ? 'bad_key' : 'error';
  return {
    stage,
    rows: [],
    passed: 0,
    failed: 0,
    summary: stage === 'error' ? plainPhoneError(message) : stage === 'server_off' ? "The server side isn't switched on yet." : stage === 'no_key' ? 'Not connected to Telnyx yet.' : "Telnyx didn't accept the API key.",
    canRunSetup: false,
    collapsible: false,
  };
}

// ---------------------------------------------------------------------------
// Simultaneous calls
// ---------------------------------------------------------------------------

/**
 * Most calls the team can have open at once: each caller holds 1 line for their own audio plus up
 * to linesPerCaller + 1 ringing (a ring-twice retry can start before the last line clears).
 */
export function neededLines(activeCallers: number, linesPerCaller: number): number {
  const callers = Math.max(0, Math.floor(activeCallers || 0));
  const lines = Math.max(1, Math.min(10, Math.floor(linesPerCaller || 1)));
  return callers * (1 + lines + 1);
}

export interface LimitView {
  /** 'ok' enough, 'low' not enough, 'unknown' Telnyx doesn't report it. */
  state: 'ok' | 'low' | 'unknown';
  value: string;
  text: string;
}

const RAISE = 'To raise it, ask Telnyx support.';

export function limitView(limit: number | null, activeCallers: number, linesPerCaller: number): LimitView {
  const need = neededLines(activeCallers, linesPerCaller);
  const lines = Math.max(1, Math.min(10, Math.floor(linesPerCaller || 1)));
  const callers = `${activeCallers} active ${activeCallers === 1 ? 'caller' : 'callers'}`;
  const needText =
    activeCallers > 0
      ? `${callers} on ${lines} ${lines === 1 ? 'line' : 'lines'} each need up to ${need} at once (1 per caller plus up to ${lines + 1} ringing).`
      : `Each caller needs up to ${1 + lines + 1} at once (1 for themselves plus up to ${lines + 1} ringing).`;
  if (limit === null) {
    return { state: 'unknown', value: 'Not shown by Telnyx', text: `${needText} Ask Telnyx support what your account's limit is, and to raise it if needed.` };
  }
  if (activeCallers > 0 && limit < need) {
    return { state: 'low', value: String(limit), text: `Too low: ${needText} Ask Telnyx support to raise it to at least ${need}.` };
  }
  return { state: 'ok', value: String(limit), text: `Enough. ${needText} ${RAISE}` };
}

// ---------------------------------------------------------------------------
// Set up result
// ---------------------------------------------------------------------------

/** 'Voice API application "Quest Labs Dialer - Voice App"' -> 'Calling app "Quest Labs Dialer - Voice App"'. */
export function plainResource(label: string): string {
  return label
    .replace(/^Voice API application/, 'Calling app')
    .replace(/^WebRTC credential connection/, 'Headset line')
    .replace(/^Outbound voice profile/, 'Outbound calling profile');
}

export function plainWarning(w: string): string {
  if (/^The WebRTC connection changed/.test(w)) return 'The headset line changed. Callers are signed in to it again automatically the next time they press Start.';
  if (/did not return a webhook public key/.test(w)) return 'Telnyx did not send the security key for call updates. Click Set up Telnyx again later.';
  if (/Could not read the webhook public key/.test(w))
    return "Couldn't get the security key for call updates from Telnyx. Copy it from the Telnyx portal (Account > Public Key) into Supabase as a secret named TELNYX_PUBLIC_KEY.";
  return plainText(w);
}

export interface SetupResultView {
  tone: 'good' | 'warning';
  title: string;
  groups: { label: string; items: string[] }[];
  warnings: string[];
}

export function setupResultView(r: TelnyxSetupResult): SetupResultView {
  const groups = [
    { label: 'Created', items: r.created.map(plainResource) },
    { label: 'Fixed', items: r.updated.map(plainResource) },
    { label: 'Already there', items: r.reused.map(plainResource) },
  ].filter((g) => g.items.length > 0);
  const warnings = r.warnings.map(plainWarning);
  const nothingNew = r.created.length === 0 && r.updated.length === 0;
  return {
    tone: r.ok && warnings.length === 0 ? 'good' : 'warning',
    title: !r.ok ? 'Set up finished with problems.' : nothingNew ? 'Set up checked: nothing needed changing.' : 'Set up done.',
    groups,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Numbers on the Telnyx account (sync result)
// ---------------------------------------------------------------------------

export interface AccountNumber {
  number: string;
  providerId: string;
}
export interface ElsewhereNumber extends AccountNumber {
  /** Name of the app or connection using it, e.g. "Vapi". */
  app: string;
}
export interface NumberGroups {
  dialer: AccountNumber[];
  unused: AccountNumber[];
  elsewhere: ElsewhereNumber[];
}

const byNumber = <T extends { number: string }>(a: T, b: T) => a.number.localeCompare(b.number);

export function groupNumbers(r: TelnyxSyncResult): NumberGroups {
  return {
    dialer: r.dialer.map((n) => ({ number: n.number, providerId: n.providerId })).sort(byNumber),
    unused: r.unassigned.map((n) => ({ number: n.number, providerId: n.providerId })).sort(byNumber),
    elsewhere: r.inUseElsewhere
      .map((n) => ({ number: n.number, providerId: n.providerId, app: n.connectionName?.trim() || 'another app' }))
      .sort(byNumber),
  };
}

/** Moves a number from "Not used yet" to "On the dialer" after a successful assign. */
export function markAssigned(g: NumberGroups, providerId: string): NumberGroups {
  const n = g.unused.find((x) => x.providerId === providerId);
  if (!n) return g;
  return { ...g, unused: g.unused.filter((x) => x.providerId !== providerId), dialer: [...g.dialer, n].sort(byNumber) };
}

/** Hint from the status counts before any sync, or null when there is nothing else on the account. */
export function otherNumbersText(n: { unassigned: number; inUseElsewhere: number } | null): string | null {
  if (!n || (n.unassigned <= 0 && n.inUseElsewhere <= 0)) return null;
  const parts: string[] = [];
  if (n.unassigned > 0) parts.push(`${n.unassigned} ${n.unassigned === 1 ? 'number' : 'numbers'} not used yet`);
  if (n.inUseElsewhere > 0) parts.push(`${n.inUseElsewhere} ${n.inUseElsewhere === 1 ? 'number' : 'numbers'} used by other apps`);
  return `Your Telnyx account also has ${parts.join(' and ')}. Click Sync from Telnyx to see them.`;
}

/** Toast after a sync. */
export function syncSummary(r: TelnyxSyncResult): string {
  const parts: string[] = [];
  if (r.imported) parts.push(`added ${r.imported} ${r.imported === 1 ? 'number' : 'numbers'}`);
  if (r.updated) parts.push(`linked ${r.updated} to Telnyx`);
  if (r.deactivated) parts.push(`turned off ${r.deactivated} no longer on the dialer`);
  if (parts.length === 0) return 'Numbers are up to date.';
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const TELNYX_API_KEYS_URL = 'https://portal.telnyx.com/#/api-keys';
export const TELNYX_BUY_NUMBERS_URL = 'https://portal.telnyx.com/#/numbers/buy-numbers';

/** Supabase dashboard page for Edge Function secrets of the project behind `supabaseUrl`. */
export function supabaseSecretsUrl(supabaseUrl: string | undefined | null): string {
  const m = /^https:\/\/([a-z0-9]{10,40})\.supabase\.co\/?$/i.exec((supabaseUrl ?? '').trim());
  return m ? `https://supabase.com/dashboard/project/${m[1].toLowerCase()}/functions/secrets` : 'https://supabase.com/dashboard/projects';
}
