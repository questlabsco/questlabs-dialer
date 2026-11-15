// telnyx-dial: places one outbound lead call and returns { callId } at once (our own uuid).
// Body: { to, from, leadId, ring, ringSeconds?, detectMachine?, record? } (Telephony.DialRequest).
// The Dial command links the lead leg to the caller's parked agent leg with bridge_on_answer +
// prevent_double_bridge, so the lead is connected the instant they pick up without waiting for our
// webhook, and a second pickup can never double-bridge. Events arrive via telnyx-webhook.
import { buildDialBody, isUsE164 } from '../_shared/telnyxLogic.ts';
import {
  adminClient,
  HttpError,
  json,
  liveAgentSession,
  loadSettings,
  readJson,
  requireConfig,
  requireUser,
  serve,
  telnyx,
  TelnyxError,
} from '../_shared/telnyx.ts';

interface DialBody {
  to?: string;
  from?: string;
  leadId?: string;
  ring?: number;
  ringSeconds?: number;
  detectMachine?: boolean;
  record?: boolean;
}

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<DialBody>(req);
  const db = adminClient();

  if (!isUsE164(body.to)) throw new HttpError(400, 'The lead number must be a US number in +1XXXXXXXXXX format.', 'invalid');
  if (typeof body.from !== 'string') throw new HttpError(400, 'A from number is required.', 'invalid');
  if (typeof body.leadId !== 'string' || !body.leadId) throw new HttpError(400, 'leadId is required.', 'invalid');
  const ring = body.ring === 2 ? 2 : 1;

  const cfg = await requireConfig();
  const settings = await loadSettings();

  const { data: fromRow } = await db
    .from('phone_numbers')
    .select('id')
    .eq('number', body.from)
    .eq('active', true)
    .maybeSingle();
  if (!fromRow) throw new HttpError(400, 'That outbound number is not one of our active numbers.', 'invalid');

  const agent = await liveAgentSession(user.id);
  if (!agent) throw new HttpError(409, 'Your audio session is not connected. Press Start again.', 'no_agent_leg');

  // Cap simultaneous ringing legs (lines + 1 for the double-ring overlap). Rows older than 15 min
  // are ignored so a lost webhook can never block a caller forever.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await db
    .from('telephony_calls')
    .select('id', { count: 'exact', head: true })
    .eq('caller_id', user.id)
    .eq('direction', 'outbound')
    .in('status', ['dialing', 'ringing'])
    .gte('created_at', since);
  if ((count ?? 0) >= settings.lines_per_caller + 1) {
    throw new HttpError(429, 'Too many lines are ringing at once.', 'too_many_lines');
  }

  const callId = crypto.randomUUID();
  const record = typeof body.record === 'boolean' ? body.record : settings.record_calls;
  const detectMachine = typeof body.detectMachine === 'boolean' ? body.detectMachine : settings.skip_voicemail;

  const { error: insErr } = await db.from('telephony_calls').insert({
    id: callId,
    caller_id: user.id,
    lead_id: body.leadId,
    direction: 'outbound',
    from_number: body.from,
    to_number: body.to,
    ring,
    status: 'dialing',
    agent_session_id: agent.id,
    record,
  });
  if (insErr) throw new HttpError(500, 'Could not start the call.', 'internal');

  const dialBody = buildDialBody({
    callId,
    voiceAppId: cfg.voice_app_id,
    agentCallControlId: agent.call_control_id,
    to: body.to,
    from: body.from,
    ringSeconds: typeof body.ringSeconds === 'number' ? body.ringSeconds : settings.ring_seconds,
    detectMachine,
    record,
  });

  try {
    const res = await telnyx<{
      data: { call_control_id: string; call_leg_id?: string; call_session_id?: string; recording_id?: string };
    }>('POST', '/calls', dialBody);
    await db
      .from('telephony_calls')
      .update({
        call_control_id: res.data.call_control_id,
        call_leg_id: res.data.call_leg_id ?? null,
        call_session_id: res.data.call_session_id ?? null,
        recording_id: res.data.recording_id ?? null,
      })
      .eq('id', callId);
  } catch (e) {
    await db
      .from('telephony_calls')
      .update({ status: 'ended', end_reason: 'failed', ended_at: new Date().toISOString() })
      .eq('id', callId);
    if (e instanceof TelnyxError) {
      const status = e.status === 429 ? 429 : 502;
      throw new HttpError(status, `Telnyx refused the call: ${e.message}`, 'provider_error');
    }
    throw e;
  }

  return json({ callId });
});
