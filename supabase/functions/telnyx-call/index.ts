// telnyx-call: commands on one of the signed-in caller's calls (our call id).
//   { action: 'hangup',  callId }  -> ends a ringing or answered call ('ended' hangup_local follows)
//   { action: 'answer',  callId }  -> accepts an inbound call; it is bridged to the agent leg when
//                                     Telnyx reports call.answered ('answered' follows)
//   { action: 'decline', callId }  -> declines an inbound call politely ('ended' hangup_local follows)
//   { action: 'timeout', callId }  -> the app gave up ringing an inbound call ('ended' no_answer follows)
// Response: { ok: true, alreadyEnded?: true }.
// Inbound calls are known to the app by their OFFER ids (see _shared/telnyxInbound.ts); those are
// handled by handleOffer. An offer that rings the app directly is answered on the device (the
// WebRTC SDK), not here: 'answer' on it returns 409 { code: 'answer_on_device' }.
import { encodeClientState, parentOfOfferTag } from '../_shared/telnyxLogic.ts';
import { advanceInbound, claimInbound, endOffer, isOfferRow, isRingOffer, loadCall, type InboundRow } from '../_shared/telnyxInbound.ts';
import {
  adminClient,
  callCommand,
  emitEvent,
  HttpError,
  json,
  liveAgentSession,
  readJson,
  requireUser,
  serve,
} from '../_shared/telnyx.ts';

serve(async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ action?: string; callId?: string }>(req);
  if (typeof body.callId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.callId)) {
    throw new HttpError(400, 'callId is required.', 'invalid');
  }
  const db = adminClient();
  const { data: call } = await db
    .from('telephony_calls')
    .select('*')
    .eq('id', body.callId)
    .maybeSingle();
  if (!call || call.caller_id !== user.id) throw new HttpError(404, 'Call not found.', 'not_found');
  if (call.status === 'ended') return json({ ok: true, alreadyEnded: true });
  if (isOfferRow(call as InboundRow)) return handleOffer(call as InboundRow, user.id, body.action);
  const ccid = call.call_control_id as string | null;

  switch (body.action) {
    case 'confirm_end': {
      if (!ccid) throw new HttpError(409,'Waiting for the provider call ID.','pending');
      // A fresh command distinguishes an already-ended leg from a lost hangup request.
      const sent = await callCommand(ccid,'hangup',{});
      if (!sent) await endWithoutTelnyx(call.id,user.id,'hangup_local');
      return json({ok:true,alreadyEnded:!sent});
    }
    case 'hangup': {
      await db.from('telephony_calls').update({ local_end_reason: 'hangup_local' }).eq('id', call.id);
      if (!ccid) {
        throw new HttpError(409,'Waiting for the provider call ID.','pending');
      }
      const sent = await callCommand(ccid, 'hangup', { command_id: `hangup-${call.id}` });
      if (!sent) await endWithoutTelnyx(call.id as string, user.id, 'hangup_local');
      return json({ ok: true, alreadyEnded: !sent || undefined });
    }

    case 'answer': {
      if (call.direction !== 'inbound' || call.status !== 'incoming' || !ccid) {
        throw new HttpError(409, 'This call can no longer be answered.', 'conflict');
      }
      const agent = await liveAgentSession(user.id);
      if (!agent) throw new HttpError(409, 'Your audio session is not connected.', 'no_agent_leg');
      const { data: claimed } = await db
        .from('telephony_calls')
        .update({ status: 'answering', agent_session_id: agent.id })
        .eq('id', call.id)
        .eq('status', 'incoming')
        .select('id');
      if (!claimed?.length) throw new HttpError(409, 'This call can no longer be answered.', 'conflict');
      const sent = await callCommand(ccid, 'answer', {
        client_state: encodeClientState({ v: 1, k: 'in', id: call.id as string, st: 'bridge' }),
        command_id: `answer-${call.id}`,
      });
      if (!sent) return json({ ok: true, alreadyEnded: true });
      return json({ ok: true });
    }

    case 'decline':
    case 'timeout': {
      if (call.direction !== 'inbound') throw new HttpError(400, 'Only inbound calls can be declined.', 'invalid');
      const reason = body.action === 'decline' ? 'hangup_local' : 'no_answer';
      const { data: claimed } = await db
        .from('telephony_calls')
        .update({ status: 'declining', local_end_reason: reason })
        .eq('id', call.id)
        .eq('status', 'incoming')
        .select('id');
      if (!claimed?.length) return json({ ok: true, alreadyEnded: true });
      if (!ccid) {
        await endWithoutTelnyx(call.id as string, user.id, reason);
        return json({ ok: true });
      }
      // Answer, say the polite message (on call.answered), then hang up (on call.speak.ended).
      const sent = await callCommand(ccid, 'answer', {
        client_state: encodeClientState({ v: 1, k: 'in', id: call.id as string, st: 'polite' }),
        command_id: `polite-${call.id}`,
      });
      if (!sent) return json({ ok: true, alreadyEnded: true });
      return json({ ok: true });
    }

    default:
      throw new HttpError(400, 'Unknown action.', 'invalid');
  }
});

async function handleOffer(offer: InboundRow, userId: string, action: string | undefined): Promise<Response> {
  const db = adminClient();
  const parentId = parentOfOfferTag(offer.call_session_id)!;
  switch (action) {
    case 'answer': {
      if (offer.status !== 'incoming') throw new HttpError(409, 'This call can no longer be answered.', 'conflict');
      if (isRingOffer(offer)) throw new HttpError(409, 'Answer this call in the app.', 'answer_on_device');
      const agent = await liveAgentSession(userId);
      if (!agent) throw new HttpError(409, 'Your audio session is not connected.', 'no_agent_leg');
      const won = await claimInbound(offer, agent.id);
      if (!won) {
        await endOffer(offer, 'hangup_remote');
        return json({ ok: true, alreadyEnded: true });
      }
      return json({ ok: true });
    }
    case 'decline':
    case 'timeout': {
      if (offer.status !== 'incoming') return json({ ok: true, alreadyEnded: offer.status === 'ended' || undefined });
      await endOffer(offer, action === 'decline' ? 'hangup_local' : 'no_answer');
      // Declining hands the call on (to everyone else, or the missed-call message) straight away.
      await advanceInbound(parentId, {});
      return json({ ok: true });
    }
    case 'hangup': {
      if (offer.status === 'incoming') {
        await endOffer(offer, 'hangup_local');
        await advanceInbound(parentId, {});
        return json({ ok: true });
      }
      const parent = await loadCall(parentId);
      if (parent && parent.status !== 'ended') {
        await db.from('telephony_calls').update({ local_end_reason: 'hangup_local' }).eq('id', parentId);
        if (parent.call_control_id) await callCommand(parent.call_control_id, 'hangup', { command_id: `hangup-${parentId}` });
      }
      // Ends the offer (and its ring leg) for the app even if the person's leg is already gone.
      await endOffer(offer, 'hangup_local');
      return json({ ok: true });
    }
    default:
      throw new HttpError(400, 'Unknown action.', 'invalid');
  }
}

/** Marks a call ended and emits the terminal event when Telnyx will not send a hangup webhook. */
async function endWithoutTelnyx(callId: string, callerId: string, reason: 'hangup_local' | 'no_answer'): Promise<void> {
  const db = adminClient();
  const { data } = await db
    .from('telephony_calls')
    .update({ status: 'ended', end_reason: reason, ended_at: new Date().toISOString() })
    .eq('id', callId)
    .neq('status', 'ended')
    .select('id');
  if (data?.length) await emitEvent({ callerId, callId, type: 'ended', reason });
}
