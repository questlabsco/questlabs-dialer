// Edge Function: admin-users (Deno). Team management that needs the service role.
//
// POST JSON, Authorization: Bearer <user JWT> of an ACTIVE ADMIN.
//   { "action": "create", "email", "fullName", "role": "admin"|"caller", "password" }  -> { "profile": ProfileRow }
//   { "action": "update", "id", "patch": { "fullName"?, "role"?, "active"?, "email"? } } -> { "profile": ProfileRow }
//   { "action": "reset_password", "id", "password" }                                   -> { "ok": true }
// Errors: { "error": { "code": ApiErrorCode, "message" } } with a matching HTTP status.
//
// People sign in with a username; the app sends it as the hidden address `<username>@questlabsco.com`
// (src/lib/login.ts). Nothing here sends mail: accounts are created / re-addressed with
// email_confirm: true, and there is no invite, magic-link or password-recovery path.
//
// A password set here (create / reset_password) is temporary: user_metadata.must_change_password is
// set to true, and the app asks the person to choose their own at the next sign-in (the app clears
// the flag itself via auth.updateUser when they do).
//
// Env (provided automatically by Supabase): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
import { requireActiveAdmin, type ProfileRow } from '../_shared/auth.ts';
import { HttpError, errorResponse, fromPostgres, handleOptions, json } from '../_shared/http.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BAN_FOREVER = '876000h'; // ~100 years

type Role = 'admin' | 'caller';

