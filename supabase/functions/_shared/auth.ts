// "Who is calling, and may they do this?" for Edge Functions (Deno).
// Verifies the request's Authorization JWT with a client built from it, then loads the
// caller's profile. Only after that should a function use the service-role client.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './http.ts';

export interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'caller';
  active: boolean;
  created_at: string;
}

export interface Caller {
  userId: string;
  profile: ProfileRow;
  /** Client acting as the caller (RLS applies). */
  userClient: SupabaseClient;
  /** Service-role client (bypasses RLS). Use only after the checks you need. */
  serviceClient: SupabaseClient;
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError('invalid', `Server misconfigured: ${name} is not set.`, 500);
  return v;
}

/** Service-role client from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Signed-in user with an ACTIVE profile, or HttpError(not_authenticated / permission_denied). */
export async function requireActiveUser(req: Request): Promise<Caller> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError('not_authenticated', 'Please sign in.');

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? env('SUPABASE_SERVICE_ROLE_KEY');
  const userClient = createClient(env('SUPABASE_URL'), anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) throw new HttpError('not_authenticated', 'Your session has expired. Please sign in again.');

  const svc = serviceClient();
  const { data: profile, error: pErr } = await svc.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (pErr) throw new HttpError('invalid', pErr.message, 500);
  if (!profile) throw new HttpError('permission_denied', 'Your account has no profile. Ask an admin to add you.');
  if (!profile.active) throw new HttpError('permission_denied', 'This account has been deactivated.');
  return { userId: data.user.id, profile: profile as ProfileRow, userClient, serviceClient: svc };
}

/** Like requireActiveUser, but the profile must also be an admin. */
export async function requireActiveAdmin(req: Request): Promise<Caller> {
  const caller = await requireActiveUser(req);
  if (caller.profile.role !== 'admin') throw new HttpError('permission_denied', 'Only an admin can do that.');
  return caller;
}
