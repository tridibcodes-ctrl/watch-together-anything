-- Apply after schema.sql. Safe to reapply; does not remove existing room data.
begin;
create table if not exists public.watch_room_playback (
  room_id uuid primary key references public.watch_rooms(id) on delete cascade,
  session_id uuid not null,
  media jsonb not null,
  provider text not null check (provider in ('cinesrc', 'cinemaos', 'vidlink')),
  status text not null check (status in ('playing', 'paused')),
  position_ms bigint not null check (position_ms between 0 and 604800000),
  anchor_at timestamptz not null,
  revision bigint not null check (revision > 0)
);
-- Upgrade existing rooms without deleting state or changing their selected provider.
alter table public.watch_room_playback drop constraint if exists watch_room_playback_provider_check;
alter table public.watch_room_playback add constraint watch_room_playback_provider_check
  check (provider in ('cinesrc', 'cinemaos', 'vidlink'));
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

-- Playback intent is separate from the actual clock: waiting rooms stay paused.
alter table public.watch_room_playback add column if not exists play_requested boolean;
update public.watch_room_playback set play_requested = (status = 'playing') where play_requested is null;
alter table public.watch_room_playback alter column play_requested set default false;
alter table public.watch_room_playback alter column play_requested set not null;
alter table public.watch_room_playback add column if not exists ready_epoch bigint not null default 1;
create table if not exists public.watch_playback_readiness (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  session_id uuid not null,
  provider text not null,
  ready_epoch bigint not null,
  ready boolean not null,
  updated_at timestamptz not null,
  primary key(room_id, user_id, client_id)
);
alter table public.watch_playback_readiness enable row level security;
revoke all on public.watch_playback_readiness from anon, authenticated;