function asRole(v: unknown): Role {
  if (v === 'admin' || v === 'caller') return v;
  throw new HttpError('invalid', 'Role must be admin or caller.');
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function checkPassword(pw: unknown): string {
  const s = asString(pw);
  if (s.length < 8) throw new HttpError('invalid', 'Password must be at least 8 characters.');
  return s;
}

function checkEmail(v: unknown): string {
  const email = asString(v).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError('invalid', 'Enter a valid username.');
  return email;
}

function isEmailTaken(err: { code?: string; message?: string; status?: number } | null): boolean {
  if (!err) return false;
  return err.code === 'email_exists' || (err.status === 422 && /already|registered|exists/i.test(err.message ?? ''));
}

async function getProfile(svc: SupabaseClient, id: string): Promise<ProfileRow> {
  const { data, error } = await svc.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw fromPostgres(error);
  if (!data) throw new HttpError('not_found', 'User not found.');
  return data as ProfileRow;
}

async function emailInUse(svc: SupabaseClient, email: string, exceptId?: string): Promise<boolean> {
  // Escape LIKE wildcards: usernames may contain '_'.
  let q = svc.from('profiles').select('id').ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`));
  if (exceptId) q = q.neq('id', exceptId);
  const { data, error } = await q.limit(1);
  if (error) throw fromPostgres(error);
  return (data ?? []).length > 0;
}

async function otherActiveAdmins(svc: SupabaseClient, exceptId: string): Promise<number> {
  const { count, error } = await svc
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true)
    .neq('id', exceptId);
  if (error) throw fromPostgres(error);
  return count ?? 0;
}

async function createUser(svc: SupabaseClient, body: Record<string, unknown>): Promise<ProfileRow> {
  const email = checkEmail(body.email);
  const fullName = asString(body.fullName).trim();
  if (!fullName) throw new HttpError('invalid', 'Name is required.');
  const role = asRole(body.role);
  const password = checkPassword(body.password);
  if (await emailInUse(svc, email)) throw new HttpError('conflict', 'That username is taken.');

  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, must_change_password: true },
    app_metadata: { role },
  });
  if (error || !data?.user) {
    if (isEmailTaken(error)) throw new HttpError('conflict', 'That username is taken.');
    throw new HttpError('invalid', error?.message ?? 'Could not create the user.');
  }

  // The auth trigger usually created the profile already; make sure it is exactly right.
  const { data: profile, error: pErr } = await svc
    .from('profiles')
    .upsert({ id: data.user.id, email, full_name: fullName, role, active: true }, { onConflict: 'id' })
    .select('*')
    .single();
  if (pErr || !profile) {
    await svc.auth.admin.deleteUser(data.user.id).catch(() => undefined);
    throw fromPostgres(pErr, 'Could not create the profile.');
  }
  return profile as ProfileRow;
}

async function updateUser(svc: SupabaseClient, me: ProfileRow, body: Record<string, unknown>): Promise<ProfileRow> {
  const id = asString(body.id);
  if (!id) throw new HttpError('invalid', 'User id is required.');
  const patch = (body.patch ?? {}) as Record<string, unknown>;
  const target = await getProfile(svc, id);

  const next: Partial<ProfileRow> = {};
  if (patch.fullName !== undefined) {
    const n = asString(patch.fullName).trim();
    if (!n) throw new HttpError('invalid', 'Name is required.');
    next.full_name = n;
  }
  if (patch.role !== undefined) next.role = asRole(patch.role);
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw new HttpError('invalid', 'Active must be true or false.');
    next.active = patch.active;
  }
  if (patch.email !== undefined) next.email = checkEmail(patch.email);

  const demoting = next.role !== undefined && next.role !== 'admin';
  const deactivating = next.active === false;
  if (id === me.id && (demoting || deactivating)) {
    throw new HttpError('invalid', 'You cannot deactivate or demote yourself.');
  }
  if (target.role === 'admin' && target.active && (demoting || deactivating) && (await otherActiveAdmins(svc, id)) === 0) {
    throw new HttpError('invalid', 'You cannot deactivate or demote the last active admin.');
  }

  // Login (username -> internal address) first: it is the change most likely to be refused by Auth.
  // email_confirm: true, so Auth never sends a confirmation email.
  if (next.email !== undefined && next.email !== target.email) {
    if (await emailInUse(svc, next.email, id)) throw new HttpError('conflict', 'That username is taken.');
    const { error } = await svc.auth.admin.updateUserById(id, { email: next.email, email_confirm: true });
    if (error) {
      if (isEmailTaken(error)) throw new HttpError('conflict', 'That username is taken.');
      throw new HttpError('invalid', error.message);
    }
  }
  if (next.full_name !== undefined) {
    await svc.auth.admin.updateUserById(id, { user_metadata: { full_name: next.full_name } }).catch(() => undefined);
  }

  let profile = target;
  if (Object.keys(next).length > 0) {
    const { data, error } = await svc.from('profiles').update(next).eq('id', id).select('*').single();
    if (error || !data) throw fromPostgres(error, 'Could not update the user.');
    profile = data as ProfileRow;
  }

  // Ban / unban in Auth so a deactivated user cannot sign in or refresh a session.
  if (next.active !== undefined && next.active !== target.active) {
    const { error } = await svc.auth.admin.updateUserById(id, { ban_duration: next.active ? 'none' : BAN_FOREVER });
    if (error) {
      await svc.from('profiles').update({ active: target.active }).eq('id', id);
      throw new HttpError('invalid', `Could not ${next.active ? 'reactivate' : 'deactivate'} the user: ${error.message}`, 500);
    }
  }

  // Deactivated or no longer a caller: release their locks and mark them offline.
  // Their assigned leads stay assigned.
  if (!profile.active || profile.role !== 'caller') {
    await svc.from('leads').update({ locked_by: null, locked_at: null }).eq('locked_by', id);
    await svc.from('presence').update({ status: 'offline', detail: null, since: new Date().toISOString() }).eq('caller_id', id);
  }
  return profile;
}

async function resetPassword(svc: SupabaseClient, body: Record<string, unknown>): Promise<void> {
  const id = asString(body.id);
  if (!id) throw new HttpError('invalid', 'User id is required.');
  await getProfile(svc, id);
  const password = checkPassword(body.password);
  // Merge into the existing metadata (full_name etc.) rather than replacing it.
  const { data: current, error: getErr } = await svc.auth.admin.getUserById(id);
  if (getErr || !current?.user) throw new HttpError('not_found', 'User not found.');
  const user_metadata = { ...(current.user.user_metadata ?? {}), must_change_password: true };
  const { error } = await svc.auth.admin.updateUserById(id, { password, user_metadata });
  if (error) throw new HttpError('invalid', error.message);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new HttpError('invalid', 'Use POST.', 405);
    const { profile: me, serviceClient: svc } = await requireActiveAdmin(req);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw new HttpError('invalid', 'Request body must be JSON.');
    }
    switch (body.action) {
      case 'create':
        return json({ profile: await createUser(svc, body) });
      case 'update':
        return json({ profile: await updateUser(svc, me, body) });
      case 'reset_password':
        await resetPassword(svc, body);
        return json({ ok: true });
      default:
        throw new HttpError('invalid', 'Unknown action.');
    }
  } catch (e) {
    return errorResponse(e);
  }
});
