import { describe, expect, it } from 'vitest';
import { evaluateStatus, type StatusFacts } from '../../../../supabase/functions/_shared/telnyxLogic';
import type { TelnyxStatusResult, TelnyxSyncResult } from '../../../telephony/telnyxAdmin';
import {
  checklistRows,
  classifyPhoneError,
  groupNumbers,
  inUseAppName,
  limitView,
  markAssigned,
  neededLines,
  otherNumbersText,
  plainPhoneError,
  plainResource,
  plainText,
  plainWarning,
  setupResultView,
  statusErrorView,
  statusStage,
  statusView,
  supabaseSecretsUrl,
  syncSummary,
} from './phoneSetupLogic';
import { FIXTURE_NAMES, fixtureClient } from './phoneSetupFixtures';

const HOOK = 'https://x.supabase.co/functions/v1/telnyx-webhook';
const GOOD: StatusFacts = {
  apiKeyPresent: true,
  apiKeyAccepted: true,
  expectedWebhookUrl: HOOK,
  voiceApp: { id: 'va', name: 'Quest Labs Dialer - Voice App', webhookUrl: HOOK, apiVersion: '2', profileId: 'p' },
  credentialConnection: { id: 'cc', name: 'Quest Labs Dialer - WebRTC', webhookUrl: HOOK, apiVersion: '2', parking: true, profileId: 'p' },
  outboundProfile: { id: 'p', name: 'Quest Labs - US Outbound' },
  publicKeyPresent: true,
  dialerNumbers: 1,
};

function status(f: StatusFacts): TelnyxStatusResult {
  const items = evaluateStatus(f);
  return {
    ok: items.every((i) => i.ok),
    checkedAt: '2026-11-15T10:00:00Z',
    items,
    numbers: null,
    concurrentCallLimit: null,
    concurrentCallLimitSource: 'unknown',
    concurrentCallLimitNote: '',
  };
}

describe('classifyPhoneError', () => {
  it('spots functions that are not deployed or unreachable', () => {
    expect(classifyPhoneError('Failed to send a request to the Edge Function')).toBe('server_off');
    expect(classifyPhoneError('Edge Function returned a non-2xx status code')).toBe('server_off');
    expect(classifyPhoneError('Relay Error invoking the Edge Function')).toBe('server_off');
    expect(classifyPhoneError('TypeError: Failed to fetch')).toBe('server_off');
  });
  it('maps the functions’ own messages', () => {
    expect(classifyPhoneError('Set the TELNYX_API_KEY secret for this Supabase project first.')).toBe('missing_key');
    expect(classifyPhoneError('The TELNYX_API_KEY secret is not set.')).toBe('missing_key');
    expect(classifyPhoneError('Telnyx rejected the API key. Check the TELNYX_API_KEY secret.')).toBe('bad_key');
    expect(classifyPhoneError('Phone calling is not set up yet. An admin must run "Set up Telnyx" first.')).toBe('not_configured');
    expect(classifyPhoneError('+12145550199 is in use by "Vapi". It was not changed.')).toBe('in_use_elsewhere');
    expect(classifyPhoneError('Only an admin can do this.')).toBe('not_admin');
    expect(classifyPhoneError('Your session has expired. Sign in again.')).toBe('signed_out');
    expect(classifyPhoneError('Telnyx: something odd')).toBe('other');
  });
  it('names the app in a refusal', () => {
    expect(inUseAppName('+12145550199 is in use by "Vapi". It was not changed.')).toBe('Vapi');
    expect(plainPhoneError('+12145550199 is in use by "Vapi". It was not changed.')).toBe(
      'Not changed: this number is being used by "Vapi". The dialer never takes numbers from other apps.',
    );
    expect(plainPhoneError('x is in use by "". It was not changed.')).toContain('another app');
    expect(plainPhoneError('Telnyx: odd')).toBe('Telnyx: odd');
  });
});