create or replace function public.watch_readiness_summary(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare state public.watch_room_playback; members integer; prepared integer;
begin
  select * into state from public.watch_room_playback where room_id = p_room_id;
  select count(*) into members from public.watch_room_members where room_id = p_room_id;
  select count(*) into prepared from public.watch_room_members m
  where m.room_id = p_room_id and exists (
    select 1 from public.watch_playback_readiness r
    where r.room_id=m.room_id and r.user_id=m.user_id and r.session_id=state.session_id
      and r.provider=state.provider and r.ready_epoch=state.ready_epoch and r.ready
      and r.updated_at > pg_catalog.clock_timestamp() - interval '15 seconds'
  ) and not exists (
    select 1 from public.watch_playback_readiness r
    where r.room_id=m.room_id and r.user_id=m.user_id and r.session_id=state.session_id
      and r.provider=state.provider and r.ready_epoch=state.ready_epoch and not r.ready
      and r.updated_at > pg_catalog.clock_timestamp() - interval '15 seconds'
  );
  return pg_catalog.jsonb_build_object('readyCount',prepared,'requiredCount',2,'bothReady',members=2 and prepared=2);
end; $$;

-- Caller holds the room lock. Lease expiry is evaluated by state reads/heartbeats.
create or replace function public.watch_apply_ready_gate(p_room_id uuid, p_bump boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
declare state public.watch_room_playback; summary jsonb; target_status text;
  stamp timestamptz := pg_catalog.clock_timestamp(); freeze_at timestamptz; next_position bigint;
begin
  select * into state from public.watch_room_playback where room_id=p_room_id;
  if state.session_id is null or state.provider not in ('cinesrc','cinemaos') then return; end if;
  summary := public.watch_readiness_summary(p_room_id);
  target_status := case when state.play_requested and (summary->>'bothReady')::boolean then 'playing' else 'paused' end;
  if state.status = target_status then return; end if;
  freeze_at := stamp;
  if state.status = 'playing' and not exists (
    select 1 from public.watch_playback_readiness r where r.room_id=p_room_id
      and r.session_id=state.session_id and r.provider=state.provider and r.ready_epoch=state.ready_epoch
      and not r.ready and r.updated_at > stamp - interval '15 seconds'
  ) then
    -- Do not advance the clock through a long offline interval after leases expire.
    select least(stamp, coalesce(min(last_seen + interval '15 seconds'),stamp)) into freeze_at
    from (
      select max(r.updated_at) last_seen from public.watch_room_members m
      join public.watch_playback_readiness r on r.room_id=m.room_id and r.user_id=m.user_id
      where m.room_id=p_room_id and r.session_id=state.session_id
        and r.provider=state.provider and r.ready_epoch=state.ready_epoch
      group by m.user_id
    ) leases;
  end if;
  next_position := least(604800000,greatest(0,state.position_ms + case when state.status='playing'
    then floor(extract(epoch from (freeze_at-state.anchor_at))*1000)::bigint else 0 end));
  update public.watch_room_playback set status=target_status, position_ms=next_position,
    anchor_at=stamp, ready_epoch=ready_epoch + case when state.status='playing' then 1 else 0 end,
    revision=revision + case when p_bump then 1 else 0 end where room_id=p_room_id;
end; $$;

create or replace function public.watch_playback_snapshot(p_room_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare state public.watch_room_playback; summary jsonb; stamp timestamptz := pg_catalog.clock_timestamp();
begin
  select * into state from public.watch_room_playback where room_id=p_room_id;
  summary := public.watch_readiness_summary(p_room_id);
  return pg_catalog.jsonb_build_object('roomId',p_room_id,'sessionId',state.session_id,
    'media',state.media,'provider',coalesce(state.provider,'cinesrc'),'status',coalesce(state.status,'paused'),
    'positionMs',coalesce(state.position_ms,0),'anchorAt',coalesce(state.anchor_at,stamp),
    'revision',coalesce(state.revision,0),'serverTime',stamp,'readyEpoch',coalesce(state.ready_epoch,1),
    'playRequested',coalesce(state.play_requested,false),'readiness',summary,
    'waitingForReady',state.session_id is not null and state.provider in ('cinesrc','cinemaos') and not (summary->>'bothReady')::boolean);
end; $$;
revoke all on function public.watch_readiness_summary(uuid), public.watch_apply_ready_gate(uuid,boolean), public.watch_playback_snapshot(uuid) from public, anon, authenticated;

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
  if p_action <> 'get' and (p_command_id is null or p_expected_revision is null or p_expected_revision < 0) then
    raise exception using errcode = '22023', message = 'Command ID and expected revision required';
  end if;
  perform 1 from public.watch_rooms where id = p_room_id for update;
  if not public.is_room_member(p_room_id) then
    raise exception using errcode = '42501', message = 'Room membership required';
  end if;
  perform public.watch_apply_ready_gate(p_room_id);
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
        insert into public.watch_room_playback(room_id,session_id,media,provider,status,position_ms,anchor_at,revision,play_requested,ready_epoch)
        values(p_room_id,pg_catalog.gen_random_uuid(),p_media,'cinesrc','paused',0,stamp,coalesce(state.revision,0)+1,false,coalesce(state.ready_epoch,0)+1)
        on conflict (room_id) do update set session_id=excluded.session_id, media=excluded.media,
          provider=excluded.provider,status=excluded.status,position_ms=0,anchor_at=excluded.anchor_at,revision=excluded.revision,play_requested=false,ready_epoch=excluded.ready_epoch
        returning * into state;
      else
        if p_action = 'provider' and (p_provider is null or p_provider not in ('cinesrc','cinemaos','vidlink')) then
          raise exception using errcode = '22023', message = 'Invalid provider';
        end if;
        if p_action = 'seek' and (p_position_ms is null or p_position_ms not between 0 and 604800000) then
          raise exception using errcode = '22023', message = 'Invalid seek position';
        end if;
        next_position := least(604800000, greatest(0, state.position_ms + case when state.status = 'playing'
          then floor(extract(epoch from (stamp-state.anchor_at))*1000)::bigint else 0 end));
        update public.watch_room_playback set
          position_ms = case when p_action = 'seek' then p_position_ms else next_position end,
          status = case when p_action in ('pause','provider','seek') then 'paused' else status end,
          play_requested = case when p_action='play' then true when p_action in ('pause','provider') then false else play_requested end,
          ready_epoch = ready_epoch + case when p_action in ('pause','provider','seek') then 1 else 0 end,
          provider = case when p_action = 'provider' then p_provider else provider end,
          anchor_at = stamp, revision = revision + 1
        where room_id = p_room_id returning * into state;
      end if;
      insert into public.watch_playback_commands(room_id,user_id,command_id,payload)
      values(p_room_id,actor,p_command_id,command_payload);
    end if;
  end if;
  if p_action in ('media','provider') and outcome='ok' then
    delete from public.watch_playback_readiness where room_id=p_room_id;
  end if;
  if p_action <> 'get' and outcome='ok' then perform public.watch_apply_ready_gate(p_room_id,false); end if;
  snapshot := public.watch_playback_snapshot(p_room_id);
  return pg_catalog.jsonb_build_object('outcome',outcome,'state',snapshot);
end;
$$;
revoke all on function public.watch_playback(uuid,text,uuid,bigint,uuid,jsonb,text,bigint) from public, anon;
grant execute on function public.watch_playback(uuid,text,uuid,bigint,uuid,jsonb,text,bigint) to authenticated;

create or replace function public.watch_report_readiness(
  p_room_id uuid, p_session_id uuid, p_provider text, p_epoch bigint,
  p_client_id uuid, p_ready boolean, p_joined boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); state public.watch_room_playback; outcome text := 'ok';
begin
  if actor is null or not public.is_room_member(p_room_id) then
    raise exception using errcode='42501',message='Room membership required';
  end if;
  if p_client_id is null or p_session_id is null or p_ready is null or p_joined is null or p_epoch is null or p_epoch < 1
     or p_provider is null or p_provider not in ('cinesrc','cinemaos') then
    raise exception using errcode='22023',message='Invalid readiness report';
  end if;
  perform 1 from public.watch_rooms where id=p_room_id for update;
  if not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  select * into state from public.watch_room_playback where room_id=p_room_id;
  if not p_joined then
    delete from public.watch_playback_readiness where room_id=p_room_id and user_id=actor and client_id=p_client_id
      and session_id=p_session_id and provider=p_provider;
  elsif state.session_id is distinct from p_session_id or state.provider is distinct from p_provider or state.ready_epoch is distinct from p_epoch then
    outcome := 'conflict';
  else
    delete from public.watch_playback_readiness where room_id=p_room_id and updated_at < pg_catalog.clock_timestamp()-interval '30 minutes';
    insert into public.watch_playback_readiness(room_id,user_id,client_id,session_id,provider,ready_epoch,ready,updated_at)
    values(p_room_id,actor,p_client_id,p_session_id,p_provider,p_epoch,p_ready,pg_catalog.clock_timestamp())
    on conflict(room_id,user_id,client_id) do update set session_id=excluded.session_id,provider=excluded.provider,
      ready_epoch=excluded.ready_epoch,ready=excluded.ready,updated_at=excluded.updated_at;
  end if;
  perform public.watch_apply_ready_gate(p_room_id);
  return pg_catalog.jsonb_build_object('outcome',outcome,'state',public.watch_playback_snapshot(p_room_id));
end; $$;
revoke all on function public.watch_report_readiness(uuid,uuid,text,bigint,uuid,boolean,boolean) from public,anon;
grant execute on function public.watch_report_readiness(uuid,uuid,text,bigint,uuid,boolean,boolean) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
    and schemaname='public' and tablename='watch_room_playback') then
    alter publication supabase_realtime add table public.watch_room_playback;
  end if;
end; $$;
commit;
