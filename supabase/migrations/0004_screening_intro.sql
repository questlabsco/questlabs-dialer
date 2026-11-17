-- What the dialer says to iPhone call screening ("who's calling and why?") on the caller's behalf.
-- '{name}' is replaced by the caller's first name. Empty = screeners are treated as voicemail.
alter table public.settings add column if not exists screening_intro text not null default '';

update public.settings
   set screening_intro = 'Hi, this is Matt. Saw your LinkedIn post, interested in connecting.'
 where screening_intro = '' or screening_intro = 'Hi, this is {name}. Saw your LinkedIn post, interested in connecting.';
