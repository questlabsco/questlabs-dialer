// telnyx-agent: manages the caller's long-lived WebRTC "agent leg".
//   { action: 'start' }               -> { sessionId }  (the app then places its parked WebRTC call
//                                         carrying the session id; telnyx-webhook links the leg)
//   { action: 'status', sessionId }   -> { status: 'pending' | 'live' | 'ended' }
//   { action: 'stop', sessionId? }    -> { ok: true }   (hangs up the agent leg(s))
// Outbound-dialer pattern (developers.telnyx.com/docs/voice/webrtc/use-cases/outbound-dialer): the
// WebRTC client calls out on a credential connection with call parking enabled; the parked leg is
// then bridged to PSTN legs with Call Control.
import { adminClient, callCommand, HttpError, json, readJson, requireConfig, requireUser, serve } from '../_shared/telnyx.ts';

async function endSessions(callerId: string, onlyId?: string): Promise<void> {
  const db = adminClient();
  let q = db.from('agent_sessions').select('id, call_control_id').eq('caller_id', callerId).neq('status', 'ended');
  if (onlyId) q = q.eq('id', onlyId);
  const { data } = await q;
  for (const s of data ?? []) {
    if (s.call_control_id) {
      try {
        await callCommand(s.call_control_id as string, 'hangup', {});
      } catch (e) {
        console.error('agent hangup failed:', e instanceof Error ? e.message : String(e));
      }
    }
    await db
      .from('agent_sessions')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', s.id as string);
  }
}

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ action?: string; sessionId?: string }>(req);
  const db = adminClient();

  switch (body.action) {
    case 'start': {
      // A caller has one agent leg at a time: close any previous one (e.g. after a crash).
      await Promise.all([requireConfig(), endSessions(user.id)]);
      const { data, error } = await db
        .from('agent_sessions')
        .insert({ caller_id: user.id, status: 'pending' })
        .select('id')
        .single();
      if (error || !data) throw new HttpError(500, 'Could not start an audio session.', 'internal');
      return json({ sessionId: data.id });
    }
    case 'status': {
      if (!body.sessionId) throw new HttpError(400, 'sessionId is required.', 'invalid');
      const { data } = await db
        .from('agent_sessions')
        .select('status')
        .eq('id', body.sessionId)
        .eq('caller_id', user.id)
        .maybeSingle();
      return json({ status: data?.status ?? 'ended' });
    }
    case 'stop': {
      await endSessions(user.id, body.sessionId || undefined);
      return json({ ok: true });
    }
    default:
      throw new HttpError(400, 'Unknown action.', 'invalid');
  }
});
