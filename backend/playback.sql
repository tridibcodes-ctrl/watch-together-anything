-- Apply after schema.sql. Safe to reapply; does not remove existing room data.
begin;
create table if not exists public.watch_room_playback (
  room_id uuid primary key references public.watch_rooms(id) on delete cascade,
  session_id uuid not null,
  media jsonb not null,
  provider text not null check (provider in ('cinemaos', 'vidlink')),
  status text not null check (status in ('playing', 'paused')),
  position_ms bigint not null check (position_ms between 0 and 604800000),
  anchor_at timestamptz not null,
  revision bigint not null check (revision > 0)
);
create table if not exists public.watch_playback_commands (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  command_id uuid not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id, command_id)
);
alter table public.watch_room_playback enable row level security;
alter table public.watch_playback_commands enable row level security;
revoke all on public.watch_room_playback, public.watch_playback_commands from anon, authenticated;
grant select on public.watch_room_playback to authenticated;
drop policy if exists "Members read playback" on public.watch_room_playback;
create policy "Members read playback" on public.watch_room_playback for select to authenticated
using (public.is_room_member(room_id));

-- All writes, including direct RPC calls, authorize membership and serialize on
-- the room row. Clients cannot bypass revision checks by writing the table.
create or replace function public.watch_playback(
  p_room_id uuid, p_action text default 'get', p_command_id uuid default null,
  p_expected_revision bigint default null, p_session_id uuid default null,
  p_media jsonb default null, p_provider text default null, p_position_ms bigint default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  state public.watch_room_playback;
  saved_payload jsonb;
  command_payload jsonb;
  snapshot jsonb;
  outcome text := 'ok';
  stamp timestamptz;
  next_position bigint;
begin
  if actor is null or not public.is_room_member(p_room_id) then
    raise exception using errcode = '42501', message = 'Room membership required';
  end if;
  if p_action is null or p_action not in ('get','media','play','pause','seek','provider') then
    raise exception using errcode = '22023', message = 'Invalid playback action';
  end if;
  if p_action <> 'get' then
    if p_command_id is null or p_expected_revision is null or p_expected_revision < 0 then
      raise exception using errcode = '22023', message = 'Command ID and expected revision required';
    end if;
    perform 1 from public.watch_rooms where id = p_room_id for update;
    -- Recheck inside the transaction after acquiring the room lock.
    if not public.is_room_member(p_room_id) then
      raise exception using errcode = '42501', message = 'Room membership required';
    end if;
  end if;
  select * into state from public.watch_room_playback where room_id = p_room_id;
  stamp := pg_catalog.clock_timestamp();
  if p_action <> 'get' then
    command_payload := pg_catalog.jsonb_build_object('action',p_action,'revision',p_expected_revision,
      'session',p_session_id,'media',p_media,'provider',p_provider,'position',p_position_ms);
    select payload into saved_payload from public.watch_playback_commands
    where room_id = p_room_id and user_id = actor and command_id = p_command_id;
    if found then
      if saved_payload <> command_payload then outcome := 'conflict';
      else outcome := 'duplicate'; end if;
    elsif p_expected_revision <> coalesce(state.revision,0)
       or (p_action <> 'media' and (state.session_id is null or p_session_id is distinct from state.session_id)) then
      outcome := 'conflict';
    else
      if p_action = 'media' then
        if p_media is null or pg_catalog.jsonb_typeof(p_media) <> 'object'
           or coalesce(p_media->>'mediaType','') not in ('movie','tv')
           or coalesce(p_media->>'tmdbId','') !~ '^[1-9][0-9]{0,9}$'
           or pg_catalog.jsonb_typeof(p_media->'tmdbId') is distinct from 'number'
           or pg_catalog.jsonb_typeof(p_media->'title') is distinct from 'string'
           or length(p_media->>'title') not between 1 and 500 then
          raise exception using errcode = '22023', message = 'Invalid playback media';
        end if;
        if (p_media->>'tmdbId')::bigint > 2147483647 then
          raise exception using errcode = '22023', message = 'Invalid TMDB ID';
        end if;
        if p_media->>'mediaType' = 'tv' and (
          pg_catalog.jsonb_typeof(p_media->'season') is distinct from 'number'
          or pg_catalog.jsonb_typeof(p_media->'episode') is distinct from 'number'
          or coalesce(p_media->>'season','') !~ '^(0|[1-9][0-9]{0,3})$'
          or coalesce(p_media->>'episode','') !~ '^[1-9][0-9]{0,3}$') then
          raise exception using errcode = '22023', message = 'Invalid TV episode';
        end if;
        insert into public.watch_room_playback(room_id,session_id,media,provider,status,position_ms,anchor_at,revision)
        values(p_room_id,pg_catalog.gen_random_uuid(),p_media,'cinemaos','paused',0,stamp,coalesce(state.revision,0)+1)
        on conflict (room_id) do update set session_id=excluded.session_id, media=excluded.media,
          provider=excluded.provider,status=excluded.status,position_ms=0,anchor_at=excluded.anchor_at,revision=excluded.revision
        returning * into state;
      else
        if p_action = 'provider' and (p_provider is null or p_provider not in ('cinemaos','vidlink')) then
          raise exception using errcode = '22023', message = 'Invalid provider';
        end if;
        if p_action = 'seek' and (p_position_ms is null or p_position_ms not between 0 and 604800000) then
          raise exception using errcode = '22023', message = 'Invalid seek position';
        end if;
        next_position := least(604800000, greatest(0, state.position_ms + case when state.status = 'playing'
          then floor(extract(epoch from (stamp-state.anchor_at))*1000)::bigint else 0 end));
        update public.watch_room_playback set
          position_ms = case when p_action = 'seek' then p_position_ms else next_position end,
          status = case when p_action = 'play' then 'playing' when p_action in ('pause','provider') then 'paused' else status end,
          provider = case when p_action = 'provider' then p_provider else provider end,
          anchor_at = stamp, revision = revision + 1
        where room_id = p_room_id returning * into state;
      end if;
      insert into public.watch_playback_commands(room_id,user_id,command_id,payload)
      values(p_room_id,actor,p_command_id,command_payload);
    end if;
  end if;
  snapshot := pg_catalog.jsonb_build_object('roomId',p_room_id,'sessionId',state.session_id,
    'media',state.media,'provider',coalesce(state.provider,'cinemaos'),'status',coalesce(state.status,'paused'),
    'positionMs',coalesce(state.position_ms,0),'anchorAt',coalesce(state.anchor_at,stamp),
    'revision',coalesce(state.revision,0),'serverTime',stamp);
  return pg_catalog.jsonb_build_object('outcome',outcome,'state',snapshot);
end;
$$;
revoke all on function public.watch_playback(uuid,text,uuid,bigint,uuid,jsonb,text,bigint) from public, anon;
grant execute on function public.watch_playback(uuid,text,uuid,bigint,uuid,jsonb,text,bigint) to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
    and schemaname='public' and tablename='watch_room_playback') then
    alter publication supabase_realtime add table public.watch_room_playback;
  end if;
end; $$;
commit;
