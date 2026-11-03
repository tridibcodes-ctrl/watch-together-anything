-- Apply after schema.sql and playback.sql. Reapply this file LAST on upgrades.
-- Existing duplicate couple rooms are archived, not deleted; history is combined.
begin;
alter table public.watch_rooms add column if not exists canonical_room_id uuid references public.watch_rooms(id);
create table if not exists public.watch_couples (
  user_low uuid not null references auth.users(id),
  user_high uuid not null references auth.users(id),
  room_id uuid not null unique references public.watch_rooms(id),
  primary key(user_low,user_high), check(user_low < user_high)
);
alter table public.watch_couples enable row level security;
revoke all on public.watch_couples from public,anon,authenticated;

-- Serializes pair formation across different candidate rooms as well as retries.
create or replace function public.enforce_room_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare partner uuid; previous_room uuid; lo uuid; hi uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.room_id::text,0));
  if exists(select 1 from public.watch_room_members where room_id=new.room_id and user_id=new.user_id) then return new; end if;
  if exists(select 1 from public.watch_rooms where id=new.room_id and canonical_room_id is not null) then
    raise exception using errcode='22023',message='Use the existing room for this couple';
  end if;
  if (select count(*) from public.watch_room_members where room_id=new.room_id)>=2 then
    raise exception using errcode='22023',message='This room already has two members';
  end if;
  select user_id into partner from public.watch_room_members where room_id=new.room_id limit 1;
  if partner is not null then
    lo:=least(partner,new.user_id); hi:=greatest(partner,new.user_id);
    insert into public.watch_couples values(lo,hi,new.room_id) on conflict(user_low,user_high) do nothing;
    select room_id into previous_room from public.watch_couples where user_low=lo and user_high=hi;
    if previous_room<>new.room_id then
      raise exception using errcode='23505',message='This couple already has a room';
    end if;
  end if;
  return new;
end; $$;

-- Backfill one canonical room per pair. The oldest room wins deterministically.
with paired as (
  select r.id,r.created_at,min(m.user_id::text)::uuid lo,max(m.user_id::text)::uuid hi
  from public.watch_rooms r join public.watch_room_members m on m.room_id=r.id
  where r.canonical_room_id is null group by r.id having count(*)=2
), ranked as (
  select *,first_value(id) over(partition by lo,hi order by created_at,id) canonical from paired
)
insert into public.watch_couples(user_low,user_high,room_id)
select distinct lo,hi,canonical from ranked on conflict(user_low,user_high) do nothing;
update public.watch_rooms r set canonical_room_id=c.room_id
from public.watch_couples c where r.id<>c.room_id and r.canonical_room_id is null
  and exists(select 1 from public.watch_room_members where room_id=r.id and user_id=c.user_low)
  and exists(select 1 from public.watch_room_members where room_id=r.id and user_id=c.user_high);

-- Retain list rows in the archive and copy their union into the canonical list.
insert into public.watch_room_list_items(room_id,media_type,tmdb_id,title,year,overview,poster_path,added_by,created_at,removed_at)
select distinct on(r.canonical_room_id,i.media_type,i.tmdb_id)
  r.canonical_room_id,i.media_type,i.tmdb_id,i.title,i.year,i.overview,i.poster_path,i.added_by,i.created_at,i.removed_at
from public.watch_room_list_items i join public.watch_rooms r on r.id=i.room_id
where r.canonical_room_id is not null
order by r.canonical_room_id,i.media_type,i.tmdb_id,i.removed_at nulls first,i.created_at
on conflict(room_id,media_type,tmdb_id) do update set removed_at=
  case when watch_room_list_items.removed_at is null or excluded.removed_at is null then null else excluded.removed_at end;
-- Chat IDs and message bodies survive; regenerate only colliding retry IDs.
do $$ declare entry record; begin
  for entry in select m.id,r.canonical_room_id from public.watch_room_messages m
    join public.watch_rooms r on r.id=m.room_id where r.canonical_room_id is not null order by m.created_at,m.id
  loop
    update public.watch_room_messages m set client_message_id=pg_catalog.gen_random_uuid()
    where m.id=entry.id and exists(select 1 from public.watch_room_messages c where c.room_id=entry.canonical_room_id
      and c.sender_id=m.sender_id and c.client_message_id=m.client_message_id);
    update public.watch_room_messages set room_id=entry.canonical_room_id where id=entry.id;
  end loop;
end; $$;

