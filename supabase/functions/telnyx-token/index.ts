// telnyx-token: returns { token } — a short-lived Telnyx WebRTC login JWT for the signed-in user.
// One telephony credential per user is created (once) under the dialer's own credential connection
// (POST /v2/telephony_credentials), then a JWT is minted for it (POST /v2/telephony_credentials/{id}/token,
// which returns the JWT as text/plain).
import { DIALER_NAMES } from '../_shared/telnyxLogic.ts';
import { adminClient, HttpError, json, requireConfig, requireUser, serve, telnyx, TelnyxError } from '../_shared/telnyx.ts';

interface CredentialRow {
  profile_id: string;
  credential_id: string;
  connection_id: string;
}

async function createCredential(profileId: string, connectionId: string): Promise<CredentialRow> {
  const res = await telnyx<{ data: { id: string; sip_username?: string } }>('POST', '/telephony_credentials', {
    name: `${DIALER_NAMES.credentialConnection} - ${profileId}`,
    tag: DIALER_NAMES.credentialTag,
    connection_id: connectionId,
  });
  const row = {
    profile_id: profileId,
    credential_id: res.data.id,
    connection_id: connectionId,
    sip_username: res.data.sip_username ?? null,
  };
  const { error } = await adminClient().from('telephony_credentials').upsert(row, { onConflict: 'profile_id' });
  if (error) throw new HttpError(500, 'Could not save the telephony credential.', 'internal');
  return row;
}

serve(async (req) => {
  const user = await requireUser(req);
  const cfg = await requireConfig();
  const db = adminClient();

  const { data: existing } = await db
    .from('telephony_credentials')
    .select('profile_id, credential_id, connection_id')
    .eq('profile_id', user.id)
    .maybeSingle();

  let cred = existing as CredentialRow | null;
  // Credential under an old connection (setup re-created it): make a new one.
  if (cred && cred.connection_id !== cfg.credential_connection_id) cred = null;
  if (!cred) cred = await createCredential(user.id, cfg.credential_connection_id);

  const mint = (id: string) =>
    telnyx<string>('POST', `/telephony_credentials/${encodeURIComponent(id)}/token`, undefined, {
      'Idempotency-Key': crypto.randomUUID(),
      Accept: 'text/plain, application/json',
    });

  let token: string;
  try {
    token = await mint(cred.credential_id);
  } catch (e) {
    // Credential deleted or expired on the Telnyx side: recreate once.
    if (e instanceof TelnyxError && (e.status === 404 || e.status === 422)) {
      cred = await createCredential(user.id, cfg.credential_connection_id);
      token = await mint(cred.credential_id);
    } else {
      throw new HttpError(502, 'Telnyx did not issue a login token. Try again in a moment.', 'provider_error');
    }
  }
  token = String(token).trim();
  if (!token) throw new HttpError(502, 'Telnyx returned an empty login token.', 'provider_error');
  return json({ token });
});
