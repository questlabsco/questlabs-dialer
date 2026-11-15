-- =============================================================================
-- Quest Labs Dialer — core schema, security rules and server-side functions.
--
-- Paste this whole file into the Supabase SQL editor of a FRESH project and run
-- it once (it is written to be re-runnable). It runs as `postgres`.
--
-- Error convention: every function raises exceptions with a custom SQLSTATE so the
-- client can map them to ApiError codes:
--   QL401 not_authenticated   QL403 permission_denied   QL404 not_found
--   QL400 invalid             QL409 conflict            QL423 account deactivated
--
-- "Today" / day boundaries use settings.time_zone (default America/Chicago).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null default '',
  full_name   text not null default '',
  role        text not null default 'caller' check (role in ('admin', 'caller')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_email_key on public.profiles (lower(email)) where email <> '';
create index if not exists profiles_role_active_idx on public.profiles (role, active);

create table if not exists public.settings (
  id                 smallint primary key default 1 check (id = 1),
  lines_per_caller   integer not null default 2    check (lines_per_caller between 1 and 5),
  ring_seconds       integer not null default 22   check (ring_seconds between 5 and 60),
  double_ring        boolean not null default true,
  retry_days         integer not null default 3    check (retry_days >= 1),
  skip_voicemail     boolean not null default true,
  calendly_url       text    not null default 'https://calendly.com/questlabsco/questlabs',
  script             text    not null default '',
  default_daily_cap  integer not null default 100  check (default_daily_cap >= 0),
  ramp_days          integer not null default 14   check (ramp_days >= 0),
  ramp_start_cap     integer not null default 25   check (ramp_start_cap >= 0),
  record_calls       boolean not null default true,
  -- Addition (not in the TypeScript Settings type): business time zone for "today".
  time_zone          text    not null default 'America/Chicago'
);

create table if not exists public.lead_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  created_at  timestamptz not null default now()
);
create index if not exists lead_lists_created_idx on public.lead_lists (created_at desc);

create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  list_id         uuid not null references public.lead_lists (id) on delete cascade,
  business_name   text not null check (length(btrim(business_name)) > 0),
  contact_name    text not null default '',
  -- 1–3 numbers in E.164 (0 only after every phone was reported bad).
  phones          text[] not null default '{}' check (cardinality(phones) <= 3),
  primary_phone   text generated always as (phones[1]) stored,
  email           text not null default '',
  city            text not null default '',
  state           text not null default '',
  notes           text not null default '',
  status          text not null default 'new' check (status in
                    ('new','no_answer','callback','booked','not_interested','wrong_number','bad_number','do_not_call','exhausted')),
  assigned_to     uuid references public.profiles (id) on delete set null,
  attempt_days    integer not null default 0 check (attempt_days >= 0),
  last_called_at  timestamptz,
  last_called_by  uuid references public.profiles (id) on delete set null,
  next_call_at    timestamptz,
  callback_at     timestamptz,
  callback_owner  uuid references public.profiles (id) on delete set null,
  locked_by       uuid references public.profiles (id) on delete set null,
  locked_at       timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists leads_list_idx on public.leads (list_id);
create index if not exists leads_primary_phone_idx on public.leads (primary_phone);
create index if not exists leads_phones_gin on public.leads using gin (phones);
-- Claiming: dialable leads by assignment, ordered by due time.
create index if not exists leads_claim_idx on public.leads (assigned_to, (coalesce(next_call_at, created_at)))
  where status in ('new', 'no_answer', 'callback');
create index if not exists leads_callback_owner_idx on public.leads (callback_owner, callback_at) where status = 'callback';
create index if not exists leads_locked_by_idx on public.leads (locked_by) where locked_by is not null;
create index if not exists leads_created_idx on public.leads (created_at desc);

create table if not exists public.calls (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid references public.leads (id) on delete set null,
  -- Denormalised lead.list_id at call time. No FK on purpose: history outlives deleted lists.
  list_id           uuid,
  caller_id         uuid references public.profiles (id) on delete set null,
  direction         text not null check (direction in ('outbound', 'inbound')),
  from_number       text not null,
  to_number         text not null,
  ring              smallint not null default 1 check (ring in (1, 2)),
  started_at        timestamptz not null default now(),
  answered_at       timestamptz,
  ended_at          timestamptz,
  talk_seconds      integer not null default 0 check (talk_seconds >= 0),
  result            text check (result is null or result in
                      ('answered','no_answer','voicemail','busy','failed','bad_number','dropped','dropped_pickup','missed_inbound')),
  disposition       text check (disposition is null or disposition in
                      ('booked','callback','not_interested','wrong_number','do_not_call','voicemail','hung_up')),
  notes             text not null default '',
  recording_url     text,
  provider_call_id  text
);
create index if not exists calls_caller_started_idx on public.calls (caller_id, started_at desc);
create index if not exists calls_from_started_idx on public.calls (from_number, started_at desc);
create index if not exists calls_started_idx on public.calls (started_at desc);
create index if not exists calls_lead_started_idx on public.calls (lead_id, started_at desc);
create index if not exists calls_provider_call_idx on public.calls (provider_call_id);

create table if not exists public.phone_numbers (
  id           uuid primary key default gen_random_uuid(),
  number       text not null unique check (number ~ '^\+[1-9][0-9]{7,14}$'),
  label        text not null default '',
  active       boolean not null default true,
  daily_cap    integer not null check (daily_cap >= 1),   -- defaulted from settings by trigger
  added_at     timestamptz not null default now(),
  provider_id  text
);
create unique index if not exists phone_numbers_provider_id_key on public.phone_numbers (provider_id) where provider_id is not null;

create table if not exists public.presence (
  caller_id   uuid primary key references public.profiles (id) on delete cascade,
  status      text not null default 'offline' check (status in ('offline','idle','dialing','on_call','wrap_up','paused')),
  since       timestamptz not null default now(),
  detail      text,
  updated_at  timestamptz not null default now()
);

-- A user's personal copy of the call script (no row = they see settings.script).
create table if not exists public.caller_scripts (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  script      text not null check (length(btrim(script)) > 0 and length(script) <= 20000),
  updated_at  timestamptz not null default now()
);

