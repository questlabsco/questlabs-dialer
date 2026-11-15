/**
 * Translates PostgREST / Postgres / Auth / Edge Function errors into `ApiError`.
 * Pure (no network) so it can be unit-tested.
 *
 * The SQL in `supabase/migrations/0001_core.sql` raises custom SQLSTATEs:
 *   QL401 not_authenticated, QL403 permission_denied, QL404 not_found,
 *   QL400 invalid, QL409 conflict, QL423 account deactivated (-> permission_denied + sign out).
 */
import { ApiError, type ApiErrorCode } from './Api';
import { PASSWORD_MESSAGES } from '../lib/password';

export type MessageOverrides = Partial<Record<ApiErrorCode, string>>;

const API_CODES: readonly ApiErrorCode[] = ['not_authenticated', 'permission_denied', 'not_found', 'invalid', 'conflict', 'not_implemented'];

export const NETWORK_MESSAGE = 'Could not reach the server. Check your internet connection and try again.';
export const DEACTIVATED_MESSAGE = 'This account has been deactivated.';

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  status?: unknown;
  details?: unknown;
}

function asErrorLike(e: unknown): ErrorLike | null {
  return e && typeof e === 'object' ? (e as ErrorLike) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isApiCode(v: unknown): v is ApiErrorCode {
  return typeof v === 'string' && (API_CODES as readonly string[]).includes(v);
}

/** Our own SQLSTATEs: the message was written for users, keep it. */
function fromCustomSqlState(code: string, message: string): ApiError | null {
  switch (code) {
    case 'QL401':
      return new ApiError('not_authenticated', message || 'Please sign in.');
    case 'QL403':
      return new ApiError('permission_denied', message || 'You do not have permission to do that.');
    case 'QL423':
      return new ApiError('permission_denied', message || DEACTIVATED_MESSAGE);
    case 'QL404':
      return new ApiError('not_found', message || 'Not found.');
    case 'QL400':
      return new ApiError('invalid', message || 'Invalid request.');
    case 'QL409':
      return new ApiError('conflict', message || 'That conflicts with existing data.');
    default:
      return null;
  }
}

/** Standard Postgres / PostgREST codes -> [ApiErrorCode, generic message]. */
function fromStandardCode(code: string): [ApiErrorCode, string] | null {
  switch (code) {
    case '42501':
      return ['permission_denied', 'You do not have permission to do that.'];
    case '23505':
      return ['conflict', 'A record with that value already exists.'];
    case '23503':
      return ['not_found', 'A linked record was not found.'];
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22008':
    case '22023':
    case '22003':
    case 'P0001':
      return ['invalid', 'Some of the values are not valid.'];
    case 'PGRST116':
      return ['not_found', 'Not found.'];
    case 'PGRST301':
    case 'PGRST302':
    case 'PGRST303':
      return ['not_authenticated', 'Your session has expired. Please sign in again.'];
    case 'PGRST202':
    case '42883':
    case '42P01':
      return ['not_implemented', 'The database is not set up yet (run supabase/migrations/0001_core.sql).'];
    default:
      return null;
  }
}

/** Supabase Auth (GoTrue) error codes. */
function fromAuth(code: string, status: number, message: string): ApiError | null {
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return new ApiError('invalid', 'Wrong username or password.');
  }
  if (code === 'user_banned' || /banned/i.test(message)) return new ApiError('permission_denied', DEACTIVATED_MESSAGE);
  if (code === 'email_not_confirmed') return new ApiError('permission_denied', 'This account is not ready to sign in yet. Ask your admin to set it up again.');
  if (code === 'user_not_found') return new ApiError('not_found', 'User not found.');
  if (code === 'email_exists' || code === 'user_already_exists') return new ApiError('conflict', 'That username is taken.');
  if (code === 'weak_password') return new ApiError('invalid', message || 'Password is too weak.');
  if (code === 'over_request_rate_limit' || status === 429) return new ApiError('invalid', 'Too many attempts. Wait a minute and try again.');
  if (['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'no_authorization'].includes(code)) {
    return new ApiError('not_authenticated', 'Your session has expired. Please sign in again.');
  }
  return null;
}

/**
 * Any thrown / returned error -> ApiError. `overrides` replaces the generic message for a code
 * (never the message of one of our own QL* errors, which is already user-facing).
 */
export function translateError(e: unknown, overrides: MessageOverrides = {}): ApiError {
  if (e instanceof ApiError) return e;
  const x = asErrorLike(e);
  if (!x) return new ApiError('invalid', String(e ?? 'Unknown error.'));

  const name = str(x.name);
  const code = str(x.code);
  const message = str(x.message);
  const status = typeof x.status === 'number' ? x.status : 0;

  const custom = fromCustomSqlState(code, message);
  if (custom) return custom;

  const std = fromStandardCode(code);
  if (std) return new ApiError(std[0], overrides[std[0]] ?? std[1]);

  if (name.startsWith('Auth') || name === 'AuthApiError' || name === 'AuthRetryableFetchError') {
    if (name === 'AuthRetryableFetchError') return new ApiError('invalid', NETWORK_MESSAGE);
    const a = fromAuth(code, status, message);
    if (a) return a;
    if (name === 'AuthSessionMissingError') return new ApiError('not_authenticated', 'Please sign in.');
    return new ApiError('invalid', message || 'Authentication failed.');
  }

  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError') return new ApiError('invalid', NETWORK_MESSAGE);

  if (name === 'TypeError' && /fetch|network|load failed/i.test(message)) return new ApiError('invalid', NETWORK_MESSAGE);
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return new ApiError('invalid', NETWORK_MESSAGE);

  if (status === 401) return new ApiError('not_authenticated', 'Please sign in.');
  if (status === 403) return new ApiError('permission_denied', overrides.permission_denied ?? 'You do not have permission to do that.');
  if (status === 404) return new ApiError('not_found', overrides.not_found ?? 'Not found.');
  if (status === 409) return new ApiError('conflict', overrides.conflict ?? 'That conflicts with existing data.');

  return new ApiError('invalid', message || 'Something went wrong.');
}

/**
 * Error body of one of our Edge Functions ({ error: { code, message } }) plus its HTTP status.
 * A 404 without our body means the function is not deployed.
 */
export function translateFunctionResponse(fn: string, status: number, body: unknown): ApiError {
  const outer = asErrorLike(body) as (ErrorLike & { error?: unknown }) | null;
  const err = outer && outer.error !== undefined ? asErrorLike(outer.error) : outer;
  const code = err?.code;
  const message = str(err?.message);
  if (isApiCode(code)) return new ApiError(code, message || 'Request failed.');
  if (status === 404) return new ApiError('not_implemented', `The "${fn}" server function is not deployed.`);
  if (status === 401) return new ApiError('not_authenticated', 'Your session has expired. Please sign in again.');
  if (status === 403) return new ApiError('permission_denied', message || 'You do not have permission to do that.');
  if (status === 409) return new ApiError('conflict', message || 'That conflicts with existing data.');
  return new ApiError('invalid', message || `The "${fn}" server function failed (HTTP ${status || 'error'}).`);
}

/** True when the error means the account is deactivated (the client should sign out). */
export function isDeactivationError(e: unknown): boolean {
  const x = asErrorLike(e);
  if (!x) return false;
  const code = str(x.code);
  return code === 'QL423' || code === 'user_banned';
}

/**
 * Errors from changing my own password: re-authenticating with the current password
 * (`signInWithPassword`) and then `auth.updateUser({ password })`.
 */
export function translatePasswordChangeError(e: unknown, step: 'verify' | 'update'): ApiError {
  if (e instanceof ApiError) return e;
  const x = asErrorLike(e);
  const code = str(x?.code);
  const message = str(x?.message);
  if (step === 'verify' && (code === 'invalid_credentials' || /invalid login credentials/i.test(message))) {
    return new ApiError('invalid', PASSWORD_MESSAGES.currentWrong);
  }
  if (code === 'same_password' || /different from the old password/i.test(message)) return new ApiError('invalid', PASSWORD_MESSAGES.sameAsCurrent);
  if (code === 'weak_password') return new ApiError('invalid', message || 'Password is too weak.');
  if (code === 'reauthentication_needed' || code === 'reauthentication_not_valid') {
    return new ApiError('invalid', 'Sign out, sign in again, then change your password.');
  }
  return translateError(e);
}

/** The must-change flag in a Supabase Auth user's metadata (set by the admin-users Edge Function). */
export function mustChangeFromUser(user: { user_metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  return user?.user_metadata?.must_change_password === true;
}
