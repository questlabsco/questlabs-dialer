-- Outbound pickups are joined to the caller's agent leg by telnyx-webhook (a Bridge issued FROM the
-- agent leg with park_after_unbridge = 'self'), not by Telnyx's bridge_on_answer: with
-- bridge_on_answer the agent leg was hung up whenever the lead's call ended, so every call after
-- the first pickup failed with "Your audio session is not connected".
--
-- Because the server now does the joining, two lines answering at once must be settled here:
-- telephony_answer_outbound marks the call answered, decides under a lock on the agent session
-- whether it gets the caller, and writes its `answered` event in the same transaction. The loser's
-- `answered` event is therefore always written after the winner's, which is what the app relies on
-- ("first pickup wins").

alter table public.agent_sessions add column if not exists bridged_call_id uuid;

create or replace function public.telephony_answer_outbound(p_call uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid;
  v_session uuid;
  s_status text;
  s_ccid text;
  s_bridged uuid;
  busy boolean;
begin
  select caller_id, agent_session_id into v_caller, v_session from public.telephony_calls where id = p_call;
  if not found then
    return jsonb_build_object('result', 'stale');
  end if;

  -- Serialize every pickup of this agent session.
  if v_session is not null then
    select status, call_control_id, bridged_call_id into s_status, s_ccid, s_bridged
      from public.agent_sessions where id = v_session for update;
  end if;

  update public.telephony_calls
     set status = 'answered', answered_at = coalesce(p_at, now())
   where id = p_call and status in ('dialing', 'ringing');
  if not found then
    return jsonb_build_object('result', 'stale');
  end if;

  if s_status is distinct from 'live' or s_ccid is null then
    return jsonb_build_object('result', 'no_agent');
  end if;

  -- The caller is busy while the call they were last joined to is neither ended nor being hung up.
  busy := s_bridged is not null and s_bridged <> p_call and exists (
    select 1 from public.telephony_calls t
     where t.id = s_bridged and t.status <> 'ended' and t.local_end_reason is null
  );

  if not busy then
    update public.agent_sessions set bridged_call_id = p_call where id = v_session;
  end if;

  if v_caller is not null then
    insert into public.telephony_events (caller_id, call_id, type)
    values (v_caller, p_call, 'answered')
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'result', case when busy then 'lost' else 'won' end,
    'agent_call_control_id', s_ccid
  );
end;
$$;
revoke all on function public.telephony_answer_outbound(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.telephony_answer_outbound(uuid, timestamptz) to service_role;