-- Seed the single settings row from DEFAULT_SETTINGS.
insert into public.settings (id) values (1) on conflict (id) do nothing;
-- Rows created by an earlier run of this file still carry the old placeholder link.
alter table public.settings alter column calendly_url set default 'https://calendly.com/questlabsco/questlabs';
update public.settings set calendly_url = 'https://calendly.com/questlabsco/questlabs'
  where id = 1 and calendly_url = 'https://calendly.com/your-link';

-- -----------------------------------------------------------------------------
-- Identity helpers
-- -----------------------------------------------------------------------------

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

create or replace function public.is_active_caller() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'caller');
$$;

-- True when the request carries the service-role JWT (Edge Functions with the service key).
create or replace function public._is_service() returns boolean
language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$$;

-- The signed-in, active profile, or an exception.
create or replace function public._me() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
begin
  if auth.uid() is null then
    raise exception using errcode = 'QL401', message = 'Please sign in.';
  end if;
  select * into v from public.profiles where id = auth.uid();
  if not found then
    raise exception using errcode = 'QL423', message = 'Your account has no profile. Ask an admin to add you.';
  end if;
  if not v.active then
    raise exception using errcode = 'QL423', message = 'This account has been deactivated.';
  end if;
  return v;
end $$;

-- Active admin (or the service role).
create or replace function public._require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
begin
  if public._is_service() then return; end if;
  v := public._me();
  if v.role <> 'admin' then
    raise exception using errcode = 'QL403', message = 'Only an admin can do that.';
  end if;
end $$;

create or replace function public._require_caller() returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare
  v public.profiles;
begin
  v := public._me();
  if v.role <> 'caller' then
    raise exception using errcode = 'QL403', message = 'Only callers can dial leads.';
  end if;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- Time helpers (business time zone)
-- -----------------------------------------------------------------------------

create or replace function public._tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select time_zone from public.settings where id = 1), 'America/Chicago');
$$;

create or replace function public._day_start(p_ts timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select date_trunc('day', p_ts at time zone public._tz()) at time zone public._tz();
$$;

create or replace function public._next_day_start(p_ts timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select (date_trunc('day', p_ts at time zone public._tz()) + interval '1 day') at time zone public._tz();
$$;

-- Ramp-up: linear from ramp_start_cap (day 0) to daily_cap (day ramp_days), never above daily_cap.
create or replace function public._ramped_cap(p_daily_cap integer, p_added_at timestamptz, p_now timestamptz,
                                              p_ramp_days integer, p_ramp_start_cap integer) returns integer
language plpgsql stable set search_path = public as $$
declare
  v_age integer;
  v_start integer;
begin
  v_age := greatest(0, (p_now at time zone public._tz())::date - (p_added_at at time zone public._tz())::date);
  v_start := least(p_ramp_start_cap, p_daily_cap);
  if p_ramp_days <= 0 or v_age >= p_ramp_days then
    return p_daily_cap;
  end if;
  return least(p_daily_cap, round(v_start + ((p_daily_cap - v_start)::numeric * v_age) / p_ramp_days)::integer);
end $$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

-- New auth user -> profile. First user ever is the admin. Users created by the
-- admin-users Edge Function carry app_metadata.role. Anyone else (public sign-up)
-- becomes an INACTIVE caller until an admin activates them.
create or replace function public.trg_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_active boolean;
  v_name text;
begin
  perform pg_advisory_xact_lock(hashtext('questlabs.first_admin'));
  if not exists (select 1 from public.profiles) then
    v_role := 'admin';
    v_active := true;
  elsif coalesce(new.raw_app_meta_data ->> 'role', '') in ('admin', 'caller') then
    v_role := new.raw_app_meta_data ->> 'role';
    v_active := true;
  else
    v_role := 'caller';
    v_active := false;
  end if;
  v_name := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1));
  insert into public.profiles (id, email, full_name, role, active)
  values (new.id, lower(coalesce(new.email, '')), v_name, v_role, v_active)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists questlabs_on_auth_user_created on auth.users;
create trigger questlabs_on_auth_user_created
  after insert on auth.users
  for each row execute function public.trg_handle_new_user();

-- Never leave the team without an active admin.
create or replace function public.trg_profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.active
       and not exists (select 1 from public.profiles where id <> old.id and role = 'admin' and active) then
      raise exception using errcode = 'QL400', message = 'You cannot remove the last active admin.';
    end if;
    return old;
  end if;
  new.email := lower(btrim(new.email));
  if tg_op = 'UPDATE' and old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.profiles where id <> old.id and role = 'admin' and active) then
    raise exception using errcode = 'QL400', message = 'You cannot deactivate or demote the last active admin.';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update or delete on public.profiles
  for each row execute function public.trg_profiles_guard();

-- Validate the business time zone.
create or replace function public.trg_settings_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception using errcode = 'QL400', message = format('Unknown time zone: %s', new.time_zone);
  end if;
  return new;
end $$;

drop trigger if exists settings_guard on public.settings;
create trigger settings_guard
  before insert or update on public.settings
  for each row execute function public.trg_settings_guard();

-- New numbers default their cap from settings.default_daily_cap.
create or replace function public.trg_numbers_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.daily_cap is null then
    new.daily_cap := greatest(1, coalesce((select default_daily_cap from public.settings where id = 1), 100));
  end if;
  return new;
end $$;

drop trigger if exists phone_numbers_defaults on public.phone_numbers;
create trigger phone_numbers_defaults
  before insert on public.phone_numbers
  for each row execute function public.trg_numbers_defaults();

-- Direct (PostgREST) updates by non-admins may change only a few lead columns.
-- Security-definer functions run as their owner and are not affected.
create or replace function public.trg_leads_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    -- primary_phone is generated (NULL in NEW during a BEFORE trigger), so it is excluded too.
    if (to_jsonb(new) - array['contact_name','email','business_name','notes','primary_phone'])
       is distinct from (to_jsonb(old) - array['contact_name','email','business_name','notes','primary_phone']) then
      raise exception using errcode = 'QL403', message = 'Callers can only change the contact name, email, business name and notes.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists leads_guard on public.leads;
create trigger leads_guard
  before update on public.leads
  for each row execute function public.trg_leads_guard();

-- Calls: fill list_id from the lead (definer: callers cannot read most leads).
create or replace function public.trg_calls_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is not null then
    select l.list_id into new.list_id from public.leads l where l.id = new.lead_id;
  else
    new.list_id := null;
  end if;
  return new;
end $$;

