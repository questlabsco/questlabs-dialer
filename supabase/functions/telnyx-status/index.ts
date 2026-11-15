// telnyx-status (admin): read-only checklist of the dialer's Telnyx setup. Never changes anything.
//
// Response (200):
// {
//   ok: boolean,                 // every item ok
//   checkedAt: string,           // ISO
//   items: { key, label, ok, detail, hint }[],   // see StatusItem in _shared/telnyxLogic.ts
//   numbers: { dialer: number, inUseElsewhere: number, unassigned: number } | null,
//   concurrentCallLimit: number | null,           // null = not exposed by the API / unlimited
//   concurrentCallLimitSource: 'outbound_voice_profile' | 'unknown',
//   concurrentCallLimitNote: string
// }
import { classifyNumbers, evaluateStatus, type StatusFacts, type TelnyxNumberLite } from '../_shared/telnyxLogic.ts';
import {
  env,
  json,
  loadConfig,
  requireUser,
  serve,
  telnyx,
  telnyxKeyPresent,
  telnyxListAll,
  TelnyxError,
  webhookUrl,
} from '../_shared/telnyx.ts';

async function tryGet<T>(path: string): Promise<T | null> {
  try {
    const res = await telnyx<{ data: T }>('GET', path);
    return res.data ?? null;
  } catch (e) {
    if (e instanceof TelnyxError && e.status !== 401 && e.status !== 403) return null;
    throw e;
  }
}

serve(async (req) => {
  await requireUser(req, { admin: true });
  const cfg = await loadConfig();
  const facts: StatusFacts = {
    apiKeyPresent: telnyxKeyPresent(),
    apiKeyAccepted: false,
    expectedWebhookUrl: webhookUrl(),
    voiceApp: null,
    credentialConnection: null,
    outboundProfile: null,
    publicKeyPresent: !!(env('TELNYX_PUBLIC_KEY') ?? cfg?.webhook_public_key),
    dialerNumbers: 0,
  };
  let numbers: { dialer: number; inUseElsewhere: number; unassigned: number } | null = null;
  let concurrentCallLimit: number | null = null;
  let concurrentCallLimitSource: 'outbound_voice_profile' | 'unknown' = 'unknown';

  if (facts.apiKeyPresent) {
    try {
      await telnyx('GET', '/balance');
      facts.apiKeyAccepted = true;
    } catch {
      facts.apiKeyAccepted = false;
    }
  }

  if (facts.apiKeyAccepted) {
    const app = cfg?.voice_app_id ? await tryGet<any>(`/call_control_applications/${encodeURIComponent(cfg.voice_app_id)}`) : null;
    if (app) {
      facts.voiceApp = {
        id: String(app.id),
        name: String(app.application_name ?? ''),
        webhookUrl: app.webhook_event_url ?? null,
        apiVersion: app.webhook_api_version != null ? String(app.webhook_api_version) : null,
        profileId: app.outbound?.outbound_voice_profile_id ?? null,
      };
    }
    const conn = cfg?.credential_connection_id
      ? await tryGet<any>(`/credential_connections/${encodeURIComponent(cfg.credential_connection_id)}`)
      : null;
    if (conn) {
      facts.credentialConnection = {
        id: String(conn.id),
        name: String(conn.connection_name ?? ''),
        webhookUrl: conn.webhook_event_url ?? null,
        apiVersion: conn.webhook_api_version != null ? String(conn.webhook_api_version) : null,
        parking: conn.outbound?.call_parking_enabled === true,
        profileId: conn.outbound?.outbound_voice_profile_id ?? null,
        sipUriCalling: conn.sip_uri_calling_preference != null ? String(conn.sip_uri_calling_preference) : null,
      };
    }
    const profileId = facts.voiceApp?.profileId ?? cfg?.outbound_voice_profile_id ?? null;
    const ovp = profileId ? await tryGet<any>(`/outbound_voice_profiles/${encodeURIComponent(profileId)}`) : null;
    if (ovp) {
      facts.outboundProfile = { id: String(ovp.id), name: String(ovp.name ?? '') };
      if (typeof ovp.concurrent_call_limit === 'number') {
        concurrentCallLimit = ovp.concurrent_call_limit;
        concurrentCallLimitSource = 'outbound_voice_profile';
      }
    }
    const list = await telnyxListAll<TelnyxNumberLite>('/phone_numbers');
    const c = classifyNumbers(list, facts.voiceApp?.id ?? null);
    numbers = { dialer: c.dialer.length, inUseElsewhere: c.inUseElsewhere.length, unassigned: c.unassigned.length };
    facts.dialerNumbers = c.dialer.length;
  }

  const items = evaluateStatus(facts);
  return json({
    ok: items.every((i) => i.ok),
    checkedAt: new Date().toISOString(),
    items,
    numbers,
    concurrentCallLimit,
    concurrentCallLimitSource,
    concurrentCallLimitNote:
      concurrentCallLimitSource === 'outbound_voice_profile'
        ? 'Limit set on the outbound voice profile. The account-wide limit is not available through the API.'
        : 'The account-wide concurrent-call limit is not available through the Telnyx API; check it in the Telnyx portal or with Telnyx support. ' +
          'Each active caller uses one channel for their audio leg plus one per ringing line.',
  });
});
