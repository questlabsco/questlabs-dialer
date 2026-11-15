import { describe, expect, it } from 'vitest';
import { LOGIN_DOMAIN, displayLogin, isValidUsername, loginEmail, normalizeUsername } from './login';

describe('login helpers', () => {
  it('normalizes usernames', () => {
    expect(normalizeUsername('  Jordan ')).toBe('jordan');
  });

  it('validates usernames', () => {
    for (const ok of ['abc', 'jordan', 'j.blake', 'sam_r', 'taylor-b', '9lives', 'a'.repeat(30), ' Jordan ']) {
      expect(isValidUsername(ok)).toBe(true);
    }
    for (const bad of ['', 'ab', 'a'.repeat(31), '.jordan', '_sam', '-x1', 'jo rdan', 'jo@x', 'joé', 'a/b']) {
      expect(isValidUsername(bad)).toBe(false);
    }
  });

  it('maps a username to the internal address and keeps emails', () => {
    expect(LOGIN_DOMAIN).toBe('questlabsco.com');
    expect(loginEmail(' Casey ')).toBe('casey@questlabsco.com');
    expect(loginEmail(' Admin@QuestLabs.Demo ')).toBe('admin@questlabs.demo');
    expect(loginEmail('me@real.com')).toBe('me@real.com');
  });

  it('shows the username for internal and demo addresses only', () => {
    expect(displayLogin('casey@questlabsco.com')).toBe('casey');
    expect(displayLogin('admin@questlabs.demo')).toBe('admin');
    expect(displayLogin('Sam@QuestLabsCo.com')).toBe('Sam');
    expect(displayLogin('me@real.com')).toBe('me@real.com');
    expect(displayLogin('plain')).toBe('plain');
    expect(displayLogin('')).toBe('');
  });

  it('round-trips', () => {
    expect(displayLogin(loginEmail('taylor-b'))).toBe('taylor-b');
  });
});
