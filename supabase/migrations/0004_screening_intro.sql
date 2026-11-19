-- What the dialer says to iPhone call screening ("who's calling and why?") on the caller's behalf.
-- '{name}' is replaced by the caller's first name. Empty = screeners are treated as voicemail.
-- Off by default: while it is set, a voicemail is only hung up when Telnyx reports the end of its
-- greeting, and in practice that report rarely arrived (callers were left listening to voicemail).
alter table public.settings add column if not exists screening_intro text not null default '';
