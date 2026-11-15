// telnyx-assign-number (admin): attaches ONE chosen number to the dialer's Voice API app
// (PATCH /v2/phone_numbers/{id} { connection_id }) and imports it into phone_numbers.
// Body: { providerId?: string, number?: string, force?: boolean }
// Refuses (409, code 'in_use_elsewhere') when the number is attached to another app/connection,
// unless force === true. The app UI never sends force. Never buys numbers.
//
// Response (200): { number, providerId, alreadyAssigned: boolean, phoneNumberId: string }
import { normalizeTelnyxNumber } from '../_shared/telnyxLogic.ts';
import {
  adminClient,
  HttpError,
  json,
  loadSettings,
  readJson,
  requireConfig,
  requireUser,
  serve,
  telnyx,
  telnyxListAll,
} from '../_shared/telnyx.ts';

interface TelnyxNumber {
  id: string;
  phone_number: string;
  status?: string;
  connection_id?: string | null;
  connection_name?: string | null;
}

serve(async (req) => {
  await requireUser(req, { admin: true });
  const body = await readJson<{ providerId?: string; number?: string; force?: boolean }>(req);
  const cfg = await requireConfig();
  const db = adminClient();

  let tn: TelnyxNumber | null = null;
  if (typeof body.providerId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.providerId)) {
    tn = (await telnyx<{ data: TelnyxNumber }>('GET', `/phone_numbers/${encodeURIComponent(body.providerId)}`)).data;
  } else {
    const wanted = normalizeTelnyxNumber(body.number);
    if (!wanted) throw new HttpError(400, 'Give providerId or a number in E.164 format.', 'invalid');
    const list = await telnyxListAll<TelnyxNumber>('/phone_numbers', { 'filter[phone_number]': wanted });
    tn = list.find((n) => normalizeTelnyxNumber(n.phone_number) === wanted) ?? null;
  }
  if (!tn) throw new HttpError(404, 'That number is not in this Telnyx account.', 'not_found');
  if (tn.status && tn.status !== 'active') {
    throw new HttpError(409, `That number is not active in Telnyx yet (status: ${tn.status}).`, 'not_active');
  }
  const number = normalizeTelnyxNumber(tn.phone_number);
  if (!number) throw new HttpError(400, 'Telnyx returned a number we cannot read.', 'invalid');

  const current = tn.connection_id ? String(tn.connection_id) : null;
  const alreadyAssigned = current === cfg.voice_app_id;
  if (current && !alreadyAssigned && body.force !== true) {
    throw new HttpError(
      409,
      `${number} is in use by "${tn.connection_name ?? current}". It was not changed.`,
      'in_use_elsewhere',
      { connectionId: current, connectionName: tn.connection_name ?? null },
    );
  }
  if (!alreadyAssigned) {
    await telnyx('PATCH', `/phone_numbers/${encodeURIComponent(tn.id)}`, { connection_id: cfg.voice_app_id });
  }

  const settings = await loadSettings();
  const { data: existing } = await db.from('phone_numbers').select('id').eq('number', number).maybeSingle();
  let phoneNumberId: string;
  if (existing) {
    await db.from('phone_numbers').update({ provider_id: tn.id, active: true }).eq('id', existing.id);
    phoneNumberId = existing.id as string;
  } else {
    const { data: ins, error } = await db
      .from('phone_numbers')
      .insert({
        number,
        provider_id: tn.id,
        label: '',
        active: true,
        daily_cap: settings.default_daily_cap,
        added_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !ins) throw new HttpError(500, 'Assigned in Telnyx, but could not save the number.', 'internal');
    phoneNumberId = ins.id as string;
  }
  return json({ number, providerId: tn.id, alreadyAssigned, phoneNumberId });
});
