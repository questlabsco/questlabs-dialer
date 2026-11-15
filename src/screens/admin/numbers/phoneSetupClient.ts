/**
 * Where the Phone setup section gets its data: the real Telnyx functions, or (dev builds only)
 * canned responses picked with localStorage['questlabs.phoneSetupFixture'] = '<fixture name>'.
 * Returns null in demo mode, where there is no backend.
 */
import { isDemo } from '../../../api';
import type { TelnyxAssignResult, TelnyxSetupResult, TelnyxStatusResult, TelnyxSyncResult } from '../../../telephony/telnyxAdmin';

export interface PhoneSetupClient {
  /** Set when the data is canned (dev only). */
  fixture: string | null;
  status(): Promise<TelnyxStatusResult>;
  setup(): Promise<TelnyxSetupResult>;
  sync(): Promise<TelnyxSyncResult>;
  assign(providerId: string): Promise<TelnyxAssignResult>;
}

export const FIXTURE_KEY = 'questlabs.phoneSetupFixture';

function fixtureName(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return window.localStorage.getItem(FIXTURE_KEY) || null;
  } catch {
    return null;
  }
}

export async function loadPhoneSetupClient(): Promise<PhoneSetupClient | null> {
  if (import.meta.env.DEV) {
    const name = fixtureName();
    if (name) {
      const { fixtureClient } = await import('./phoneSetupFixtures');
      const c = fixtureClient(name);
      if (c) return c;
    }
  }
  if (isDemo) return null;
  const t = await import('../../../telephony/telnyxAdmin');
  return {
    fixture: null,
    status: t.getTelnyxStatus,
    setup: t.runTelnyxSetup,
    sync: t.syncTelnyxNumbers,
    assign: t.assignTelnyxNumber,
  };
}