describe('statusView', () => {
  it('first run: no key', () => {
    const v = statusView(status({ ...GOOD, apiKeyPresent: false, apiKeyAccepted: false }));
    expect(v.stage).toBe('no_key');
    expect(v.canRunSetup).toBe(false);
    expect(v.rows).toHaveLength(1);
    expect(v.rows[0].detail).toBe('Not saved in Supabase yet.');
  });
  it('key rejected', () => {
    const v = statusView(status({ ...GOOD, apiKeyAccepted: false }));
    expect(v.stage).toBe('bad_key');
    expect(v.rows[0].hint).toMatch(/replace the TELNYX_API_KEY/);
  });
  it('key works but setup never ran', () => {
    const s = status({ ...GOOD, voiceApp: null, credentialConnection: null, outboundProfile: null, publicKeyPresent: false, dialerNumbers: 0 });
    expect(statusStage(s)).toBe('needs_setup');
    expect(statusView(s).summary).toMatch(/Set up Telnyx/);
  });
  it('partly set up: counts failures and rewrites technical text', () => {
    const s = status({
      ...GOOD,
      voiceApp: { ...GOOD.voiceApp!, webhookUrl: 'https://old.supabase.co/x', apiVersion: '1' },
      credentialConnection: { ...GOOD.credentialConnection!, parking: false },
    });
    const v = statusView(s);
    expect(v.stage).toBe('partial');
    expect(v.failed).toBe(2);
    expect(v.summary).toBe(`2 of ${v.rows.length} checks need fixing.`);
    const hook = v.rows.find((r) => r.key === 'voice_app_webhook')!;
    expect(hook.label).not.toMatch(/webhook/i);
    expect(hook.detail).not.toMatch(/https|API v/);
    expect(hook.technical).toMatch(/old\.supabase\.co/);
    expect(hook.hint).toBe('Click Set up Telnyx to fix this.');
    for (const r of v.rows) {
      expect(`${r.label} ${r.detail} ${r.hint ?? ''}`).not.toMatch(/telnyx-setup|webhook|WebRTC|credential connection/i);
    }
  });
  it('only the numbers are missing', () => {
    const v = statusView(status({ ...GOOD, dialerNumbers: 0 }));
    expect(v.stage).toBe('partial');
    expect(v.summary).toMatch(/no phone numbers/i);
    expect(v.rows.find((r) => r.key === 'numbers')!.hint).toMatch(/never buys/);
  });
  it('all OK collapses', () => {
    const v = statusView(status(GOOD));
    expect(v.stage).toBe('ok');
    expect(v.collapsible).toBe(true);
    expect(v.rows.find((r) => r.key === 'voice_app_profile')!.detail).toBe('Allowed (profile "Quest Labs - US Outbound").');
    expect(v.rows.every((r) => r.hint === null)).toBe(true);
  });
  it('status call failure', () => {
    expect(statusErrorView('Failed to send a request to the Edge Function').stage).toBe('server_off');
    expect(statusErrorView('The TELNYX_API_KEY secret is not set.').stage).toBe('no_key');
    const e = statusErrorView('Internal error.');
    expect(e.stage).toBe('error');
    expect(e.summary).toBe('Internal error.');
  });
  it('passes unknown items through, cleaned up', () => {
    const rows = checklistRows([{ key: 'new_thing' as never, label: 'WebRTC thing', ok: false, detail: 'Bad webhook.', hint: 'Press "Set up Telnyx" (runs telnyx-setup) to fix this automatically.' }]);
    expect(rows[0]).toMatchObject({ label: 'headset line thing', detail: 'Bad call updates.', hint: 'Click Set up Telnyx to fix this.' });
    expect(plainText('see telnyx-status')).toBe('see the phone setup');
  });
});

describe('simultaneous calls', () => {
  it('needs 1 + lines + 1 per caller', () => {
    expect(neededLines(3, 2)).toBe(12);
    expect(neededLines(1, 1)).toBe(3);
    expect(neededLines(0, 3)).toBe(0);
    expect(neededLines(2, 0)).toBe(6); // lines clamp to at least 1
  });
  it('compares with the limit', () => {
    expect(limitView(10, 3, 2)).toMatchObject({ state: 'low', value: '10' });
    expect(limitView(10, 3, 2).text).toMatch(/at least 12/);
    expect(limitView(12, 3, 2).state).toBe('ok');
    expect(limitView(null, 3, 2)).toMatchObject({ state: 'unknown' });
    expect(limitView(null, 3, 2).text).toMatch(/Telnyx support/);
    expect(limitView(2, 0, 2).state).toBe('ok');
    expect(limitView(2, 0, 2).text).toMatch(/Each caller needs up to 4/);
  });
});

