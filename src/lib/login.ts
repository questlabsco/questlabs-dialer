/**
 * People sign in with a USERNAME. Supabase Auth needs an email as the account identifier,
 * so a username maps to a hidden internal address on a reserved domain that never receives
 * mail. Nobody sees that address: `displayLogin()` turns it back into the username.
 */

/** Domain of the hidden login addresses (the owner's own domain). The app never sends mail to it. */
export const LOGIN_DOMAIN = 'questlabsco.com';
/** Domain of the built-in demo accounts. */
export const DEMO_LOGIN_DOMAIN = 'questlabs.demo';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/** Trimmed and lower-cased. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** 3-30 characters: letters, digits, dot, dash, underscore; starts with a letter or digit. */
export function isValidUsername(input: string): boolean {
  return USERNAME_RE.test(normalizeUsername(input));
}

/** The account identifier to send to the backend for what someone typed. */
export function loginEmail(usernameOrEmail: string): string {
  const v = usernameOrEmail.trim().toLowerCase();
  if (v.includes('@')) return v;
  return `${v}@${LOGIN_DOMAIN}`;
}

/** What to show for an account's login: the username for internal / demo addresses, else the full string. */
export function displayLogin(email: string): string {
  const s = (email ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at < 0) return s;
  const domain = s.slice(at + 1).toLowerCase();
  if (domain === LOGIN_DOMAIN || domain === DEMO_LOGIN_DOMAIN) return s.slice(0, at);
  return s;
}