create or replace function public.is_room_member(target_room_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.watch_room_members m join public.watch_rooms r on r.id=m.room_id
    where m.room_id=target_room_id and m.user_id=(select auth.uid()) and r.canonical_room_id is null);
$$;

create or replace function public.join_watch_room(p_invite_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target public.watch_rooms; actor uuid:=(select auth.uid()); partner uuid; existing uuid;
begin
  if actor is null then raise exception using errcode='28000',message='Sign-in required'; end if;
  select * into target from public.watch_rooms where invite_code=lower(trim(coalesce(p_invite_code,''))) for update;
  if target.id is null then raise exception using errcode='P0002',message='Invite code not found'; end if;
  if target.canonical_room_id is not null then select * into target from public.watch_rooms where id=target.canonical_room_id for update; end if;
  if exists(select 1 from public.watch_room_members where room_id=target.id and user_id=actor) then
    return pg_catalog.jsonb_build_object('roomId',target.id,'name',target.name,'reused',true);
  end if;
  if (select count(*) from public.watch_room_members where room_id=target.id)>=2 then
    raise exception using errcode='22023',message='This room already has two members';
  end if;
  select user_id into partner from public.watch_room_members where room_id=target.id limit 1;
  begin
    insert into public.watch_room_members(room_id,user_id) values(target.id,actor);
  exception when unique_violation then
    select room_id into existing from public.watch_couples where user_low=least(actor,partner) and user_high=greatest(actor,partner);
    if existing is null then raise; end if;
  end;
  if existing is not null then select * into target from public.watch_rooms where id=existing; end if;
  return pg_catalog.jsonb_build_object('roomId',target.id,'name',target.name,'reused',existing is not null);
end; $$;

create or replace function public.rename_watch_room(p_room_id uuid,p_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.watch_rooms where id=p_room_id for update;
  if not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 60 then raise exception using errcode='22023',message='Room name must be 1 to 60 characters'; end if;
  update public.watch_rooms set name=trim(p_name) where id=p_room_id;
  return pg_catalog.jsonb_build_object('roomId',p_room_id,'name',trim(p_name));
end; $$;
revoke all on function public.rename_watch_room(uuid,text) from public,anon;
grant execute on function public.rename_watch_room(uuid,text) to authenticated;

create or replace function public.get_watch_rooms() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('roomId',r.id,'name',r.name,'inviteCode',r.invite_code,
    'aliases',(select coalesce(jsonb_agg(a.id),'[]'::jsonb) from public.watch_rooms a where a.canonical_room_id=r.id)) order by r.created_at desc,r.id),'[]'::jsonb))
  from public.watch_rooms r where public.is_room_member(r.id);
$$;
revoke all on function public.get_watch_rooms() from public,anon;
grant execute on function public.get_watch_rooms() to authenticated;

create table if not exists public.watch_room_progress (
  room_id uuid not null references public.watch_rooms(id),
  media_type text not null check(media_type in ('movie','tv')),
  tmdb_id integer not null check(tmdb_id>0),
  season integer not null default 0, episode integer not null default 0,
  media jsonb not null, position_ms bigint not null check(position_ms between 0 and 604800000),
  updated_at timestamptz not null default now(), completed_at timestamptz,
  completion_epoch bigint not null default 1,
  primary key(room_id,media_type,tmdb_id,season,episode),
  check((media_type='movie' and season=0 and episode=0) or (media_type='tv' and season between 0 and 9999 and episode between 1 and 9999))
);
create table if not exists public.watch_progress_confirmations (
  room_id uuid not null, media_type text not null, tmdb_id integer not null,season integer not null,episode integer not null,
  epoch bigint not null,user_id uuid not null references auth.users(id),
  primary key(room_id,media_type,tmdb_id,season,episode,epoch,user_id),
  foreign key(room_id,media_type,tmdb_id,season,episode) references public.watch_room_progress(room_id,media_type,tmdb_id,season,episode)
);
alter table public.watch_room_progress enable row level security;
alter table public.watch_progress_confirmations enable row level security;
revoke all on public.watch_room_progress,public.watch_progress_confirmations from public,anon,authenticated;
grant select on public.watch_room_progress to authenticated;
drop policy if exists "Members read shared progress" on public.watch_room_progress;
create policy "Members read shared progress" on public.watch_room_progress for select to authenticated using(public.is_room_member(room_id));

