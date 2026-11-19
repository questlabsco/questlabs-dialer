-- Server-side checkpoints shared by all callers.
alter table public.telephony_calls add column managed boolean not null default false, add column classify boolean not null default false,
  add column has_screening boolean not null default false, add column has_voicemail boolean not null default false,
  add column wait_for_greeting boolean not null default false,
  add column manual boolean not null default false, add column media_phase text;
create index telephony_phone_history on public.telephony_calls(to_number,created_at desc) where direction='outbound';
create index telephony_lead_history on public.telephony_calls(lead_id,created_at desc) where direction='outbound';
alter table public.telephony_events drop constraint telephony_events_type_check;
alter table public.telephony_events add check(type in ('ringing','answered','machine','ended','incoming','error','checking','screening','voicemail'));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('caller-messages','caller-messages',false,2000000,array['audio/wav']) on conflict do nothing;
create policy caller_message_files on storage.objects for all to authenticated
using (bucket_id='caller-messages' and (storage.foldername(name))[1]=auth.uid()::text)
with check (bucket_id='caller-messages' and name in (auth.uid()::text||'/screening.wav',auth.uid()::text||'/voicemail.wav'));

create or replace function public.next_phone_ring(l public.leads,p text,caller uuid) returns integer
language sql stable set search_path=public as $$
  select case when exists(select 1 from public.leads d where d.phones @> array[p] and d.status='do_not_call') then 0
    when count(*)=0 then 1
    when count(*)=1 and bool_and(t.lead_id=l.id::text and t.caller_id=caller and not t.manual and t.ring=1 and t.status='ended' and t.answered_at is null)
      and (select double_ring from public.settings where id=1) then 2 else 0 end
  from public.telephony_calls t where t.direction='outbound' and t.to_number=p
    and t.created_at >= greatest(public._day_start(now()),coalesce(l.callback_at,'-infinity'))
$$;
alter table public.leads add column retry_owner uuid references public.profiles(id) on delete set null,
  add column retry_until timestamptz;
create or replace function public.claim_next_leads(p_count integer) returns setof public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_n integer;
  v_now timestamptz := now();
  v_stale timestamptz := now() - interval '10 minutes';
  v_today timestamptz := public._day_start(now());
  v_lead public.leads;
begin
  v_me := public._require_caller();
  v_n := greatest(0, least(10, floor(coalesce(p_count, 0))::integer));
  if v_n = 0 then return; end if;

  for v_lead in
    select l.*
    from public.leads l
    where cardinality(l.phones) > 0
      and (l.retry_owner is null or l.retry_owner=v_me.id or l.retry_until<=v_now)
      and (l.locked_by is null or l.locked_at <= v_stale)
      and not exists (
        select 1 from public.telephony_calls t where t.lead_id=l.id::text and t.direction='outbound'
          and t.status <> 'ended' and t.created_at > now()-interval '65 minutes')
      and (
        (l.status = 'callback' and l.callback_owner = v_me.id
          and coalesce(l.callback_at, l.next_call_at, '-infinity'::timestamptz) <= v_now)
        or (
          (l.status in ('new', 'no_answer') or (l.status = 'callback' and l.callback_owner is null))
          and (l.assigned_to = v_me.id or l.assigned_to is null)
          and (l.next_call_at is null or l.next_call_at <= v_now)
        )
      )
    order by
      case when l.status = 'callback' and l.callback_owner = v_me.id then 1
           when l.assigned_to = v_me.id then 2
           else 3 end,
      case when l.status = 'callback' and l.callback_owner = v_me.id then l.callback_at end asc nulls first,
      coalesce(l.next_call_at, l.created_at),
      l.id
    for update of l skip locked
  loop
    -- The inexpensive priority sort runs before any per-phone history queries.
    if exists (select 1 from public.telephony_calls t where t.lead_id=v_lead.id::text
         and t.direction='outbound' and t.created_at>=greatest(v_today,coalesce(v_lead.callback_at,'-infinity'))
         and t.caller_id<>v_me.id) then continue; end if;
    if not exists(select from unnest(v_lead.phones) p where public.next_phone_ring(v_lead,p,v_me.id)>0) then
      -- Recheck an in-flight first attempt soon; skip exhausted destinations for the rest of today.
      if v_lead.status in ('new','no_answer') then
        update public.leads set next_call_at=case when exists(
          select from public.telephony_calls t where t.direction='outbound' and t.to_number=any(v_lead.phones)
            and t.status<>'ended' and t.created_at>v_now-interval '65 minutes')
          then v_now+interval '10 seconds' else public._next_day_start(v_now) end where id=v_lead.id;
      end if;
      continue;
    end if;
    update public.leads set locked_by = v_me.id, locked_at = v_now where id = v_lead.id returning * into v_lead;
    return next v_lead;
    v_n := v_n-1;
    exit when v_n=0;
  end loop;
