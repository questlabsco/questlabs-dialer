-- 'human': the voicemail check confirmed a person on a call the caller was already joined to.
-- The app then drops its other ringing lines (until then they keep ringing, so a voicemail pickup
-- does not cost the second lead).
alter table public.telephony_events drop constraint if exists telephony_events_type_check;
alter table public.telephony_events add constraint telephony_events_type_check
  check (type in ('ringing','answered','machine','ended','incoming','error','checking','screening','voicemail','human'));
drop index if exists public.telephony_events_once;
create unique index telephony_events_once on public.telephony_events (call_id, type)
  where call_id is not null and type in ('ended','answered','ringing','machine','incoming','human');
