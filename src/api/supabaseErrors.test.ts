import { describe, expect, it } from 'vitest';
import { ApiError } from './Api';
import {
  DEACTIVATED_MESSAGE,
  NETWORK_MESSAGE,
  isDeactivationError,
  mustChangeFromUser,
  translateError,
  translateFunctionResponse,
  translatePasswordChangeError,
} from './supabaseErrors';

const pg = (code: string, message = 'raw db message') => ({ code, message, details: null, hint: null });

describe('translateError: our SQLSTATEs keep their message', () => {
  it.each([
    ['QL401', 'not_authenticated'],
    ['QL403', 'permission_denied'],
    ['QL423', 'permission_denied'],
    ['QL404', 'not_found'],
    ['QL400', 'invalid'],
    ['QL409', 'conflict'],
  ])('%s -> %s', (code, expected) => {
    const e = translateError(pg(code, 'Lead not found.'), { not_found: 'override ignored' });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe(expected);
    expect(e.message).toBe('Lead not found.');
  });
});

describe('translateError: standard Postgres / PostgREST codes', () => {
  it.each([
    ['42501', 'permission_denied'],
    ['23505', 'conflict'],
    ['23503', 'not_found'],
    ['23514', 'invalid'],
    ['22P02', 'invalid'],
    ['PGRST116', 'not_found'],
    ['PGRST301', 'not_authenticated'],
    ['PGRST202', 'not_implemented'],
  ])('%s -> %s with a friendly message', (code, expected) => {
    const e = translateError(pg(code));
    expect(e.code).toBe(expected);
    expect(e.message).not.toBe('raw db message');
  });

  it('applies overrides to generic codes', () => {
    expect(translateError(pg('23505'), { conflict: 'That number is already added.' }).message).toBe('That number is already added.');
  });
});

describe('translateError: auth, network, misc', () => {
  it('maps auth errors', () => {
    expect(translateError({ name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' })).toMatchObject({
      code: 'invalid',
      message: 'Wrong username or password.',
    });
    expect(translateError({ name: 'AuthApiError', status: 400, message: 'Invalid login credentials' }).message).toBe('Wrong username or password.');
    expect(translateError({ name: 'AuthApiError', status: 422, code: 'email_exists', message: 'x' })).toMatchObject({ code: 'conflict', message: 'That username is taken.' });
    expect(translateError({ name: 'AuthApiError', status: 400, code: 'user_banned', message: 'User is banned' })).toMatchObject({
      code: 'permission_denied',
      message: DEACTIVATED_MESSAGE,
    });
    expect(translateError({ name: 'AuthApiError', status: 403, code: 'session_not_found', message: 'x' }).code).toBe('not_authenticated');
    expect(translateError({ name: 'AuthSessionMissingError', message: 'Auth session missing!' }).code).toBe('not_authenticated');
    expect(translateError({ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }).message).toBe(NETWORK_MESSAGE);
  });

  it('maps network failures', () => {
    expect(translateError(new TypeError('Failed to fetch')).message).toBe(NETWORK_MESSAGE);
    expect(translateError({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' }).message).toBe(NETWORK_MESSAGE);
  });

  it('passes ApiError through and wraps anything else', () => {
    const a = new ApiError('conflict', 'x');
    expect(translateError(a)).toBe(a);
    expect(translateError('boom')).toMatchObject({ code: 'invalid', message: 'boom' });
    expect(translateError(new Error('odd'))).toMatchObject({ code: 'invalid', message: 'odd' });
    expect(translateError({ status: 404, message: 'nope' }).code).toBe('not_found');
  });

  it('detects deactivation', () => {
    expect(isDeactivationError(pg('QL423'))).toBe(true);
    expect(isDeactivationError({ code: 'user_banned' })).toBe(true);
    expect(isDeactivationError(pg('QL403'))).toBe(false);
    expect(isDeactivationError(null)).toBe(false);
  });
});

describe('translateFunctionResponse', () => {
  it('uses our error body', () => {
    expect(translateFunctionResponse('admin-users', 409, { error: { code: 'conflict', message: 'That username is taken.' } })).toMatchObject({
      code: 'conflict',
      message: 'That username is taken.',
    });
    expect(translateFunctionResponse('admin-users', 400, { code: 'invalid', message: 'Bad' })).toMatchObject({ code: 'invalid', message: 'Bad' });
  });

  it('falls back to the HTTP status', () => {
    expect(translateFunctionResponse('telnyx-token', 404, null).code).toBe('not_implemented');
    expect(translateFunctionResponse('admin-users', 401, { msg: 'Invalid JWT' }).code).toBe('not_authenticated');
    expect(translateFunctionResponse('admin-users', 403, null).code).toBe('permission_denied');
    expect(translateFunctionResponse('admin-users', 500, { error: { code: 'weird', message: 'kaput' } })).toMatchObject({ code: 'invalid', message: 'kaput' });
  });
});

describe('translatePasswordChangeError', () => {
  const auth = (code: string, message: string, status = 400) => ({ name: 'AuthApiError', code, message, status });
  it('wrong current password', () => {
    const e = translatePasswordChangeError(auth('invalid_credentials', 'Invalid login credentials'), 'verify');
    expect(e).toMatchObject({ code: 'invalid', message: 'Current password is wrong' });
  });
  it('same password and weak password', () => {
    expect(translatePasswordChangeError(auth('same_password', 'New password should be different from the old password.', 422), 'update').message).toBe(
      'Must be different from your current password',
    );
    expect(translatePasswordChangeError(auth('weak_password', 'Password should be at least 8 characters.', 422), 'update').message).toBe(
      'Password should be at least 8 characters.',
    );
  });
  it('falls back to the general mapping', () => {
    expect(translatePasswordChangeError(auth('over_request_rate_limit', 'rate', 429), 'verify').message).toMatch(/Too many attempts/);
    expect(translatePasswordChangeError(new TypeError('Failed to fetch'), 'update').message).toBe(NETWORK_MESSAGE);
  });
});

describe('mustChangeFromUser', () => {
  it('reads user_metadata.must_change_password', () => {
    expect(mustChangeFromUser({ user_metadata: { must_change_password: true, full_name: 'A' } })).toBe(true);
    expect(mustChangeFromUser({ user_metadata: { must_change_password: false } })).toBe(false);
    expect(mustChangeFromUser({ user_metadata: {} })).toBe(false);
    expect(mustChangeFromUser(null)).toBe(false);
  });
});
