// telnyx-sync-numbers (admin): lists the account's numbers (GET /v2/phone_numbers) and imports ONLY
// the ones attached to the dialer's own Voice API app into phone_numbers (number, provider_id).
// Numbers attached to anything else are reported as "in use elsewhere" and never imported or
// reassigned; unattached numbers are reported as "unassigned" (assign them with telnyx-assign-number).
// Rows whose number is no longer attached to the dialer are marked inactive, never deleted.
// Never buys numbers.
//
// Response (200):
// {
//   imported: number, updated: number, deactivated: number,
//   dialer: { number, providerId }[],
//   inUseElsewhere: { number, providerId, connectionId, connectionName }[],
//   unassigned: { number, providerId }[]
// }
import { classifyNumbers, type TelnyxNumberLite } from '../_shared/telnyxLogic.ts';
import { adminClient, HttpError, json, loadSettings, requireConfig, requireUser, serve, telnyxListAll } from '../_shared/telnyx.ts';

serve(async (req) => {
  await requireUser(req, { admin: true });
  const cfg = await requireConfig();
  const settings = await loadSettings();
  const db = adminClient();

  const list = await telnyxListAll<TelnyxNumberLite>('/phone_numbers');
  const c = classifyNumbers(list, cfg.voice_app_id);

  const { data: rows, error } = await db.from('phone_numbers').select('id, number, provider_id, active');
  if (error) throw new HttpError(500, 'Could not read phone numbers.', 'internal');
  const byNumber = new Map((rows ?? []).map((r) => [r.number as string, r]));

  let imported = 0;
  let updated = 0;
  for (const n of c.dialer) {
    const existing = byNumber.get(n.number);
    if (!existing) {
      const { error: insErr } = await db.from('phone_numbers').insert({
        number: n.number,
        provider_id: n.providerId,
        label: '',
        active: true,
        daily_cap: settings.default_daily_cap,
        added_at: new Date().toISOString(),
      });
      if (insErr) throw new HttpError(500, `Could not import ${n.number}.`, 'internal');
      imported++;
    } else if (existing.provider_id !== n.providerId) {
      // Link a manually added number to Telnyx. Its active flag is the admin's choice; left as is.
      await db.from('phone_numbers').update({ provider_id: n.providerId }).eq('id', existing.id);
      updated++;
    }
  }

  const dialerNumbers = new Set(c.dialer.map((n) => n.number));
  let deactivated = 0;
  for (const r of rows ?? []) {
    if (r.provider_id && r.active && !dialerNumbers.has(r.number as string)) {
      await db.from('phone_numbers').update({ active: false }).eq('id', r.id);
      deactivated++;
    }
  }

  return json({ imported, updated, deactivated, dialer: c.dialer, inUseElsewhere: c.inUseElsewhere, unassigned: c.unassigned });
});