end $$;
create or replace function public._workable(p_lead_id uuid, p_me public.profiles) returns public.leads
language plpgsql security definer set search_path = public as $$
declare
  v public.leads;
begin
  select * into v from public.leads where id = p_lead_id for update;
  if not found then
    raise exception using errcode = 'QL404', message = 'Lead not found.';
  end if;
  if p_me.role <> 'admin' and v.locked_by is not null and v.locked_by <> p_me.id then
    raise exception using errcode = 'QL403', message = 'This lead is held by another caller.';
  end if;
  return v;
end $$;
create or replace function public.save_disposition(p_call_id uuid, p_lead_id uuid, p_disposition text,
                                                   p_notes text, p_callback_at timestamptz) returns public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_call public.calls;
  v_caller uuid;
  v public.leads;
begin
  v_me := public._me();
  select * into v_call from public.calls where id = p_call_id for update;
  if not found then
    raise exception using errcode = 'QL404', message = 'Call not found.';
  end if;
  if v_me.role <> 'admin' and v_call.caller_id is distinct from v_me.id then
    raise exception using errcode = 'QL403', message = 'You can only disposition your own calls.';
  end if;
  if v_call.lead_id is distinct from p_lead_id then
    raise exception using errcode='QL409',message='Call and lead do not match.';
  end if;
  if v_call.disposition is not null then
    if v_call.disposition is distinct from p_disposition then
      raise exception using errcode='QL409',message='This call already has an outcome.';
    end if;
    select * into v from public.leads where id=p_lead_id;
    return v;
  end if;
  perform public._workable(p_lead_id, v_me);
  if p_disposition is null or p_disposition not in
     ('booked','callback','not_interested','wrong_number','do_not_call','voicemail','hung_up') then
    raise exception using errcode = 'QL400', message = 'Unknown outcome.';
  end if;
  if p_disposition = 'callback' and p_callback_at is null then
    raise exception using errcode = 'QL400', message = 'Pick a callback time.';
  end if;

  update public.calls set disposition = p_disposition, notes = coalesce(p_notes, '') where id = p_call_id;
  v_caller := coalesce(v_call.caller_id, v_me.id);

  if p_disposition in ('voicemail', 'hung_up') then
    return public._apply_missed_day(p_lead_id, v_caller);
  end if;

  update public.leads set
    last_called_at = now(),
    last_called_by = v_caller,
    locked_by      = null,
    locked_at      = null,
    status         = p_disposition,
    callback_at    = case when p_disposition = 'callback' then p_callback_at end,
    callback_owner = case when p_disposition = 'callback' then v_caller end,
    next_call_at   = case when p_disposition = 'callback' then p_callback_at end
  where id = p_lead_id
  returning * into v;
  return v;
end $$;
create function public.claim_dial_batch(p_count integer) returns setof jsonb
language sql volatile security definer set search_path=public as $$
  select to_jsonb(l)||jsonb_build_object('attempt_plan',(select jsonb_object_agg(p,jsonb_build_object('ring',public.next_phone_ring(l,p,auth.uid()),'from',
    (select t.from_number from public.telephony_calls t where t.direction='outbound' and t.to_number=p order by t.created_at desc limit 1)))
    from unnest(l.phones) p)) from public.claim_next_leads(p_count) l
$$;