drop trigger if exists calls_before on public.calls;
drop trigger if exists calls_before_insert on public.calls;
create trigger calls_before_insert
  before insert on public.calls
  for each row execute function public.trg_calls_before_insert();

-- Direct updates by non-admins may change only the outcome columns of a call.
create or replace function public.trg_calls_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    if (to_jsonb(new) - array['answered_at','ended_at','talk_seconds','result','notes','recording_url','disposition','provider_call_id'])
       is distinct from (to_jsonb(old) - array['answered_at','ended_at','talk_seconds','result','notes','recording_url','disposition','provider_call_id']) then
      raise exception using errcode = 'QL403', message = 'You can only change the outcome of a call.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists calls_guard on public.calls;
create trigger calls_guard
  before update on public.calls
  for each row execute function public.trg_calls_guard();

-- Outbound call logged -> lead.last_called_at / last_called_by.
create or replace function public.trg_calls_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lead_id is not null and new.direction = 'outbound' and new.caller_id is not null then
    update public.leads set last_called_at = new.started_at, last_called_by = new.caller_id where id = new.lead_id;
  end if;
  return null;
end $$;

drop trigger if exists calls_after_insert on public.calls;
create trigger calls_after_insert
  after insert on public.calls
  for each row execute function public.trg_calls_after_insert();

-- -----------------------------------------------------------------------------
-- Row Level Security (default deny; admin full access)
-- -----------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.settings      enable row level security;
alter table public.lead_lists    enable row level security;
alter table public.leads         enable row level security;
alter table public.calls         enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.presence      enable row level security;
alter table public.caller_scripts enable row level security;

-- profiles: own row always (so a deactivated user can be told why); admins everything.
-- Writes go through the admin-users Edge Function (service role); admins may also update.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = auth.uid());
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- settings: read for any active user; update for admins.
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated
  using ((select public.is_active_user()));
drop policy if exists settings_admin_update on public.settings;
create policy settings_admin_update on public.settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- lead_lists: admins only.
drop policy if exists lead_lists_admin_all on public.lead_lists;
create policy lead_lists_admin_all on public.lead_lists for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- leads: admins everything; callers only the lead they hold or their own callbacks.
drop policy if exists leads_admin_all on public.leads;
create policy leads_admin_all on public.leads for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists leads_caller_select on public.leads;
create policy leads_caller_select on public.leads for select to authenticated
  using ((select public.is_active_caller())
         and (locked_by = auth.uid() or (status = 'callback' and callback_owner = auth.uid())));
drop policy if exists leads_caller_update on public.leads;
create policy leads_caller_update on public.leads for update to authenticated
  using ((select public.is_active_caller())
         and (locked_by = auth.uid() or (status = 'callback' and callback_owner = auth.uid())))
  with check ((select public.is_active_caller())
         and (locked_by = auth.uid() or (status = 'callback' and callback_owner = auth.uid())));

-- calls: admins everything; active users their own calls (no delete).
drop policy if exists calls_admin_all on public.calls;
create policy calls_admin_all on public.calls for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists calls_own_select on public.calls;
create policy calls_own_select on public.calls for select to authenticated
  using ((select public.is_active_user()) and caller_id = auth.uid());
drop policy if exists calls_own_insert on public.calls;
create policy calls_own_insert on public.calls for insert to authenticated
  with check ((select public.is_active_user()) and caller_id = auth.uid());
drop policy if exists calls_own_update on public.calls;
create policy calls_own_update on public.calls for update to authenticated
  using ((select public.is_active_user()) and caller_id = auth.uid())
  with check ((select public.is_active_user()) and caller_id = auth.uid());

-- phone_numbers: admins only (callers use pick_from_number()).
drop policy if exists phone_numbers_admin_all on public.phone_numbers;
create policy phone_numbers_admin_all on public.phone_numbers for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- presence: admins read everything; a caller reads/writes only their own row.
drop policy if exists presence_admin_select on public.presence;
create policy presence_admin_select on public.presence for select to authenticated
  using ((select public.is_admin()));
drop policy if exists presence_own_select on public.presence;
create policy presence_own_select on public.presence for select to authenticated
  using ((select public.is_active_caller()) and caller_id = auth.uid());
drop policy if exists presence_own_insert on public.presence;
create policy presence_own_insert on public.presence for insert to authenticated
  with check ((select public.is_active_caller()) and caller_id = auth.uid());
drop policy if exists presence_own_update on public.presence;
create policy presence_own_update on public.presence for update to authenticated
  using ((select public.is_active_caller()) and caller_id = auth.uid())
  with check ((select public.is_active_caller()) and caller_id = auth.uid());

-- caller_scripts: any active user reads/writes only their own row; admins may read all.
-- The app goes through get_my_script() / save_my_script(); these policies cover direct access.
drop policy if exists caller_scripts_admin_select on public.caller_scripts;
create policy caller_scripts_admin_select on public.caller_scripts for select to authenticated
  using ((select public.is_admin()));
drop policy if exists caller_scripts_own_select on public.caller_scripts;
create policy caller_scripts_own_select on public.caller_scripts for select to authenticated
  using ((select public.is_active_user()) and user_id = auth.uid());
drop policy if exists caller_scripts_own_insert on public.caller_scripts;
create policy caller_scripts_own_insert on public.caller_scripts for insert to authenticated
  with check ((select public.is_active_user()) and user_id = auth.uid());
drop policy if exists caller_scripts_own_update on public.caller_scripts;
create policy caller_scripts_own_update on public.caller_scripts for update to authenticated
  using ((select public.is_active_user()) and user_id = auth.uid())
  with check ((select public.is_active_user()) and user_id = auth.uid());
