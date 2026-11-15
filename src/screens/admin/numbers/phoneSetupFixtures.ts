/**
 * DEV ONLY: canned Telnyx responses for looking at the Phone setup section without a backend.
 * Pick one with localStorage['questlabs.phoneSetupFixture'] = name and reload the Numbers screen.
 * The checklist items come from the real evaluateStatus(), so the wording matches the server.
 */
import { evaluateStatus, type StatusFacts } from '../../../../supabase/functions/_shared/telnyxLogic';
import type { TelnyxSetupResult, TelnyxStatusResult, TelnyxSyncResult } from '../../../telephony/telnyxAdmin';
import type { PhoneSetupClient } from './phoneSetupClient';

const HOOK = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/telnyx-webhook';

const GOOD: StatusFacts = {
  apiKeyPresent: true,
  apiKeyAccepted: true,
  expectedWebhookUrl: HOOK,
  voiceApp: { id: 'va1', name: 'Quest Labs Dialer - Voice App', webhookUrl: HOOK, apiVersion: '2', profileId: 'ovp1' },
  credentialConnection: { id: 'cc1', name: 'Quest Labs Dialer - WebRTC', webhookUrl: HOOK, apiVersion: '2', parking: true, profileId: 'ovp1' },
  outboundProfile: { id: 'ovp1', name: 'Quest Labs - US Outbound' },
  publicKeyPresent: true,
  dialerNumbers: 2,
};

function status(f: StatusFacts, extra: Partial<TelnyxStatusResult> = {}): TelnyxStatusResult {
  const items = evaluateStatus(f);
  return {
    ok: items.every((i) => i.ok),
    checkedAt: new Date().toISOString(),
    items,
    numbers: f.apiKeyAccepted ? { dialer: f.dialerNumbers, inUseElsewhere: 1, unassigned: 0 } : null,
    concurrentCallLimit: null,
    concurrentCallLimitSource: 'unknown',
    concurrentCallLimitNote: 'The account-wide concurrent-call limit is not available through the Telnyx API.',
    ...extra,
  };
}

const SETUP_OK: TelnyxSetupResult = {
  ok: true,
  created: [],
  reused: ['Outbound voice profile "Quest Labs - US Outbound"', 'Voice API application "Quest Labs Dialer - Voice App"', 'WebRTC credential connection "Quest Labs Dialer - WebRTC"'],
  updated: [],
  config: {
    voiceAppId: 'va1',
    voiceAppName: 'Quest Labs Dialer - Voice App',
    credentialConnectionId: 'cc1',
    credentialConnectionName: 'Quest Labs Dialer - WebRTC',
    outboundVoiceProfileId: 'ovp1',
    outboundVoiceProfileName: 'Quest Labs - US Outbound',
    webhookUrl: HOOK,
    publicKeyStored: true,
  },
  warnings: [],
};

const SYNC_EMPTY: TelnyxSyncResult = { imported: 0, updated: 0, deactivated: 0, dialer: [], inUseElsewhere: [], unassigned: [] };

const VAPI = { number: '+12145550199', providerId: 'pn-vapi', connectionId: 'conn-vapi', connectionName: 'Vapi' };

interface Fixture {
  status: TelnyxStatusResult | string;
  /** Status after "Set up Telnyx" ran once. */
  statusAfterSetup?: TelnyxStatusResult;
  setup: TelnyxSetupResult | string;
  sync: TelnyxSyncResult | string;
  /** providerId -> error message (others succeed). */
  assignErrors?: Record<string, string>;
}

const SERVER_OFF = 'Failed to send a request to the Edge Function';
const NOT_CONFIGURED = 'Phone calling is not set up yet. An admin must run "Set up Telnyx" first.';

