/** Rules and wording for choosing a new password. Shared by the API layer and the screens. */

export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_MESSAGES = {
  required: 'Enter a password',
  currentRequired: 'Enter your current password',
  tooShort: 'At least 8 characters',
  sameAsCurrent: 'Must be different from your current password',
  mismatch: "Passwords don't match",
  currentWrong: 'Current password is wrong',
} as const;

/** Why `next` cannot be used as a new password, or null when it is fine. `current` is compared when given. */
export function newPasswordProblem(next: string, current?: string | null): string | null {
  if (!next) return PASSWORD_MESSAGES.required;
  if (next.length < MIN_PASSWORD_LENGTH) return PASSWORD_MESSAGES.tooShort;
  if (current && next === current) return PASSWORD_MESSAGES.sameAsCurrent;
  return null;
}

export interface PasswordChangeErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

/**
 * Field-level errors for a change-password form. Empty object = valid.
 * `current` undefined = the form has no current-password field (it is known elsewhere).
 */
export function validatePasswordChange(input: { current?: string; next: string; confirm: string }): PasswordChangeErrors {
  const errors: PasswordChangeErrors = {};
  if (input.current !== undefined && !input.current) errors.current = PASSWORD_MESSAGES.currentRequired;
  const nextProblem = newPasswordProblem(input.next, input.current);
  if (nextProblem) errors.next = nextProblem;
  if (!errors.next && input.confirm !== input.next) errors.confirm = PASSWORD_MESSAGES.mismatch;
  return errors;
}

export function hasErrors(errors: PasswordChangeErrors): boolean {
  return Boolean(errors.current || errors.next || errors.confirm);
}
