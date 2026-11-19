// telnyx-dial: places one outbound lead call and returns { callId } at once (our own uuid).
// Body: { to, from, leadId, ring, ringSeconds?, detectMachine?, record? } (Telephony.DialRequest).
// The lead leg is joined to the caller's agent leg by telnyx-webhook when the lead picks up (a
// Bridge from the agent leg that parks it again afterwards); a second pickup is settled there too.
// Events arrive via telnyx-webhook.
import { buildDialBody, isInvalidDestination, isUsE164 } from '../_shared/telnyxLogic.ts';
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
  manual?: boolean;
  sessionId?: string;
}

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<DialBody>(req);
  const db = adminClient();

  if (!isUsE164(body.to)) throw new HttpError(400, 'The lead number must be a US number in +1XXXXXXXXXX format.', 'invalid');
  if (typeof body.from !== 'string') throw new HttpError(400, 'A from number is required.', 'invalid');
  if (typeof body.leadId !== 'string' || !body.leadId) throw new HttpError(400, 'leadId is required.', 'invalid');
  const ring = body.ring === 2 ? 2 : 1;

  // These five lookups do not depend on each other, so they run together: every call waits on them.
  // Ringing legs older than 15 min are ignored so a lost webhook can never block a caller forever.
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const [cfg, settings, { data: fromRow }, initialAgent, { count, error: countError }] = await Promise.all([
    requireConfig(),
    loadSettings(),
    db.from('phone_numbers').select('id').eq('number', body.from).eq('active', true).maybeSingle(),
    liveAgentSession(user.id),
    db
      .from('telephony_calls')
      .select('id', { count: 'exact', head: true })
      .eq('caller_id', user.id)
      .eq('direction', 'outbound')
      .in('status', ['dialing', 'ringing'])
      .gte('created_at', since),
  ]);
  if (!fromRow) throw new HttpError(400, 'That outbound number is not one of our active numbers.', 'invalid');
  if (countError) throw countError;
  let agent=initialAgent;
  // WebRTC can become active just before the corresponding server webhook commits.
  if (!agent && body.sessionId) {
    for (const delay of [150,350,650]) {
      await new Promise(resolve=>setTimeout(resolve,delay));
      agent=await liveAgentSession(user.id);
      if(agent) break;
    }
  }
  if (!agent || (body.sessionId && agent.id !== body.sessionId)) throw new HttpError(409, 'Your audio session is not connected. Press Start again.', 'no_agent_leg');

  // Cap simultaneous ringing legs (lines + 1 for the double-ring overlap).
  if ((count ?? 0) >= settings.lines_per_caller + 1) {
    throw new HttpError(429, 'Too many lines are ringing at once.', 'too_many_lines');
  }

  const callId = crypto.randomUUID();
  const record = typeof body.record === 'boolean' ? body.record : settings.record_calls;
  const detectMachine = typeof body.detectMachine === 'boolean' ? body.detectMachine : settings.skip_voicemail;

  const { data: attempt, error: insErr } = await db.from('telephony_calls').insert({
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
    managed: !!body.sessionId,
    manual: body.manual === true,
    classify: detectMachine,
  }).select('classify,has_screening').single();
  if (insErr?.code === 'QL409') throw new HttpError(409, insErr.message, 'attempt_conflict');
  if (insErr || !attempt) throw new HttpError(500, 'Could not start the call.', 'internal');

  const dialBody = buildDialBody({
    callId,
    voiceAppId: cfg.voice_app_id,
    to: body.to,
    from: body.from,
    ringSeconds: typeof body.ringSeconds === 'number' ? body.ringSeconds : settings.ring_seconds,
    detectMachine: attempt.classify,
    screeningIntro: attempt.has_screening || settings.screening_intro !== '',
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
    if (e instanceof TelnyxError && isInvalidDestination(e.codes, e.message)) {
      const { error } = await db.from('telephony_calls').update({status:'ended', end_reason:'bad_number', ended_at:new Date().toISOString()}).eq('id',callId);
      if (error) throw error;
      return json({callId});
    }
    // A network error can follow acceptance. Only a definite refusal releases the number.
    if (e instanceof TelnyxError && e.status >= 400 && e.status < 500 && e.status !== 408) {
      await db.from('telephony_calls').update({status:'ended',end_reason:'failed',ended_at:new Date().toISOString()}).eq('id',callId);
    }
    if (e instanceof TelnyxError) {
      const status = e.status === 429 ? 429 : 502;
      throw new HttpError(status, `Telnyx refused the call: ${e.message}`, 'provider_error');
    }
    throw e;
  }

  return json({ callId });
});