const FIXTURES: Record<string, () => Fixture> = {
  'not-connected': () => ({
    status: status({ ...GOOD, apiKeyPresent: false, apiKeyAccepted: false }),
    setup: 'Set the TELNYX_API_KEY secret for this Supabase project first.',
    sync: NOT_CONFIGURED,
  }),
  'key-rejected': () => ({
    status: status({ ...GOOD, apiKeyAccepted: false }),
    setup: 'Telnyx rejected the API key. Check the TELNYX_API_KEY secret.',
    sync: 'Telnyx rejected the API key.',
  }),
  'server-off': () => ({ status: SERVER_OFF, setup: SERVER_OFF, sync: SERVER_OFF }),
  'needs-setup': () => ({
    status: status({ ...GOOD, voiceApp: null, credentialConnection: null, outboundProfile: null, publicKeyPresent: false, dialerNumbers: 0 }),
    statusAfterSetup: status({ ...GOOD, dialerNumbers: 0 }),
    setup: {
      ...SETUP_OK,
      created: ['Voice API application "Quest Labs Dialer - Voice App"', 'WebRTC credential connection "Quest Labs Dialer - WebRTC"'],
      reused: ['Outbound voice profile "Quest Labs - US Outbound"'],
    },
    sync: SYNC_EMPTY,
  }),
  partial: () => ({
    status: status(
      {
        ...GOOD,
        voiceApp: { ...GOOD.voiceApp!, webhookUrl: 'https://old-project.supabase.co/functions/v1/telnyx-webhook' },
        credentialConnection: { ...GOOD.credentialConnection!, parking: false },
        publicKeyPresent: false,
        dialerNumbers: 0,
      },
      { concurrentCallLimit: 4, concurrentCallLimitSource: 'outbound_voice_profile' },
    ),
    statusAfterSetup: status({ ...GOOD, dialerNumbers: 0 }, { concurrentCallLimit: 4, concurrentCallLimitSource: 'outbound_voice_profile' }),
    setup: {
      ...SETUP_OK,
      ok: true,
      reused: ['Outbound voice profile "Quest Labs - US Outbound"'],
      updated: ['Voice API application "Quest Labs Dialer - Voice App"', 'WebRTC credential connection "Quest Labs Dialer - WebRTC"'],
      warnings: ['The WebRTC connection changed; callers get new login credentials automatically on their next Start.'],
    },
    sync: { ...SYNC_EMPTY, inUseElsewhere: [VAPI] },
  }),
  'ok-no-numbers': () => ({
    status: status({ ...GOOD, dialerNumbers: 0 }, { numbers: { dialer: 0, inUseElsewhere: 1, unassigned: 0 } }),
    setup: SETUP_OK,
    sync: SYNC_EMPTY,
  }),
  'ok-all-groups': () => ({
    status: status(GOOD, { concurrentCallLimit: 10, concurrentCallLimitSource: 'outbound_voice_profile', numbers: { dialer: 2, inUseElsewhere: 2, unassigned: 2 } }),
    setup: SETUP_OK,
    sync: {
      imported: 1,
      updated: 0,
      deactivated: 0,
      dialer: [
        { number: '+12145550101', providerId: 'pn-1' },
        { number: '+14695550102', providerId: 'pn-2' },
      ],
      unassigned: [
        { number: '+19725550110', providerId: 'pn-10' },
        { number: '+18175550111', providerId: 'pn-11' },
      ],
      inUseElsewhere: [VAPI, { number: '+12145550198', providerId: 'pn-vapi-2', connectionId: 'conn-sip', connectionName: 'Vapi SIP trunk' }],
    },
    assignErrors: { 'pn-11': '+18175550111 is in use by "Vapi". It was not changed.' },
  }),
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function answer<T>(v: T | string): Promise<T> {
  return wait(350).then(() => {
    if (typeof v === 'string') throw new Error(v);
    return v;
  });
}

export function fixtureClient(name: string): PhoneSetupClient | null {
  const make = FIXTURES[name];
  if (!make) return null;
  const f = make();
  let setupRan = false;
  return {
    fixture: name,
    status: () => answer(setupRan && f.statusAfterSetup ? { ...f.statusAfterSetup, checkedAt: new Date().toISOString() } : f.status),
    setup: async () => {
      const r = await answer(f.setup);
      setupRan = true;
      return r;
    },
    sync: () => answer(f.sync),
    assign: async (providerId) => {
      const err = f.assignErrors?.[providerId];
      if (err) return answer<never>(err);
      const sync = typeof f.sync === 'string' ? null : f.sync;
      const n = sync?.unassigned.find((x) => x.providerId === providerId);
      return answer({ number: n?.number ?? '+10000000000', providerId, alreadyAssigned: false, phoneNumberId: 'fixture-' + providerId });
    },
  };
}