describe('setup result', () => {
  it('rewrites resource names and warnings', () => {
    expect(plainResource('Voice API application "Quest Labs Dialer - Voice App"')).toBe('Calling app "Quest Labs Dialer - Voice App"');
    expect(plainResource('WebRTC credential connection "Q"')).toBe('Headset line "Q"');
    expect(plainWarning('The WebRTC connection changed; callers get new login credentials automatically on their next Start.')).toMatch(/^The headset line changed/);
    const v = setupResultView({
      ok: true,
      created: ['Voice API application "A"'],
      reused: ['Outbound voice profile "P"'],
      updated: [],
      warnings: [],
      config: {} as never,
    });
    expect(v.tone).toBe('good');
    expect(v.title).toBe('Set up done.');
    expect(v.groups.map((g) => g.label)).toEqual(['Created', 'Already there']);
  });
  it('nothing new / problems', () => {
    const base = { created: [], updated: [], reused: ['x'], config: {} as never };
    expect(setupResultView({ ...base, ok: true, warnings: [] }).title).toMatch(/nothing needed changing/);
    const bad = setupResultView({ ...base, ok: false, warnings: ['Telnyx did not return a webhook public key.'] });
    expect(bad.tone).toBe('warning');
    expect(bad.warnings[0]).toMatch(/security key/);
  });
});

describe('numbers on the account', () => {
  const r: TelnyxSyncResult = {
    imported: 1,
    updated: 0,
    deactivated: 2,
    dialer: [{ number: '+14695550102', providerId: 'b' }, { number: '+12145550101', providerId: 'a' }],
    unassigned: [{ number: '+19725550110', providerId: 'u' }],
    inUseElsewhere: [
      { number: '+12145550199', providerId: 'v', connectionId: 'c', connectionName: 'Vapi' },
      { number: '+12145550198', providerId: 'w', connectionId: 'd', connectionName: null },
    ],
  };
  it('groups and sorts, naming the other app', () => {
    const g = groupNumbers(r);
    expect(g.dialer.map((n) => n.providerId)).toEqual(['a', 'b']);
    expect(g.unused).toHaveLength(1);
    expect(g.elsewhere).toEqual([
      { number: '+12145550198', providerId: 'w', app: 'another app' },
      { number: '+12145550199', providerId: 'v', app: 'Vapi' },
    ]);
  });
  it('moves an assigned number to the dialer group', () => {
    const g = markAssigned(groupNumbers(r), 'u');
    expect(g.unused).toHaveLength(0);
    expect(g.dialer.map((n) => n.providerId)).toEqual(['a', 'b', 'u']);
    expect(markAssigned(g, 'nope')).toBe(g);
  });
  it('summarises a sync', () => {
    expect(syncSummary(r)).toBe('Added 1 number, turned off 2 no longer on the dialer.');
    expect(syncSummary({ ...r, imported: 0, deactivated: 0 })).toBe('Numbers are up to date.');
  });
});

describe('otherNumbersText', () => {
  it('counts the other numbers before a sync', () => {
    expect(otherNumbersText(null)).toBeNull();
    expect(otherNumbersText({ unassigned: 0, inUseElsewhere: 0 })).toBeNull();
    expect(otherNumbersText({ unassigned: 0, inUseElsewhere: 1 })).toBe('Your Telnyx account also has 1 number used by other apps. Click Sync from Telnyx to see them.');
    expect(otherNumbersText({ unassigned: 2, inUseElsewhere: 3 })).toMatch(/2 numbers not used yet and 3 numbers used by other apps/);
  });
});

describe('links', () => {
  it('builds the Supabase secrets link from the project URL', () => {
    expect(supabaseSecretsUrl('https://abcdefghijklmnopqrst.supabase.co')).toBe('https://supabase.com/dashboard/project/abcdefghijklmnopqrst/functions/secrets');
    expect(supabaseSecretsUrl('')).toBe('https://supabase.com/dashboard/projects');
    expect(supabaseSecretsUrl('http://localhost:54321')).toBe('https://supabase.com/dashboard/projects');
  });
});

describe('dev fixtures', () => {
  it('each fixture produces the intended stage', async () => {
    const stages: Record<string, string> = {};
    for (const name of FIXTURE_NAMES) {
      const c = fixtureClient(name)!;
      try {
        stages[name] = statusView(await c.status()).stage;
      } catch (e) {
        stages[name] = statusErrorView((e as Error).message).stage;
      }
    }
    expect(stages).toEqual({
      'not-connected': 'no_key',
      'key-rejected': 'bad_key',
      'server-off': 'server_off',
      'needs-setup': 'needs_setup',
      partial: 'partial',
      'ok-no-numbers': 'partial',
      'ok-all-groups': 'ok',
    });
    expect(fixtureClient('nope')).toBeNull();
  });
});