drop policy if exists caller_scripts_own_delete on public.caller_scripts;
create policy caller_scripts_own_delete on public.caller_scripts for delete to authenticated
  using ((select public.is_active_user()) and user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Lead access helpers
-- -----------------------------------------------------------------------------

-- Api.getLead rule for callers: locked by me, my callback, assigned to me, or last dialed by me.
create or replace function public._caller_can_see(p_lead public.leads, p_uid uuid) returns boolean
language sql immutable as $$
  select p_lead.locked_by = p_uid or p_lead.callback_owner = p_uid
      or p_lead.assigned_to = p_uid or p_lead.last_called_by = p_uid;
$$;

-- Lead a user may work on (row-locked). Mirrors the demo's requireWorkable.
create or replace function public._workable(p_lead_id uuid, p_me public.profiles) returns public.leads
language plpgsql security definer set search_path = public as $$
declare
  v public.leads;
begin
  select * into v from public.leads where id = p_lead_id for update;
  if not found then
    raise exception using errcode = 'QL404', message = 'Lead not found.';
  end if;
  if p_me.role <> 'admin' and v.locked_by is not null and v.locked_by <> p_me.id
     and not coalesce(public._caller_can_see(v, p_me.id), false) then
    raise exception using errcode = 'QL403', message = 'This lead is held by another caller.';
  end if;
  return v;
end $$;

-- Missed day: attempt_days + 1, no_answer until the next business day, or exhausted.
create or replace function public._apply_missed_day(p_lead_id uuid, p_caller uuid) returns public.leads
language plpgsql security definer set search_path = public as $$
declare
  v public.leads;
  v_retry integer := coalesce((select retry_days from public.settings where id = 1), 3);
begin
  update public.leads set
    attempt_days   = attempt_days + 1,
    last_called_at = now(),
    last_called_by = p_caller,
    locked_by      = null,
    locked_at      = null,
    callback_at    = null,
    status         = case when attempt_days + 1 >= v_retry then 'exhausted' else 'no_answer' end,
    next_call_at   = case when attempt_days + 1 >= v_retry then null else public._next_day_start(now()) end
  where id = p_lead_id
  returning * into v;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- Caller queue
-- -----------------------------------------------------------------------------

create or replace function public.claim_next_leads(p_count integer) returns setof public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_n integer;
  v_now timestamptz := now();
  v_stale timestamptz := now() - interval '10 minutes';
  v_id uuid;
  v_lead public.leads;
begin
  v_me := public._require_caller();
  v_n := greatest(0, least(10, floor(coalesce(p_count, 0))::integer));
  if v_n = 0 then return; end if;

  for v_id in
    select l.id
    from public.leads l
    where cardinality(l.phones) > 0
      and (l.locked_by is null or l.locked_by = v_me.id or l.locked_at is null or l.locked_at <= v_stale)
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
    limit v_n
    for update of l skip locked
  loop
    update public.leads set locked_by = v_me.id, locked_at = v_now where id = v_id returning * into v_lead;
    return next v_lead;
  end loop;
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

create or replace function public.report_missed_day(p_lead_id uuid) returns public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  perform public._workable(p_lead_id, v_me);
  return public._apply_missed_day(p_lead_id, v_me.id);
end $$;

create or replace function public.report_bad_number(p_lead_id uuid, p_phone text) returns public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
  v public.leads;
begin
  v_me := public._me();
  v := public._workable(p_lead_id, v_me);
  update public.leads set phones = array_remove(phones, btrim(coalesce(p_phone, ''))) where id = p_lead_id
  returning * into v;
  if cardinality(v.phones) = 0 then
    update public.leads set
      status = 'bad_number', next_call_at = null, locked_by = null, locked_at = null,
      last_called_at = now(), last_called_by = v_me.id
    where id = p_lead_id
    returning * into v;
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

create or replace function public.get_my_callbacks() returns setof public.leads
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  return query
    select * from public.leads
    where status = 'callback' and callback_owner = v_me.id
    order by callback_at asc nulls first, id;
end $$;

-- Inbound lookup. `p_phone` must be E.164 (the client normalises). Callers get only
-- what an inbound call needs (assignment / lock / scheduling fields are blanked).
create or replace function public.find_lead_by_phone(p_phone text) returns setof public.leads
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v public.leads;
begin
  if not public._is_service() then
    v_me := public._me();
  end if;
  select * into v from public.leads
  where phones @> array[btrim(coalesce(p_phone, ''))]
  order by (primary_phone = btrim(coalesce(p_phone, ''))) desc, created_at asc
  limit 1;
  if not found then return; end if;
  if v_me.id is not null and v_me.role <> 'admin' then
    v.assigned_to := null;
    v.attempt_days := 0;
    v.next_call_at := null;
    v.locked_by := null;
    v.locked_at := null;
  end if;
  return next v;
end $$;

-- -----------------------------------------------------------------------------
-- Leads (admin unless stated)
-- -----------------------------------------------------------------------------

-- Any signed-in user; callers only for leads they may see.
create or replace function public.get_lead(p_id uuid) returns public.leads
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v public.leads;
begin
  v_me := public._me();
  select * into v from public.leads where id = p_id;
  if not found then
    raise exception using errcode = 'QL404', message = 'Lead not found.';
  end if;
  if v_me.role <> 'admin' and not coalesce(public._caller_can_see(v, v_me.id), false) then
    raise exception using errcode = 'QL403', message = 'You do not have access to this lead.';
  end if;
  return v;
end $$;

create or replace function public.get_lead_history(p_lead_id uuid) returns setof public.calls
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v public.leads;
begin
  v_me := public._me();
  select * into v from public.leads where id = p_lead_id;
  if not found then
    raise exception using errcode = 'QL404', message = 'Lead not found.';
  end if;
  if v_me.role <> 'admin' and not coalesce(public._caller_can_see(v, v_me.id), false) then
    raise exception using errcode = 'QL403', message = 'You do not have access to this lead.';
  end if;
  return query select * from public.calls where lead_id = p_lead_id order by started_at desc, id;
end $$;

-- Patch keys are snake_case column names. Admin: any LeadPatch field. Caller: only
-- contact_name / email / business_name / notes on a lead they hold or own as callback.
create or replace function public.update_lead(p_id uuid, p_patch jsonb) returns public.leads
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
  v public.leads;
  k text;
  p text;
  v_phones text[];
  v_allowed text[] := array['list_id','business_name','contact_name','phones','email','city','state','notes',
                            'status','assigned_to','attempt_days','next_call_at','callback_at','callback_owner'];
begin
  v_me := public._me();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = 'QL400', message = 'Nothing to update.';
  end if;
  select * into v from public.leads where id = p_id for update;
  if not found then
    raise exception using errcode = 'QL404', message = 'Lead not found.';
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if not (k = any(v_allowed)) then
      raise exception using errcode = 'QL400', message = format('Unknown lead field: %s', k);
    end if;
  end loop;
  if v_me.role <> 'admin' then
    if v.locked_by is distinct from v_me.id and v.callback_owner is distinct from v_me.id then
      raise exception using errcode = 'QL403', message = 'You can only edit the lead you are working.';
    end if;
    for k in select jsonb_object_keys(p_patch) loop
      if not (k = any(array['contact_name','email','business_name','notes'])) then
        raise exception using errcode = 'QL403', message = format('Callers cannot change %s.', k);
      end if;
    end loop;
  end if;
  if p_patch ? 'phones' then
    if jsonb_typeof(p_patch -> 'phones') <> 'array' then
      raise exception using errcode = 'QL400', message = 'Phones must be a list.';
    end if;
    v_phones := '{}';
    for p in select jsonb_array_elements_text(p_patch -> 'phones') loop
      p := btrim(p);
      if p !~ '^\+[1-9][0-9]{7,14}$' then
        raise exception using errcode = 'QL400', message = format('Invalid phone number: %s', p);
      end if;
      if not (p = any(v_phones)) then v_phones := v_phones || p; end if;
    end loop;
    if cardinality(v_phones) > 3 then
      raise exception using errcode = 'QL400', message = 'A lead can have at most 3 phone numbers.';
    end if;
  end if;
  if p_patch ? 'list_id' and not exists (select 1 from public.lead_lists where id = (p_patch ->> 'list_id')::uuid) then
    raise exception using errcode = 'QL404', message = 'List not found.';
  end if;
  if p_patch ? 'business_name' and btrim(coalesce(p_patch ->> 'business_name', '')) = '' then
    raise exception using errcode = 'QL400', message = 'Business name is required.';
  end if;
  if p_patch ->> 'status' = 'callback'
     and coalesce(p_patch ->> 'callback_at', v.callback_at::text) is null then
    raise exception using errcode = 'QL400', message = 'A callback needs a callback time.';
  end if;

  update public.leads set
    list_id        = case when p_patch ? 'list_id' then (p_patch ->> 'list_id')::uuid else list_id end,
    business_name  = case when p_patch ? 'business_name' then btrim(p_patch ->> 'business_name') else business_name end,
    contact_name   = case when p_patch ? 'contact_name' then coalesce(p_patch ->> 'contact_name', '') else contact_name end,
    phones         = case when p_patch ? 'phones' then v_phones else phones end,
    email          = case when p_patch ? 'email' then coalesce(p_patch ->> 'email', '') else email end,
    city           = case when p_patch ? 'city' then coalesce(p_patch ->> 'city', '') else city end,
    state          = case when p_patch ? 'state' then coalesce(p_patch ->> 'state', '') else state end,
    notes          = case when p_patch ? 'notes' then coalesce(p_patch ->> 'notes', '') else notes end,
    status         = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    assigned_to    = case when p_patch ? 'assigned_to' then (p_patch ->> 'assigned_to')::uuid else assigned_to end,
    attempt_days   = case when p_patch ? 'attempt_days' then coalesce((p_patch ->> 'attempt_days')::integer, 0) else attempt_days end,
    callback_at    = case when p_patch ? 'callback_at' then (p_patch ->> 'callback_at')::timestamptz else callback_at end,
    callback_owner = case when p_patch ? 'callback_owner' then (p_patch ->> 'callback_owner')::uuid else callback_owner end,
    next_call_at   = case
                       when p_patch ? 'next_call_at' then (p_patch ->> 'next_call_at')::timestamptz
                       when p_patch ->> 'status' = 'callback' then
                         case when p_patch ? 'callback_at' then (p_patch ->> 'callback_at')::timestamptz else callback_at end
                       else next_call_at end
  where id = p_id
  returning * into v;
  return v;
end $$;

create or replace function public.assign_leads(p_ids uuid[], p_assign_to uuid) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_n integer;
begin
  perform public._require_admin();
  if p_assign_to is not null and not exists (select 1 from public.profiles where id = p_assign_to and role = 'caller') then
    raise exception using errcode = 'QL400', message = 'Leads can only be assigned to a caller.';
  end if;
  update public.leads set assigned_to = p_assign_to where id = any(coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.delete_leads(p_ids uuid[]) returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_n integer;
begin
  perform public._require_admin();
  delete from public.leads where id = any(coalesce(p_ids, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.list_lead_lists()
returns table (id uuid, name text, created_at timestamptz, lead_count integer, remaining_count integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public._require_admin();
  return query
    select l.id, l.name, l.created_at,
           count(x.id)::integer,
           (count(x.id) filter (where x.status in ('new', 'no_answer', 'callback')))::integer
    from public.lead_lists l
    left join public.leads x on x.list_id = l.id
    group by l.id
    order by l.created_at desc, l.id;
end $$;

-- Filtered, sorted, paged leads. p_assigned_to: a caller uuid, 'pool', or null.
-- p_page_size null = every row. Returns {"rows": [lead...], "total": n}.
create or replace function public.query_leads(p_list_id uuid, p_statuses text[], p_assigned_to text, p_search text,
                                              p_sort_field text, p_sort_dir text, p_page integer, p_page_size integer)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_field text := coalesce(p_sort_field, 'created_at');
  v_dir text := case when lower(coalesce(p_sort_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;
  v_q text := lower(btrim(coalesce(p_search, '')));
  v_qd text;
  v_like text;
  v_assigned uuid;
  v_pool boolean := false;
  v_size integer;
  v_offset integer;
  v_result jsonb;
begin
  perform public._require_admin();
  if not (v_field = any(array['created_at','business_name','contact_name','status','last_called_at','next_call_at','attempt_days'])) then
    raise exception using errcode = 'QL400', message = format('Cannot sort by %s.', v_field);
  end if;
  if p_assigned_to = 'pool' then
    v_pool := true;
  elsif p_assigned_to is not null and p_assigned_to <> '' then
    v_assigned := p_assigned_to::uuid;
  end if;
  v_qd := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if p_page_size is not null then
    v_size := greatest(1, p_page_size);
    v_offset := (greatest(1, coalesce(p_page, 1)) - 1) * v_size;
  end if;

  execute format($q$
    with f as (
      select l.* from public.leads l
      where ($1 is null or l.list_id = $1)
        and ($2 is null or l.status = any($2))
        and (not $3 or l.assigned_to is null)
        and ($4 is null or l.assigned_to = $4)
        and ($5 = '' or lower(l.business_name || ' ' || l.contact_name || ' ' || l.email || ' ' || l.city) like $6
             or (length($7) >= 3 and regexp_replace(array_to_string(l.phones, ','), '[^0-9,]', '', 'g') like '%%' || $7 || '%%'))
    ), page as (
      select f.* from f
      order by f.%1$I %2$s nulls last, f.id
      offset coalesce($8, 0) limit $9
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'rows', coalesce((select jsonb_agg(to_jsonb(page) order by page.%1$I %2$s nulls last, page.id) from page), '[]'::jsonb)
    )
  $q$, v_field, v_dir)
  into v_result
  using p_list_id, p_statuses, v_pool, v_assigned, v_q, v_like, v_qd, v_offset, v_size;
  return v_result;
end $$;

-- Import. p_rows: [{businessName, contactName, phones[], email, city, state, notes}] with phones
-- already normalised to E.164 by the client (anything else is dropped here).
-- p_assign: {"mode":"pool"} | {"mode":"caller","callerId":..} | {"mode":"round_robin","callerIds":[..]}.
-- p_rr_offset: rows already imported by earlier chunks of the same import (keeps round robin even).
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
    if exists (select 1 from public.leads where primary_phone = v_phones[1]) then
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

-- -----------------------------------------------------------------------------
-- Calls
-- -----------------------------------------------------------------------------

-- Admin: any caller (p_caller_id optional). Caller: forced to self. Newest first.
-- Returns {"rows": [call + businessName/contactName/callerName], "total": n}.
create or replace function public.list_calls(p_caller_id uuid, p_lead_id uuid, p_from timestamptz, p_to timestamptz,
                                             p_only_recorded boolean, p_results text[], p_page integer, p_page_size integer)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_caller uuid;
  v_size integer := greatest(1, coalesce(p_page_size, 50));
  v_offset integer := (greatest(1, coalesce(p_page, 1)) - 1) * greatest(1, coalesce(p_page_size, 50));
  v_result jsonb;
begin
  v_me := public._me();
  v_caller := case when v_me.role = 'admin' then p_caller_id else v_me.id end;
  with f as (
    select c.* from public.calls c
    where (v_caller is null or c.caller_id = v_caller)
      and (p_lead_id is null or c.lead_id = p_lead_id)
      and (p_from is null or c.started_at >= p_from)
      and (p_to is null or c.started_at < p_to)
      and (not coalesce(p_only_recorded, false) or c.recording_url is not null)
      and (p_results is null or c.result = any(p_results))
  ), page as (
    select f.* from f order by f.started_at desc, f.id offset v_offset limit v_size
  )
  select jsonb_build_object(
    'total', (select count(*) from f),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(page) || jsonb_build_object(
               'business_name', l.business_name,
               'contact_name', l.contact_name,
               'caller_name', pr.full_name)
             order by page.started_at desc, page.id)
      from page
      left join public.leads l on l.id = page.lead_id
      left join public.profiles pr on pr.id = page.caller_id
    ), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;

-- -----------------------------------------------------------------------------
-- Outbound numbers
-- -----------------------------------------------------------------------------

-- Numbers with derived fields. Internal (not callable by clients).
create or replace function public._numbers_derived()
returns table (id uuid, number text, label text, active boolean, daily_cap integer, added_at timestamptz,
               provider_id text, effective_cap_today integer, calls_today integer, calls_7d integer,
               pickup_rate_7d double precision, flagged boolean)
language sql stable security definer set search_path = public as $$
  with s as (
    select ramp_days, ramp_start_cap from public.settings where id = 1
  ), b as (
    select public._day_start(now()) as today, now() - interval '7 days' as week
  ), st as (
    select c.from_number,
           count(*) filter (where c.started_at >= b.today) as today,
           count(*) filter (where c.started_at >= b.week) as d7,
           count(*) filter (where c.started_at >= b.week and c.result in ('answered', 'dropped_pickup')) as p7
    from public.calls c cross join b
    where c.direction = 'outbound' and c.started_at >= least(b.today, b.week)
    group by c.from_number
  ), fleet as (
    select coalesce(sum(st.d7), 0) as d, coalesce(sum(st.p7), 0) as p from st
  )
  select n.id, n.number, n.label, n.active, n.daily_cap, n.added_at, n.provider_id,
         public._ramped_cap(n.daily_cap, n.added_at, now(), coalesce(s.ramp_days, 14), coalesce(s.ramp_start_cap, 25)),
         coalesce(st.today, 0)::integer,
         coalesce(st.d7, 0)::integer,
         case when coalesce(st.d7, 0) > 0 then st.p7::double precision / st.d7 else 0 end,
         coalesce(st.d7, 0) >= 30 and fleet.d > 0 and fleet.p > 0
           and (st.p7::double precision / st.d7) < (fleet.p::double precision / fleet.d) * 0.5
  from public.phone_numbers n
  left join s on true
  cross join fleet
  left join st on st.from_number = n.number;
$$;

create or replace function public.list_numbers()
returns table (id uuid, number text, label text, active boolean, daily_cap integer, added_at timestamptz,
               provider_id text, effective_cap_today integer, calls_today integer, calls_7d integer,
               pickup_rate_7d double precision, flagged boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public._require_admin();
  return query select * from public._numbers_derived() d order by d.added_at, d.number;
end $$;

-- Any signed-in user. Active numbers under today's ramped cap; same area code first,
-- then fewest calls today, then oldest. Empty when nothing is available.
create or replace function public.pick_from_number(p_to_phone text)
returns table (id uuid, number text, label text, active boolean, daily_cap integer, added_at timestamptz,
               provider_id text, effective_cap_today integer, calls_today integer, calls_7d integer,
               pickup_rate_7d double precision, flagged boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_ac text;
begin
  if not public._is_service() then
    perform public._me();
  end if;
  if coalesce(p_to_phone, '') ~ '^\+1[2-9][0-9]{9}$' then
    v_ac := substr(p_to_phone, 3, 3);
  end if;
  return query
    select * from public._numbers_derived() d
    where d.active and d.calls_today < d.effective_cap_today
    order by case when v_ac is not null and d.number ~ '^\+1[0-9]{10}$' and substr(d.number, 3, 3) = v_ac then 0 else 1 end,
             d.calls_today, d.added_at, d.number
    limit 1;
end $$;

-- -----------------------------------------------------------------------------
-- Presence
-- -----------------------------------------------------------------------------

-- Callers only; admins are ignored silently. Re-sending the same status is a heartbeat.
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
  insert into public.presence as pr (caller_id, status, since, detail, updated_at)
  values (v_me.id, p_status, now(), p_detail, now())
  on conflict (caller_id) do update set
    since = case when pr.status = excluded.status and pr.updated_at > now() - interval '90 seconds'
                 then pr.since else now() end,
    status = excluded.status,
    detail = excluded.detail,
    updated_at = now();
end $$;

-- Sign-out cleanup: release my locks, go offline.
create or replace function public.go_offline() returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  update public.leads set locked_by = null, locked_at = null where locked_by = v_me.id;
  if v_me.role = 'caller' then
    perform public.set_presence('offline', null);
  end if;
end $$;

-- (admin) One entry per active caller; rows not refreshed for 90 s count as offline.
create or replace function public.list_presence()
returns table (caller_id uuid, full_name text, status text, since timestamptz, detail text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public._require_admin();
  return query
    select p.id, p.full_name,
           case when pr.caller_id is null or pr.updated_at < now() - interval '90 seconds' then 'offline' else pr.status end,
           case when pr.caller_id is null then p.created_at
                when pr.updated_at < now() - interval '90 seconds' and pr.status <> 'offline' then pr.updated_at
                else pr.since end,
           case when pr.caller_id is null or pr.updated_at < now() - interval '90 seconds' then null else pr.detail end
    from public.profiles p
    left join public.presence pr on pr.caller_id = p.id
    where p.role = 'caller' and p.active
    order by p.full_name, p.id;
end $$;

-- Display names for any active user (callers never get emails of others).
create or replace function public.list_profile_names()
returns table (id uuid, full_name text, role text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public._me();
  return query select p.id, p.full_name, p.role from public.profiles p order by p.full_name, p.id;
end $$;

-- -----------------------------------------------------------------------------
-- Metrics
-- -----------------------------------------------------------------------------

create or replace function public._tot(p_dials bigint, p_pickups bigint, p_conv bigint, p_book bigint,
                                       p_talk bigint, p_dropped bigint) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'dials', coalesce(p_dials, 0),
    'pickups', coalesce(p_pickups, 0),
    'pickupRate', case when coalesce(p_dials, 0) > 0 then coalesce(p_pickups, 0)::double precision / p_dials else 0 end,
    'conversations', coalesce(p_conv, 0),
    'bookings', coalesce(p_book, 0),
    'talkSeconds', coalesce(p_talk, 0),
    'droppedPickups', coalesce(p_dropped, 0));
$$;

-- Calls in [from, to) with metric flags. Internal.
create or replace function public._calls_flags(p_from timestamptz, p_to timestamptz)
returns table (caller_id uuid, list_id uuid, num text, day date, f_dial integer, f_pick integer, f_conv integer,
               f_book integer, f_drop integer, talk integer, disposition text)
language sql stable security definer set search_path = public as $$
  select c.caller_id, c.list_id,
         case when c.direction = 'outbound' then c.from_number else c.to_number end,
         (c.started_at at time zone public._tz())::date,
         (c.direction = 'outbound')::integer,
         coalesce(c.direction = 'outbound' and c.result in ('answered', 'dropped_pickup'), false)::integer,
         coalesce(c.result = 'answered' and c.talk_seconds >= 20, false)::integer,
         coalesce(c.disposition = 'booked', false)::integer,
         coalesce(c.result = 'dropped_pickup', false)::integer,
         c.talk_seconds,
         c.disposition
  from public.calls c
  where c.started_at >= p_from and c.started_at < p_to;
$$;

create or replace function public.get_metrics(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text := public._tz();
  v_prev_from timestamptz;
  v_totals jsonb;
  v_prev jsonb;
  v_by_caller jsonb;
  v_by_day jsonb;
  v_by_number jsonb;
  v_by_list jsonb;
  v_outcomes jsonb;
begin
  perform public._require_admin();
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception using errcode = 'QL400', message = 'Invalid date range.';
  end if;
  v_prev_from := p_from - (p_to - p_from);

  select public._tot(sum(f_dial), sum(f_pick), sum(f_conv), sum(f_book), sum(talk), sum(f_drop))
    into v_totals from public._calls_flags(p_from, p_to);
  select public._tot(sum(f_dial), sum(f_pick), sum(f_conv), sum(f_book), sum(talk), sum(f_drop))
    into v_prev from public._calls_flags(v_prev_from, p_from);

  with c as (select * from public._calls_flags(p_from, p_to)),
  keys as (
    select id as k from public.profiles where role = 'caller'
    union select caller_id from c where caller_id is not null
  ), agg as (
    select caller_id as k, sum(f_dial) d, sum(f_pick) p, sum(f_conv) cv, sum(f_book) b, sum(talk) t, sum(f_drop) dr
    from c where caller_id is not null group by caller_id
  )
  select coalesce(jsonb_agg(public._tot(a.d, a.p, a.cv, a.b, a.t, a.dr)
                            || jsonb_build_object('callerId', keys.k, 'label', coalesce(pr.full_name, 'Unknown user'))
                            order by coalesce(pr.full_name, 'Unknown user'), keys.k), '[]'::jsonb)
    into v_by_caller
  from keys
  left join agg a on a.k = keys.k
  left join public.profiles pr on pr.id = keys.k;

  with c as (select * from public._calls_flags(p_from, p_to)),
  days as (
    select d::date as day
    from generate_series(((p_from at time zone v_tz)::date)::timestamp, ((p_to at time zone v_tz)::date)::timestamp,
                         interval '1 day') as g(d)
    where (d::date::timestamp at time zone v_tz) < p_to
  ), agg as (
    select day, sum(f_dial) d, sum(f_pick) p, sum(f_conv) cv, sum(f_book) b, sum(talk) t, sum(f_drop) dr
    from c group by day
  )
  select coalesce(jsonb_agg(public._tot(a.d, a.p, a.cv, a.b, a.t, a.dr)
                            || jsonb_build_object('date', to_char(days.day, 'YYYY-MM-DD'),
                                                  'label', to_char(days.day, 'Dy, Mon FMDD'))
                            order by days.day), '[]'::jsonb)
    into v_by_day
  from days
  left join agg a on a.day = days.day;

  with c as (select * from public._calls_flags(p_from, p_to)),
  keys as (
    select number as k from public.phone_numbers
    union select num from c
  ), agg as (
    select num as k, sum(f_dial) d, sum(f_pick) p, sum(f_conv) cv, sum(f_book) b, sum(talk) t, sum(f_drop) dr
    from c group by num
  )
  select coalesce(jsonb_agg(public._tot(a.d, a.p, a.cv, a.b, a.t, a.dr)
                            || jsonb_build_object('number', keys.k, 'numberId', n.id,
                                                  'label', case when n.id is null then keys.k || ' (removed)'
                                                                else coalesce(nullif(n.label, ''), keys.k) end)
                            order by (n.id is null), n.added_at, keys.k), '[]'::jsonb)
    into v_by_number
  from keys
  left join agg a on a.k = keys.k
  left join public.phone_numbers n on n.number = keys.k;

  with c as (select * from public._calls_flags(p_from, p_to)),
  keys as (
    select id as k from public.lead_lists
    union select list_id from c where list_id is not null
  ), agg as (
    select list_id as k, sum(f_dial) d, sum(f_pick) p, sum(f_conv) cv, sum(f_book) b, sum(talk) t, sum(f_drop) dr
    from c where list_id is not null group by list_id
  )
  select coalesce(jsonb_agg(public._tot(a.d, a.p, a.cv, a.b, a.t, a.dr)
                            || jsonb_build_object('listId', keys.k, 'label', coalesce(l.name, 'Deleted list'))
                            order by (l.id is null), l.created_at, keys.k), '[]'::jsonb)
    into v_by_list
  from keys
  left join agg a on a.k = keys.k
  left join public.lead_lists l on l.id = keys.k;

  with d(disposition, label, ord) as (
    values ('booked', 'Booked', 1), ('callback', 'Callback', 2), ('not_interested', 'Not interested', 3),
           ('wrong_number', 'Wrong number', 4), ('do_not_call', 'Do not call', 5), ('voicemail', 'Voicemail', 6),
           ('hung_up', 'Hung up', 7)
  ), agg as (
    select disposition, count(*) as n from public._calls_flags(p_from, p_to)
    where disposition is not null group by disposition
  )
  select jsonb_agg(jsonb_build_object('disposition', d.disposition, 'label', d.label, 'count', coalesce(agg.n, 0))
                   order by d.ord)
    into v_outcomes
  from d left join agg on agg.disposition = d.disposition;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'totals', v_totals,
    'previousTotals', v_prev,
    'byCaller', v_by_caller,
    'byDay', v_by_day,
    'byNumber', v_by_number,
    'byList', v_by_list,
    'outcomes', v_outcomes);
end $$;

-- Current user's totals since the start of today (business time zone).
create or replace function public.get_my_stats_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v jsonb;
begin
  v_me := public._me();
  select public._tot(sum(f_dial), sum(f_pick), sum(f_conv), sum(f_book), sum(talk), sum(f_drop))
    into v
  from public._calls_flags(public._day_start(now()), 'infinity'::timestamptz)
  where caller_id = v_me.id;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- My script (Api.getMyScript / Api.saveMyScript)
-- -----------------------------------------------------------------------------

-- {script, isPersonal, teamScript} for the signed-in active user.
create or replace function public.get_my_script() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_team text;
  v_mine text;
begin
  v_me := public._me();
  select script into v_team from public.settings where id = 1;
  select script into v_mine from public.caller_scripts where user_id = v_me.id;
  v_team := coalesce(v_team, '');
  if v_mine is not null and length(btrim(v_mine)) > 0 then
    return jsonb_build_object('script', v_mine, 'isPersonal', true, 'teamScript', v_team);
  end if;
  return jsonb_build_object('script', v_team, 'isPersonal', false, 'teamScript', v_team);
end $$;

-- Saves my personal copy; null or blank removes it (back to the team script).
create or replace function public.save_my_script(p_script text) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public._me();
  if p_script is null or length(btrim(p_script)) = 0 then
    delete from public.caller_scripts where user_id = v_me.id;
    return;
  end if;
  if length(p_script) > 20000 then
    raise exception using errcode = 'QL400', message = 'Script is too long (max 20,000 characters).';
  end if;
  insert into public.caller_scripts (user_id, script, updated_at)
  values (v_me.id, p_script, now())
  on conflict (user_id) do update set script = excluded.script, updated_at = excluded.updated_at;
end $$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------

-- Tables: nothing for anon; authenticated is governed by RLS above.
revoke all on table public.profiles, public.settings, public.lead_lists, public.leads, public.calls,
                    public.phone_numbers, public.presence, public.caller_scripts from anon;
revoke truncate, references, trigger on table public.profiles, public.settings, public.lead_lists, public.leads,
                    public.calls, public.phone_numbers, public.presence, public.caller_scripts from authenticated;
grant select, insert, update, delete on table public.profiles, public.settings, public.lead_lists, public.leads,
                    public.calls, public.phone_numbers, public.presence, public.caller_scripts to authenticated;
grant all on table public.profiles, public.settings, public.lead_lists, public.leads, public.calls,
                   public.phone_numbers, public.presence, public.caller_scripts to service_role;

-- Functions: revoke from PUBLIC and anon; client-facing ones to authenticated + service_role;
-- internal helpers (leading underscore) and trigger functions to nobody but their owner.
do $$
declare
  r record;
  v_client text[] := array[
    'is_active_user','is_admin','is_active_caller',
    'claim_next_leads','release_leads','report_missed_day','report_bad_number','save_disposition',
    'get_my_callbacks','find_lead_by_phone','get_lead','get_lead_history','update_lead','assign_leads',
    'delete_leads','list_lead_lists','query_leads','import_leads','list_calls','list_numbers',
    'pick_from_number','set_presence','go_offline','list_presence','list_profile_names',
    'get_metrics','get_my_stats_today','get_my_script','save_my_script'];
  v_internal text[] := array[
    '_is_service','_me','_require_admin','_require_caller','_tz','_day_start','_next_day_start','_ramped_cap',
    '_caller_can_see','_workable','_apply_missed_day','_numbers_derived','_tot','_calls_flags',
    'trg_handle_new_user','trg_profiles_guard','trg_settings_guard','trg_numbers_defaults','trg_leads_guard',
    'trg_calls_before_insert','trg_calls_guard','trg_calls_after_insert'];
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(v_client || v_internal)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    if r.proname = any(v_client) then
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
    else
      execute format('grant execute on function %s to service_role', r.sig);
    end if;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Realtime: presence changes are pushed to the admin's live view.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'presence') then
    alter publication supabase_realtime add table public.presence;
  end if;
end $$;
