// Shared Deno helpers for the telnyx-* Edge Functions: HTTP/CORS, Supabase auth, the Telnyx REST
// client, dialer config and event emission. Secrets are read from Deno.env and never logged.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { EndReason, TelephonyEventType } from './telnyxLogic.ts';

export const TELNYX_API = 'https://api.telnyx.com/v2';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'error',
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Wraps a handler with CORS preflight and uniform JSON errors ({ error, code }). */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...e.extra }, e.status);
      if (e instanceof TelnyxError) {
        const auth = e.status === 401 || e.status === 403;
        return json(
          { error: auth ? 'Telnyx rejected the API key.' : `Telnyx: ${e.message}`, code: auth ? 'bad_api_key' : 'provider_error' },
          502,
        );
      }
      console.error('Unhandled error:', e instanceof Error ? e.message : String(e));
      return json({ error: 'Internal error.', code: 'internal' }, 500);
    }
  });
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const v = await req.json();
    return (v && typeof v === 'object' ? v : {}) as T;
  } catch {
    return {} as T;
  }
}

// ---------------------------------------------------------------------------
// Env + Supabase
// ---------------------------------------------------------------------------

export function env(name: string): string | null {
  const v = Deno.env.get(name);
  return v && v.trim() ? v.trim() : null;
}

function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new HttpError(500, `Server is missing the ${name} secret.`, 'misconfigured');
  return v;
}

let _admin: SupabaseClient | null = null;
/** Service-role client. Only ever used inside Edge Functions. */
export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

export function webhookUrl(): string {
  return `${requireEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/telnyx-webhook`;
}

export interface AuthedUser {
  id: string;
  role: 'admin' | 'caller';
  active: boolean;
}

/** Verifies the caller's Supabase JWT and that their profile is active (optionally admin). */
export async function requireUser(req: Request, opts: { admin?: boolean } = {}): Promise<AuthedUser> {
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/.test(auth)) throw new HttpError(401, 'Not signed in.', 'not_authenticated');
  const userClient = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(auth.replace(/^Bearer\s+/, ''));
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Sign in again.', 'not_authenticated');
  const { data: profile, error: pErr } = await adminClient()
    .from('profiles')
    .select('id, role, active')
    .eq('id', data.user.id)
    .maybeSingle();
  if (pErr) throw new HttpError(500, 'Could not load your profile.', 'internal');
  if (!profile || !profile.active) throw new HttpError(403, 'Your account is not active.', 'permission_denied');
  if (opts.admin && profile.role !== 'admin') throw new HttpError(403, 'Only an admin can do this.', 'permission_denied');
  return { id: profile.id as string, role: profile.role as 'admin' | 'caller', active: true };
}

// ---------------------------------------------------------------------------
// Telnyx REST
// ---------------------------------------------------------------------------

export class TelnyxError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly codes: string[],
  ) {
    super(message);
  }
}

export function telnyxKeyPresent(): boolean {
  return !!env('TELNYX_API_KEY');
}

/**
 * Calls the Telnyx API. `path` starts with '/'. Returns parsed JSON (or text for text/plain).
 * Throws TelnyxError with Telnyx's own error titles/details (never the key).
 */