create or replace function public.set_presence(p_status text, p_detail text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  if v_me.role <> 'caller' then return; end if;
  if p_status is null or p_status not in ('offline','idle','dialing','on_call','wrap_up','paused') then
    raise exception using errcode = 'QL400', message = 'Unknown presence status.';
  end if;
  if p_status in ('on_call','wrap_up','dialing') then
    update public.leads set locked_at=now() where locked_by=v_me.id and locked_at<now()-interval '1 minute';
  end if;
  insert into public.presence as pr (caller_id, status, since, detail, updated_at)
  values (v_me.id, p_status, now(), p_detail, now())
  on conflict (caller_id) do update set
    since = case when pr.status = excluded.status and pr.updated_at > now() - interval '90 seconds'
                 then pr.since else now() end,
    status = excluded.status,
    detail = excluded.detail,
    updated_at = now();
end $$;
create or replace function public.release_leads(p_ids uuid[]) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  update public.leads set locked_by = null, locked_at = null
  where id = any(coalesce(p_ids, '{}')) and locked_by = v_me.id;
end $$;
create or replace function public.import_leads(p_list_id uuid, p_new_list_name text, p_rows jsonb,
                                               p_assign jsonb, p_rr_offset integer)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_mode text := coalesce(p_assign ->> 'mode', 'pool');
  v_one uuid;
  v_callers uuid[];
  v_list uuid;
  v_name text;
  r jsonb;
  p text;
  v_phones text[];
  v_assigned uuid;
  v_imported integer := 0;
  v_dups integer := 0;
  v_invalid integer := 0;
  v_rr integer := greatest(0, coalesce(p_rr_offset, 0));
  v_now timestamptz := now();
begin
  perform public._require_admin();
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = 'QL400', message = 'Rows must be a list.';
  end if;

  if v_mode = 'caller' then
    v_one := nullif(p_assign ->> 'callerId', '')::uuid;
    if v_one is null or not exists (select 1 from public.profiles where id = v_one and role = 'caller' and active) then
      raise exception using errcode = 'QL400', message = 'Choose an active caller.';
    end if;
  elsif v_mode = 'round_robin' then
    select array_agg(x::uuid order by ord) into v_callers
    from jsonb_array_elements_text(coalesce(p_assign -> 'callerIds', '[]'::jsonb)) with ordinality as t(x, ord);
    if v_callers is null or cardinality(v_callers) = 0 then
      raise exception using errcode = 'QL400', message = 'Choose at least one caller.';
    end if;
    if exists (select 1 from unnest(v_callers) c
               where not exists (select 1 from public.profiles where id = c and role = 'caller' and active)) then
      raise exception using errcode = 'QL400', message = 'Round robin includes a user who is not an active caller.';
    end if;
  elsif v_mode <> 'pool' then
    raise exception using errcode = 'QL400', message = 'Unknown assignment mode.';
  end if;

  if p_list_id is not null then
    if not exists (select 1 from public.lead_lists where id = p_list_id) then
      raise exception using errcode = 'QL404', message = 'List not found.';
    end if;
    v_list := p_list_id;
  else
    v_name := btrim(coalesce(p_new_list_name, ''));
    if v_name = '' then
      raise exception using errcode = 'QL400', message = 'List name is required.';
    end if;
    insert into public.lead_lists (name) values (v_name) returning id into v_list;
  end if;

  -- One import at a time, so dedupe on primary phone is exact.
  perform pg_advisory_xact_lock(hashtext('questlabs.import_leads'));

  for r in select value from jsonb_array_elements(p_rows) loop
    v_phones := '{}';
    if jsonb_typeof(r -> 'phones') = 'array' then
      for p in select jsonb_array_elements_text(r -> 'phones') loop
        p := btrim(p);
        if p ~ '^\+[1-9][0-9]{7,14}$' and not (p = any(v_phones)) then
          v_phones := v_phones || p;
        end if;
        exit when cardinality(v_phones) = 3;
      end loop;
    end if;
    v_name := btrim(coalesce(r ->> 'businessName', ''));
    if v_name = '' or cardinality(v_phones) = 0 then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    if exists (select 1 from public.leads where phones && v_phones) then
      v_dups := v_dups + 1;
      continue;
    end if;
    v_assigned := case v_mode
                    when 'caller' then v_one
                    when 'round_robin' then v_callers[((v_rr + v_imported) % cardinality(v_callers)) + 1]
                    else null end;
    insert into public.leads (list_id, business_name, contact_name, phones, email, city, state, notes, assigned_to, created_at)
    values (
      v_list, v_name,
      btrim(coalesce(r ->> 'contactName', '')),
      v_phones,
      btrim(coalesce(r ->> 'email', '')),
      btrim(coalesce(r ->> 'city', '')),
      left(upper(btrim(coalesce(r ->> 'state', ''))), 2),
      btrim(coalesce(r ->> 'notes', '')),
      v_assigned,
      v_now + make_interval(secs => v_imported / 1000000.0)
    );
    v_imported := v_imported + 1;
  end loop;

  return jsonb_build_object('listId', v_list, 'imported', v_imported, 'duplicates', v_dups, 'invalid', v_invalid);
end $$;
create function public.guard_phone_attempt() returns trigger language plpgsql set search_path=public as $$
declare l public.leads;
begin
  if new.direction <> 'outbound' then return new; end if;
  select exists(select from storage.objects where bucket_id='caller-messages' and name=new.caller_id::text||'/screening.wav'),
         exists(select from storage.objects where bucket_id='caller-messages' and name=new.caller_id::text||'/voicemail.wav')
    into new.has_screening,new.has_voicemail;
  new.classify := new.classify or new.has_screening or new.has_voicemail;
  new.has_voicemail := new.has_voicemail and (new.manual or new.ring=2 or not (select double_ring from public.settings where id=1));
  new.wait_for_greeting := new.has_screening or new.has_voicemail or
    coalesce((select screening_intro<>'' from public.settings where id=1), false);
  perform pg_advisory_xact_lock(hashtextextended(new.to_number,0));
  if exists(select 1 from public.telephony_calls t where t.direction='outbound' and t.to_number=new.to_number
    and t.status<>'ended' and t.created_at>now()-interval '65 minutes') then
    raise exception using errcode='QL409',message='This number has a call in progress.';
  end if;
  if exists(select 1 from public.leads where phones @> array[new.to_number] and status='do_not_call') then
    raise exception using errcode='QL409',message='This number is marked do not call.';
  end if;
  if new.lead_id not like 'unknown:%' then
    select * into l from public.leads where id=new.lead_id::uuid for update;
  end if;
  if new.agent_session_id is not null and not exists(select from public.agent_sessions where id=new.agent_session_id and caller_id=new.caller_id and status='live' for share) then
    raise exception using errcode='QL409',message='The audio session has ended.';
  end if;
  if new.manual and exists(select from public.telephony_calls t where t.direction='outbound'
    and (t.to_number=new.to_number or t.lead_id=new.lead_id) and t.caller_id<>new.caller_id
    and t.created_at>=greatest(public._day_start(now()),coalesce(l.callback_at,'-infinity'))) then
    raise exception using errcode='QL409',message='A teammate already called this lead today.';
  end if;
  if not new.manual then
    if l.locked_by is distinct from new.caller_id or not (new.to_number=any(l.phones))
      or l.status not in ('new','no_answer','callback') or coalesce(l.next_call_at,'-infinity')>now()
      or public.next_phone_ring(l,new.to_number,new.caller_id)<>new.ring then
      raise exception using errcode='QL409',message='This attempt is no longer available.';
    end if;
  elsif exists(select 1 from public.leads where phones @> array[new.to_number] and locked_by<>new.caller_id and locked_at>now()-interval '10 minutes') then
    raise exception using errcode='QL409',message='Another caller holds this lead.';
  end if;
  if l.id is not null and not new.manual then
    update public.leads set retry_owner=new.caller_id,retry_until=public._next_day_start(now()) where id=l.id;
  end if;
  return new;
end $$;
create trigger guard_phone_attempt before insert on public.telephony_calls for each row execute function public.guard_phone_attempt();

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
   where id = p_call and status in ('dialing', 'ringing') and local_end_reason is null and media_phase is distinct from 'voicemail';
  if not found then
    if s_bridged = p_call and exists(select 1 from public.telephony_calls where id=p_call and status='answered' and local_end_reason is null) then
      return jsonb_build_object('result','won','agent_call_control_id',s_ccid);
    end if;
    return jsonb_build_object('result','stale');
  end if;

  if s_status is distinct from 'live' or s_ccid is null then
    return jsonb_build_object('result', 'no_agent');
  end if;

  -- The caller is busy while the call they were last joined to is neither ended nor being hung up.
  busy := s_bridged is not null and s_bridged <> p_call and exists (
    select 1 from public.telephony_calls t
     where t.id = s_bridged and t.status <> 'ended'
  );

  if not busy then
    update public.agent_sessions set bridged_call_id = p_call where id = v_session;
  end if;

  -- Publish the human pickup only after the bridge succeeds.

  return jsonb_build_object(
    'result', case when busy then 'lost' else 'won' end,
    'agent_call_control_id', s_ccid
  );
end;
$$;

-- Only the desktop that owns an audio session may replace or refresh it.
alter table public.agent_sessions add column lease_until timestamptz not null default now()+interval '90 seconds';
create function public.open_audio_session(p_caller uuid,p_replace uuid) returns jsonb
language plpgsql security definer set search_path=public as $$
declare sid uuid; old_legs text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_caller::text,1));
  if exists(select 1 from public.agent_sessions s where s.caller_id=p_caller and s.status<>'ended'
    and s.id is distinct from p_replace and (s.lease_until>now() or exists(
      select 1 from public.telephony_calls t where t.agent_session_id=s.id and t.status='answered'
        and t.created_at>now()-interval '65 minutes'))) then
    raise exception using errcode='QL409',message='This account already has a dialer session open.';
  end if;
  with retired as (update public.agent_sessions set status='ended',ended_at=now()
    where caller_id=p_caller and status<>'ended' returning call_control_id)
    select array_agg(call_control_id) filter(where call_control_id is not null) into old_legs from retired;
  insert into public.agent_sessions(caller_id,status) values(p_caller,'pending') returning id into sid;
  return jsonb_build_object('sessionId',sid,'retired',coalesce(old_legs,'{}'));