-- No client time reports: progress comes from the authoritative, gated room clock.
create or replace function public.watch_store_progress(p_room_id uuid,p_force boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare s public.watch_room_playback; destination uuid; stamp timestamptz:=pg_catalog.clock_timestamp();
begin
  select * into s from public.watch_room_playback where room_id=p_room_id;
  if s.session_id is null then return; end if;
  select coalesce(canonical_room_id,id) into destination from public.watch_rooms where id=p_room_id;
  insert into public.watch_room_progress(room_id,media_type,tmdb_id,season,episode,media,position_ms,updated_at)
  values(destination,s.media->>'mediaType',(s.media->>'tmdbId')::integer,coalesce((s.media->>'season')::integer,0),coalesce((s.media->>'episode')::integer,0),s.media-'overview'-'posterPath'-'year',
    least(604800000,greatest(0,s.position_ms+case when s.status='playing' then floor(extract(epoch from (stamp-s.anchor_at))*1000)::bigint else 0 end)),stamp)
  on conflict(room_id,media_type,tmdb_id,season,episode) do update
    set media=excluded.media,position_ms=excluded.position_ms,updated_at=excluded.updated_at
    where p_force or (watch_room_progress.updated_at<stamp-interval '15 seconds'
      and (watch_room_progress.position_ms is distinct from excluded.position_ms or watch_room_progress.media is distinct from excluded.media));
end; $$;

-- Freeze stale playing rooms before importing their history. Archived rooms remain intact.
do $$ declare entry record; begin
  for entry in select room_id from public.watch_room_playback order by anchor_at desc loop
    perform public.watch_apply_ready_gate(entry.room_id);
    perform public.watch_store_progress(entry.room_id,false);
  end loop;
end; $$;

create or replace function public.watch_resume_progress() returns trigger
language plpgsql security definer set search_path='' as $$
declare saved bigint;
begin
  if tg_op='UPDATE' and old.session_id is not distinct from new.session_id then return new; end if;
  if tg_op='UPDATE' then perform public.watch_store_progress(old.room_id,true); end if;
  select position_ms into saved from public.watch_room_progress where room_id=new.room_id
    and media_type=new.media->>'mediaType' and tmdb_id=(new.media->>'tmdbId')::integer
    and season=coalesce((new.media->>'season')::integer,0) and episode=coalesce((new.media->>'episode')::integer,0);
  -- Resume position survives a new session; unfinished confirmations do not.
  update public.watch_room_progress set completion_epoch=completion_epoch+1
    where room_id=new.room_id and media_type=new.media->>'mediaType' and tmdb_id=(new.media->>'tmdbId')::integer
    and season=coalesce((new.media->>'season')::integer,0) and episode=coalesce((new.media->>'episode')::integer,0)
    and completed_at is null and exists(select 1 from public.watch_progress_confirmations c
      where c.room_id=watch_room_progress.room_id and c.media_type=watch_room_progress.media_type and c.tmdb_id=watch_room_progress.tmdb_id
        and c.season=watch_room_progress.season and c.episode=watch_room_progress.episode and c.epoch=watch_room_progress.completion_epoch);
  new.position_ms:=coalesce(saved,0);
  return new;
end; $$;
create or replace function public.watch_checkpoint_progress() returns trigger
language plpgsql security definer set search_path='' as $$
declare author uuid;
begin
  perform public.watch_store_progress(new.room_id,true);
  if tg_op='INSERT' or old.session_id is distinct from new.session_id then
    author:=(select auth.uid());
    if author is null then select user_id into author from public.watch_room_members where room_id=new.room_id order by joined_at limit 1; end if;
    if author is not null then
      insert into public.watch_room_list_items(room_id,media_type,tmdb_id,title,year,overview,poster_path,added_by)
      values(new.room_id,new.media->>'mediaType',(new.media->>'tmdbId')::integer,new.media->>'title',coalesce(new.media->>'year',''),coalesce(new.media->>'overview',''),new.media->>'posterPath',author)
      on conflict(room_id,media_type,tmdb_id) do update set removed_at=null;
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists watch_resume_progress on public.watch_room_playback;
create trigger watch_resume_progress before insert or update on public.watch_room_playback for each row execute function public.watch_resume_progress();
drop trigger if exists watch_checkpoint_progress on public.watch_room_playback;
create trigger watch_checkpoint_progress after insert or update on public.watch_room_playback for each row execute function public.watch_checkpoint_progress();

create or replace function public.watch_progress(p_room_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform 1 from public.watch_rooms where id=p_room_id for update;
  if not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  perform public.watch_apply_ready_gate(p_room_id);
  perform public.watch_store_progress(p_room_id,false);
  select coalesce(jsonb_agg(jsonb_build_object('media',p.media,'positionMs',p.position_ms,'updatedAt',p.updated_at,
    'completedAt',p.completed_at,'completionEpoch',p.completion_epoch,'confirmedBy',(
      select coalesce(jsonb_agg(jsonb_build_object('userId',c.user_id,'displayName',coalesce(nullif(trim(f.display_name),''),'Partner'))),'[]'::jsonb)
      from public.watch_progress_confirmations c left join public.profiles f on f.user_id=c.user_id
      where c.room_id=p.room_id and c.media_type=p.media_type and c.tmdb_id=p.tmdb_id and c.season=p.season and c.episode=p.episode and c.epoch=p.completion_epoch
    )) order by p.updated_at desc,p.tmdb_id,p.season,p.episode),'[]'::jsonb) into result
  from public.watch_room_progress p where p.room_id=p_room_id;
  return jsonb_build_object('items',result);
end; $$;

create or replace function public.watch_confirm_completion(p_room_id uuid,p_session_id uuid,p_epoch bigint,p_confirmed boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.watch_room_playback; p public.watch_room_progress; actor uuid:=(select auth.uid()); confirmations integer; stamp timestamptz:=pg_catalog.clock_timestamp();
begin
  perform 1 from public.watch_rooms where id=p_room_id for update;
  if not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  perform public.watch_apply_ready_gate(p_room_id); perform public.watch_store_progress(p_room_id,true);
  select * into s from public.watch_room_playback where room_id=p_room_id;
  if s.session_id is null or s.session_id is distinct from p_session_id then return jsonb_build_object('conflict',true); end if;
  select * into p from public.watch_room_progress where room_id=p_room_id and media_type=s.media->>'mediaType'
    and tmdb_id=(s.media->>'tmdbId')::integer and season=coalesce((s.media->>'season')::integer,0) and episode=coalesce((s.media->>'episode')::integer,0);
  if p.completion_epoch is distinct from p_epoch then return jsonb_build_object('conflict',true); end if;
  if p_confirmed is null then raise exception using errcode='22023',message='Choose confirm or undo'; end if;
  if p_confirmed then
    if (select count(*) from public.watch_room_members where room_id=p_room_id)<>2 then raise exception using errcode='22023',message='Both partners must join the room before confirming completion'; end if;
    insert into public.watch_progress_confirmations values(p.room_id,p.media_type,p.tmdb_id,p.season,p.episode,p.completion_epoch,actor) on conflict do nothing;
    select count(*) into confirmations from public.watch_progress_confirmations c where c.room_id=p.room_id and c.media_type=p.media_type and c.tmdb_id=p.tmdb_id
      and c.season=p.season and c.episode=p.episode and c.epoch=p.completion_epoch;
    if confirmations=2 and p.completed_at is null then
      update public.watch_room_progress set completed_at=stamp where room_id=p.room_id and media_type=p.media_type and tmdb_id=p.tmdb_id and season=p.season and episode=p.episode;
      update public.watch_room_playback set position_ms=least(604800000,greatest(0,position_ms+case when status='playing' then floor(extract(epoch from (stamp-anchor_at))*1000)::bigint else 0 end)),
        status='paused',play_requested=false,anchor_at=stamp,revision=revision+1,ready_epoch=ready_epoch+1 where room_id=p_room_id;
    end if;
  else
    update public.watch_room_progress set completed_at=null,completion_epoch=completion_epoch+1
      where room_id=p.room_id and media_type=p.media_type and tmdb_id=p.tmdb_id and season=p.season and episode=p.episode;
  end if;
  return public.watch_progress(p_room_id);
end; $$;
revoke all on function public.watch_store_progress(uuid,boolean),public.watch_resume_progress(),public.watch_checkpoint_progress() from public,anon,authenticated;
revoke all on function public.watch_progress(uuid),public.watch_confirm_completion(uuid,uuid,bigint,boolean) from public,anon;
grant execute on function public.watch_progress(uuid),public.watch_confirm_completion(uuid,uuid,bigint,boolean) to authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='watch_room_progress') then
    alter publication supabase_realtime add table public.watch_room_progress;
  end if;
end; $$;
notify pgrst,'reload schema';
commit;