export async function telnyx<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const key = env('TELNYX_API_KEY');
  if (!key) throw new HttpError(500, 'The TELNYX_API_KEY secret is not set.', 'misconfigured');
  const res = await fetch(`${TELNYX_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  const payload: unknown = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const errs = (payload as { errors?: { code?: string; title?: string; detail?: string }[] } | null)?.errors ?? [];
    const msg = errs.map((e) => e.detail || e.title).filter(Boolean).join('; ') || `Telnyx request failed (${res.status}).`;
    throw new TelnyxError(res.status, msg, errs.map((e) => String(e.code ?? '')));
  }
  return payload as T;
}

/** Fetches every page of a Telnyx list endpoint (page[number]/page[size]). */
export async function telnyxListAll<T = any>(path: string, query: Record<string, string> = {}, pageSize = 250): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 50; page++) {
    const qs = new URLSearchParams({ ...query, 'page[number]': String(page), 'page[size]': String(pageSize) });
    const res = await telnyx<{ data: T[]; meta?: { total_pages?: number } }>('GET', `${path}?${qs}`);
    out.push(...(res.data ?? []));
    const total = res.meta?.total_pages ?? 1;
    if (page >= total || (res.data ?? []).length === 0) break;
  }
  return out;
}

/** Issues a call command; treats "call already ended" (90018) as success when `ignoreEnded`. */
export async function callCommand(
  callControlId: string,
  action: string,
  body: Record<string, unknown> = {},
  ignoreEnded = true,
): Promise<boolean> {
  try {
    await telnyx('POST', `/calls/${encodeURIComponent(callControlId)}/actions/${action}`, body);
    return true;
  } catch (e) {
    if (ignoreEnded && e instanceof TelnyxError && (e.codes.includes('90018') || e.status === 404)) {
      return false;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Dialer config (telephony_config, written by telnyx-setup)
// ---------------------------------------------------------------------------

export interface TelephonyConfig {
  voice_app_id: string | null;
  voice_app_name: string | null;
  credential_connection_id: string | null;
  credential_connection_name: string | null;
  outbound_voice_profile_id: string | null;
  outbound_voice_profile_name: string | null;
  webhook_url: string | null;
  webhook_public_key: string | null;
}

export async function loadConfig(): Promise<TelephonyConfig | null> {
  const { data, error } = await adminClient().from('telephony_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new HttpError(500, 'Could not read the telephony configuration.', 'internal');
  return (data as TelephonyConfig | null) ?? null;
}

export async function requireConfig(): Promise<TelephonyConfig & { voice_app_id: string; credential_connection_id: string }> {
  const cfg = await loadConfig();
  if (!cfg?.voice_app_id || !cfg.credential_connection_id) {
    throw new HttpError(503, 'Phone calling is not set up yet. An admin must run "Set up Telnyx" first.', 'not_configured');
  }
  return cfg as TelephonyConfig & { voice_app_id: string; credential_connection_id: string };
}

export async function saveConfig(patch: Partial<TelephonyConfig>): Promise<void> {
  const { error } = await adminClient()
    .from('telephony_config')
    .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new HttpError(500, 'Could not save the telephony configuration.', 'internal');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface DialSettings {
  lines_per_caller: number;
  ring_seconds: number;
  skip_voicemail: boolean;
  record_calls: boolean;
  default_daily_cap: number;
  /** Said to iPhone call screeners ('{name}' = the caller's first name); empty = hang up on them. */
  screening_intro: string;
}

export async function loadSettings(): Promise<DialSettings> {
  const { data } = await adminClient().from('settings').select('*').limit(1).maybeSingle();
  const s = (data ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    lines_per_caller: num(s.lines_per_caller, 2),
    ring_seconds: num(s.ring_seconds, 22),
    skip_voicemail: typeof s.skip_voicemail === 'boolean' ? s.skip_voicemail : true,
    record_calls: typeof s.record_calls === 'boolean' ? s.record_calls : false,
    default_daily_cap: num(s.default_daily_cap, 100),
    screening_intro: typeof s.screening_intro === 'string' ? s.screening_intro.trim() : '',
  };
}

// ---------------------------------------------------------------------------
// Events to the app
// ---------------------------------------------------------------------------

export interface EmitInput {
  callerId: string;
  callId: string | null;
  type: TelephonyEventType;
  reason?: EndReason | null;
  from?: string | null;
  to?: string | null;
  message?: string | null;
}

/** Inserts a telephony_events row. Returns false when the (call, type) event already exists. */
export async function emitEvent(e: EmitInput): Promise<boolean> {
  const { error } = await adminClient().from('telephony_events').insert({
    caller_id: e.callerId,
    call_id: e.callId,
    type: e.type,
    reason: e.reason ?? null,
    from_number: e.from ?? null,
    to_number: e.to ?? null,
    message: e.message ?? null,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === '23505') return false;
  throw new HttpError(500, 'Could not record a telephony event.', 'internal');
}

/** The caller's live agent session (with a parked agent leg), or null. */
export async function liveAgentSession(callerId: string): Promise<{ id: string; call_control_id: string } | null> {
  const { data } = await adminClient()
    .from('agent_sessions')
    .select('id, call_control_id')
    .eq('caller_id', callerId)
    .eq('status', 'live')
    .not('call_control_id', 'is', null)
    .order('live_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id as string, call_control_id: data.call_control_id as string } : null;
}