end $$;
revoke all on function public.open_audio_session(uuid,uuid) from public,anon,authenticated;
grant execute on function public.open_audio_session(uuid,uuid) to service_role;

-- Start the CRM record in the reservation transaction, before sending anything to the carrier.
create function public.log_reserved_call() returns trigger language plpgsql set search_path=public as $$
begin
  insert into public.calls(id,provider_call_id,caller_id,lead_id,direction,from_number,to_number,ring,started_at)
    values(new.id,new.id::text,new.caller_id,case when new.lead_id not like 'unknown:%' then new.lead_id::uuid end,
      'outbound',new.from_number,new.to_number,new.ring,new.created_at);
  return new;
end $$;
create trigger log_reserved_call after insert on public.telephony_calls for each row
when(new.managed and new.direction='outbound') execute function public.log_reserved_call();

-- Persist the terminal event with the status change, including retries and local reconciliations.
create function public.outbound_ended_event() returns trigger language plpgsql set search_path=public as $$
begin
  if new.managed then
    update public.calls set ended_at=coalesce(ended_at,new.ended_at,now()),
      result=case when new.media_phase='voicemail' then 'voicemail'
        when result is not null then result
        when new.end_reason in ('busy','bad_number','failed') then new.end_reason
        when new.answered_at is not null then 'dropped_pickup'
        else 'no_answer' end
      where id=new.id;
  end if;
  insert into public.telephony_events(caller_id,call_id,type,reason)
    values(new.caller_id,new.id,'ended',case when new.media_phase='voicemail' then 'voicemail' else new.end_reason end)
    on conflict do nothing;
  return new;
end $$;
create trigger outbound_ended_event after update on public.telephony_calls for each row
when(new.direction='outbound' and old.status<>'ended' and new.status='ended' and new.caller_id is not null)
execute function public.outbound_ended_event();
revoke all on function public.claim_dial_batch(integer) from public,anon;
grant execute on function public.claim_dial_batch(integer) to authenticated;
