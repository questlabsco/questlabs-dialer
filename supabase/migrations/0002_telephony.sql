-- 0002_telephony.sql — Telnyx real-calls support. Runs after 0001_core.sql.
-- Every table here is written only by Edge Functions with the service role.
-- Clients read their own events/calls (RLS) and admins read the config.

-- ---------------------------------------------------------------------------
-- Telnyx resource ids found or created by the telnyx-setup function (single row).
-- ---------------------------------------------------------------------------
create table if not exists public.telephony_config (
  id smallint primary key default 1 check (id = 1),
  voice_app_id text,
  voice_app_name text,
  credential_connection_id text,
  credential_connection_name text,
  outbound_voice_profile_id text,
  outbound_voice_profile_name text,
  webhook_url text,
  -- Base64 Ed25519 public key used to verify webhooks (GET /v2/public_key). Not a secret.
  webhook_public_key text,
  updated_at timestamptz not null default now()
);
alter table public.telephony_config enable row level security;
drop policy if exists telephony_config_admin_read on public.telephony_config;
create policy telephony_config_admin_read on public.telephony_config
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- One Telnyx telephony credential per user (under the dialer's credential connection).
-- ---------------------------------------------------------------------------
create table if not exists public.telephony_credentials (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  credential_id text not null unique,
  connection_id text not null,
  sip_username text,
  created_at timestamptz not null default now()
);
alter table public.telephony_credentials enable row level security;
-- No policies: service role only.

-- ---------------------------------------------------------------------------
-- A caller's long-lived WebRTC "agent leg" (parked on the credential connection).
-- ---------------------------------------------------------------------------
create table if not exists public.agent_sessions (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'live', 'ended')),
  call_control_id text unique,
  call_leg_id text,
  created_at timestamptz not null default now(),
  live_at timestamptz,
  ended_at timestamptz
);
create index if not exists agent_sessions_caller_live on public.agent_sessions (caller_id) where status <> 'ended';
alter table public.agent_sessions enable row level security;
drop policy if exists agent_sessions_own_read on public.agent_sessions;
create policy agent_sessions_own_read on public.agent_sessions
  for select to authenticated using (caller_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Our call id (returned by Telephony.dial / carried by `incoming`) <-> Telnyx ids.
-- ---------------------------------------------------------------------------
create table if not exists public.telephony_calls (
  id uuid primary key,
  caller_id uuid references public.profiles(id) on delete set null,
  lead_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  from_number text not null,
  to_number text not null,
  ring smallint not null default 1,
  -- dialing -> ringing -> answered -> ended (outbound)
  -- incoming -> answering -> answered -> ended | incoming -> declining -> ended (inbound)
  status text not null default 'dialing'
    check (status in ('dialing', 'ringing', 'incoming', 'answering', 'declining', 'answered', 'ended')),
  call_control_id text unique,
  call_leg_id text,
  call_session_id text,
  agent_session_id uuid references public.agent_sessions(id) on delete set null,
  record boolean not null default false,
  recording_id text,
  recording_saved_at timestamptz,
  machine boolean not null default false,
  -- Set before we hang up / decline, so the hangup webhook reports hangup_local (or this reason).
  local_end_reason text check (local_end_reason in ('no_answer', 'busy', 'failed', 'bad_number', 'hangup_local', 'hangup_remote')),
  end_reason text,
  hangup_cause text,
  sip_code integer,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz
);
create index if not exists telephony_calls_caller_active on public.telephony_calls (caller_id, status) where status <> 'ended';
alter table public.telephony_calls enable row level security;
drop policy if exists telephony_calls_own_read on public.telephony_calls;
create policy telephony_calls_own_read on public.telephony_calls
  for select to authenticated using (caller_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Events pushed to the app over Supabase Realtime (filtered by caller_id; RLS-protected).
-- ---------------------------------------------------------------------------
create table if not exists public.telephony_events (
  id bigint generated always as identity primary key,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  call_id uuid,
  type text not null check (type in ('ringing', 'answered', 'machine', 'ended', 'incoming', 'error')),
  reason text,
  from_number text,
  to_number text,
  message text,
  created_at timestamptz not null default now()
);
create index if not exists telephony_events_caller on public.telephony_events (caller_id, id);
-- At most one terminal / answer / ringing / machine event per call.
create unique index if not exists telephony_events_once
  on public.telephony_events (call_id, type) where call_id is not null and type in ('ended', 'answered', 'ringing', 'machine', 'incoming');
alter table public.telephony_events enable row level security;
drop policy if exists telephony_events_own_read on public.telephony_events;
create policy telephony_events_own_read on public.telephony_events
  for select to authenticated using (caller_id = auth.uid());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'telephony_events'
     ) then
    alter publication supabase_realtime add table public.telephony_events;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Webhook de-duplication (Telnyx may deliver the same event more than once).
-- ---------------------------------------------------------------------------
create table if not exists public.telephony_webhook_events (
  event_id text primary key,
  event_type text,
  received_at timestamptz not null default now()
);
alter table public.telephony_webhook_events enable row level security;

-- ---------------------------------------------------------------------------
-- Attach a saved recording to the CallRecord whichever arrives first: the `calls` row (created by
-- the app with provider_call_id = our call id) or the recording (stored on telephony_calls).
-- recording_url holds the stable reference 'telnyx-recording:<recording id>'; playback asks the
-- telnyx-recording function for a fresh, short-lived download URL.
-- ---------------------------------------------------------------------------
create or replace function public.telephony_fill_recording_url()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  rec_id text;
begin
  if new.recording_url is null and new.provider_call_id is not null then
    select t.recording_id into rec_id
      from public.telephony_calls t
     where t.id::text = new.provider_call_id
       and t.recording_id is not null
       and t.recording_saved_at is not null;
    if rec_id is not null then
      new.recording_url := 'telnyx-recording:' || rec_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists calls_fill_recording_url on public.calls;
create trigger calls_fill_recording_url
  before insert or update of provider_call_id on public.calls
  for each row execute function public.telephony_fill_recording_url();

-- Retention: events older than 2 days are not needed by the app.
create or replace function public.telephony_prune_events()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.telephony_events where created_at < now() - interval '2 days';
  delete from public.telephony_webhook_events where received_at < now() - interval '7 days';
$$;
revoke all on function public.telephony_prune_events() from public, anon, authenticated;
