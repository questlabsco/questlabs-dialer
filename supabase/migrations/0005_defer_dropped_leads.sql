-- A lead whose phone rang but was cut off because another line connected first ("dropped") used to
-- go straight back into the queue and was rung again within seconds, over and over. Now a lead that
-- this caller dialed during the current hold is not dialed again until the next day. Leads that were
-- claimed but never dialed (e.g. on Stop) still go straight back. Scheduled callbacks are unaffected
-- (they are timed by callback_at). The attempt count is unchanged: the lead was not really tried.
create or replace function public.release_leads(p_ids uuid[]) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  update public.leads l set
    locked_by = null,
    locked_at = null,
    next_call_at = case
      when l.status in ('new', 'no_answer') and exists (
        select 1 from public.calls c
         where c.lead_id = l.id
           and c.caller_id = v_me.id
           and c.direction = 'outbound'
           -- started_at comes from the app's clock: allow for some drift.
           and c.started_at >= coalesce(l.locked_at, now()) - interval '2 minutes'
      )
      then greatest(coalesce(l.next_call_at, '-infinity'::timestamptz), public._next_day_start(now()))
      else l.next_call_at
    end
  where l.id = any(coalesce(p_ids, '{}')) and l.locked_by = v_me.id;
end $$;
