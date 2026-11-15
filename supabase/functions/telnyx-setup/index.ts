// telnyx-setup (admin): idempotently finds or creates the dialer's OWN Telnyx resources and stores
// their ids in telephony_config. Safe to run repeatedly. It never modifies or deletes anything it did
// not create (other apps, connections, numbers, existing outbound voice profiles); it only ATTACHES
// its own app/connection to the preferred existing outbound voice profile, which does not change
// that profile. It never buys numbers.
//
// Response (200):
// {
//   ok: boolean,
//   created: string[],   // human labels of resources created this run
//   reused: string[],    // found and left as they are
//   updated: string[],   // the dialer's own resources whose settings were corrected
//   config: { voiceAppId, voiceAppName, credentialConnectionId, credentialConnectionName,
//             outboundVoiceProfileId, outboundVoiceProfileName, webhookUrl, publicKeyStored },
//   warnings: string[]
// }
import { DIALER_NAMES, FIRST_COMMAND_TIMEOUT_SECS } from '../_shared/telnyxLogic.ts';
import {
  HttpError,
  json,
  loadConfig,
  requireUser,
  saveConfig,
  serve,
  telnyx,
  telnyxKeyPresent,
  telnyxListAll,
  TelnyxError,
  webhookUrl,
} from '../_shared/telnyx.ts';

interface Named {
  id: string;
}
interface VoiceApp extends Named {
  application_name: string;
  webhook_event_url?: string | null;
  webhook_api_version?: string | null;
  first_command_timeout?: boolean;
  first_command_timeout_secs?: number;
  outbound?: { outbound_voice_profile_id?: string | null } | null;
}
interface CredConn extends Named {
  connection_name: string;
  webhook_event_url?: string | null;
  webhook_api_version?: string | null;
  outbound?: { call_parking_enabled?: boolean | null; outbound_voice_profile_id?: string | null } | null;
  sip_uri_calling_preference?: string | null;
}
interface Ovp extends Named {
  name: string;
}

