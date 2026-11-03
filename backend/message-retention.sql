-- Run in Supabase SQL Editor after schema.sql, playback.sql and phase2.sql.
-- Enable pg_cron in Supabase Integrations before applying this file.
begin;

create or replace function public.purge_expired_watch_messages()
returns void language sql security definer set search_path = '' as $$
  delete from public.watch_room_messages
  where created_at <= pg_catalog.now() - interval '24 hours';
$$;
revoke all on function public.purge_expired_watch_messages() from public, anon, authenticated;

create index if not exists watch_room_messages_expiry_idx
on public.watch_room_messages (created_at);

-- Expired rows disappear immediately through RLS, then are physically purged
-- on the next minute tick. This also covers direct Realtime/API clients.
drop policy if exists "Messages expire after 24 hours" on public.watch_room_messages;
create policy "Messages expire after 24 hours"
on public.watch_room_messages as restrictive for select to authenticated
using (created_at > (select pg_catalog.now()) - interval '24 hours');

select public.purge_expired_watch_messages();
select cron.schedule('multiplay-message-retention', '* * * * *',
  'select public.purge_expired_watch_messages();');

commit;
