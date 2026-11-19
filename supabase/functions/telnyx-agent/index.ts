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
      await requireConfig();
      const {data,error}=await db.rpc('open_audio_session',{p_caller:user.id,p_replace:body.sessionId ?? null});
      if(error) throw new HttpError(error.code==='QL409'?409:500,error.message,'session_error');
      await Promise.all((data.retired as string[]).map(id=>callCommand(id,'hangup',{}).catch(()=>false)));
      return json({sessionId:data.sessionId});
    }
    case 'heartbeat': {
      const {data,error}=await db.from('agent_sessions').update({lease_until:new Date(Date.now()+90000).toISOString()})
        .eq('id',body.sessionId).eq('caller_id',user.id).eq('status','live').select('id');
      if(error || !data?.length) throw new HttpError(409,'The audio session has ended.','no_agent_leg');
      return json({ok:true});
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