const same = (a: string | null | undefined, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

async function getById<T>(path: string, id: string | null): Promise<T | null> {
  if (!id) return null;
  try {
    const res = await telnyx<{ data: T }>('GET', `${path}/${encodeURIComponent(id)}`);
    return res.data ?? null;
  } catch (e) {
    if (e instanceof TelnyxError && (e.status === 404 || e.status === 422)) return null;
    throw e;
  }
}

function randomAlnum(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

serve(async (req) => {
  await requireUser(req, { admin: true });
  if (!telnyxKeyPresent()) {
    throw new HttpError(400, 'Set the TELNYX_API_KEY secret for this Supabase project first.', 'missing_api_key');
  }
  const created: string[] = [];
  const reused: string[] = [];
  const updated: string[] = [];
  const warnings: string[] = [];
  const hook = webhookUrl();
  const prev = await loadConfig();

  try {
    // ---- Outbound voice profile: reuse the preferred one, else the dialer's own, else create ours.
    const profiles = await telnyxListAll<Ovp>('/outbound_voice_profiles');
    let ovp =
      profiles.find((p) => same(p.name, DIALER_NAMES.preferredOutboundProfile)) ??
      profiles.find((p) => same(p.name, DIALER_NAMES.ownOutboundProfile)) ??
      null;
    if (ovp) {
      reused.push(`Outbound voice profile "${ovp.name}"`);
    } else {
      const res = await telnyx<{ data: Ovp }>('POST', '/outbound_voice_profiles', {
        name: DIALER_NAMES.ownOutboundProfile,
        traffic_type: 'conversational',
        service_plan: 'global',
        whitelisted_destinations: ['US', 'CA'],
        enabled: true,
      });
      ovp = res.data;
      created.push(`Outbound voice profile "${ovp.name}"`);
    }

    // ---- Voice API (Call Control) application.
    const appWanted = {
      webhook_event_url: hook,
      webhook_api_version: '2',
      active: true,
      first_command_timeout: true,
      first_command_timeout_secs: FIRST_COMMAND_TIMEOUT_SECS,
      outbound: { outbound_voice_profile_id: ovp.id },
    };
    let app = await getById<VoiceApp>('/call_control_applications', prev?.voice_app_id ?? null);
    if (app && !same(app.application_name, DIALER_NAMES.voiceApp)) app = null; // never adopt a foreign app
    if (!app) {
      const apps = await telnyxListAll<VoiceApp>('/call_control_applications');
      app = apps.find((a) => same(a.application_name, DIALER_NAMES.voiceApp)) ?? null;
    }
    if (!app) {
      const res = await telnyx<{ data: VoiceApp }>('POST', '/call_control_applications', {
        application_name: DIALER_NAMES.voiceApp,
        ...appWanted,
      });
      app = res.data;
      created.push(`Voice API application "${app.application_name}"`);
    } else {
      const drift =
        app.webhook_event_url !== hook ||
        String(app.webhook_api_version) !== '2' ||
        app.first_command_timeout !== true ||
        app.first_command_timeout_secs !== FIRST_COMMAND_TIMEOUT_SECS ||
        app.outbound?.outbound_voice_profile_id !== ovp.id;
      if (drift) {
        const res = await telnyx<{ data: VoiceApp }>(
          'PATCH',
          `/call_control_applications/${encodeURIComponent(app.id)}`,
          { application_name: app.application_name, ...appWanted },
        );
        app = res.data ?? app;
        updated.push(`Voice API application "${app.application_name}"`);
      } else {
        reused.push(`Voice API application "${app.application_name}"`);
      }
    }

    // ---- Credential connection for the callers' WebRTC audio legs (parked outbound calls).
    // sip_uri_calling_preference 'internal': only connections on THIS account may call the callers'
    // apps by SIP URI. Callbacks use it: the Voice API app rings sip:<gencred...>@sip.telnyx.com
    // (Telnyx WebRTC "Pattern 2", developers.telnyx.com/docs/voice/webrtc/auth/credential-connections).
    const connWanted = {
      active: true,
      webhook_event_url: hook,
      webhook_api_version: '2',
      sip_uri_calling_preference: 'internal',
      outbound: { call_parking_enabled: true, outbound_voice_profile_id: ovp.id },
    };
    let conn = await getById<CredConn>('/credential_connections', prev?.credential_connection_id ?? null);
    if (conn && !same(conn.connection_name, DIALER_NAMES.credentialConnection)) conn = null;
    if (!conn) {
      const conns = await telnyxListAll<CredConn>('/credential_connections');
      conn = conns.find((c) => same(c.connection_name, DIALER_NAMES.credentialConnection)) ?? null;
    }
    if (!conn) {
      const res = await telnyx<{ data: CredConn }>('POST', '/credential_connections', {
        connection_name: DIALER_NAMES.credentialConnection,
        // Required by the API; never used (callers log in with per-user telephony credentials + JWT).
        user_name: `qldialer${randomAlnum(16)}`,
        password: randomAlnum(40),
        tags: [DIALER_NAMES.credentialTag],
        ...connWanted,
      });
      conn = res.data;
      created.push(`WebRTC credential connection "${conn.connection_name}"`);
    } else {
      const drift =
        conn.webhook_event_url !== hook ||
        String(conn.webhook_api_version) !== '2' ||
        conn.outbound?.call_parking_enabled !== true ||
        conn.sip_uri_calling_preference !== 'internal' ||
        conn.outbound?.outbound_voice_profile_id !== ovp.id;
      if (drift) {
        const res = await telnyx<{ data: CredConn }>(
          'PATCH',
          `/credential_connections/${encodeURIComponent(conn.id)}`,
          connWanted,
        );
        conn = res.data ?? conn;
        updated.push(`WebRTC credential connection "${conn.connection_name}"`);
      } else {
        reused.push(`WebRTC credential connection "${conn.connection_name}"`);
      }
    }

    // ---- Webhook signing public key.
    let publicKey: string | null = prev?.webhook_public_key ?? null;
    try {
      const res = await telnyx<{ data?: { public?: string } }>('GET', '/public_key');
      if (res.data?.public) publicKey = res.data.public;
      else warnings.push('Telnyx did not return a webhook public key.');
    } catch (e) {
      warnings.push(
        `Could not read the webhook public key from Telnyx (${e instanceof Error ? e.message : 'error'}). ` +
          'Copy it from the Telnyx portal (Account > Public Key) into the TELNYX_PUBLIC_KEY secret.',
      );
    }

    await saveConfig({
      voice_app_id: app.id,
      voice_app_name: app.application_name,
      credential_connection_id: conn.id,
      credential_connection_name: conn.connection_name,
      outbound_voice_profile_id: ovp.id,
      outbound_voice_profile_name: ovp.name,
      webhook_url: hook,
      webhook_public_key: publicKey,
    });

    if (prev?.credential_connection_id && prev.credential_connection_id !== conn.id) {
      warnings.push('The WebRTC connection changed; callers get new login credentials automatically on their next Start.');
    }

    return json({
      ok: !!publicKey,
      created,
      reused,
      updated,
      config: {
        voiceAppId: app.id,
        voiceAppName: app.application_name,
        credentialConnectionId: conn.id,
        credentialConnectionName: conn.connection_name,
        outboundVoiceProfileId: ovp.id,
        outboundVoiceProfileName: ovp.name,
        webhookUrl: hook,
        publicKeyStored: !!publicKey,
      },
      warnings,
    });
  } catch (e) {
    if (e instanceof TelnyxError) {
      if (e.status === 401 || e.status === 403) {
        throw new HttpError(400, 'Telnyx rejected the API key. Check the TELNYX_API_KEY secret.', 'bad_api_key');
      }
      throw new HttpError(502, `Telnyx setup failed: ${e.message}`, 'provider_error', { created, updated });
    }
    throw e;
  }
});
