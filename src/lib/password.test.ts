import { describe, expect, it } from 'vitest';
import { PASSWORD_MESSAGES, hasErrors, newPasswordProblem, validatePasswordChange } from './password';

describe('newPasswordProblem', () => {
  it('needs at least 8 characters', () => {
    expect(newPasswordProblem('')).toBe(PASSWORD_MESSAGES.required);
    expect(newPasswordProblem('1234567')).toBe('At least 8 characters');
    expect(newPasswordProblem('12345678')).toBeNull();
  });
  it('must differ from the current password', () => {
    expect(newPasswordProblem('temporary1', 'temporary1')).toBe(PASSWORD_MESSAGES.sameAsCurrent);
    expect(newPasswordProblem('temporary2', 'temporary1')).toBeNull();
    expect(newPasswordProblem('temporary1', '')).toBeNull();
  });
});

describe('validatePasswordChange', () => {
  it('accepts a valid change', () => {
    expect(validatePasswordChange({ current: 'old-pass-1', next: 'new-pass-1', confirm: 'new-pass-1' })).toEqual({});
  });
  it('asks for the current password only when the form has that field', () => {
    expect(validatePasswordChange({ current: '', next: 'new-pass-1', confirm: 'new-pass-1' }).current).toBe(PASSWORD_MESSAGES.currentRequired);
    expect(validatePasswordChange({ next: 'new-pass-1', confirm: 'new-pass-1' })).toEqual({});
  });
  it('reports a mismatched confirmation', () => {
    const e = validatePasswordChange({ current: 'old-pass-1', next: 'new-pass-1', confirm: 'new-pass-2' });
    expect(e).toEqual({ confirm: "Passwords don't match" });
    expect(hasErrors(e)).toBe(true);
  });
  it('reports a short or unchanged new password on the new-password field only', () => {
    expect(validatePasswordChange({ current: 'old-pass-1', next: 'short', confirm: 'other' })).toEqual({ next: 'At least 8 characters' });
    expect(validatePasswordChange({ current: 'old-pass-1', next: 'old-pass-1', confirm: 'old-pass-1' })).toEqual({ next: PASSWORD_MESSAGES.sameAsCurrent });
  });
});
