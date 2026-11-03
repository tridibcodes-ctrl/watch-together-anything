-- Apply after schema.sql / phase2.sql. Ephemeral liveness only; preserves all movie data.
begin;
create table if not exists public.watch_presence_leases (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null,
  seen_at timestamptz not null default now(),
  primary key(user_id,client_id)
);
alter table public.watch_presence_leases enable row level security;
revoke all on public.watch_presence_leases from anon,authenticated;
grant select on public.watch_presence_leases to authenticated;
create or replace function public.watch_presence_visible(p_user_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and (p_user_id=auth.uid() or exists(
    select 1 from public.watch_room_members m where m.user_id=p_user_id and public.is_room_member(m.room_id)));
$$;
drop policy if exists "Room partners can read presence" on public.watch_presence_leases;
create policy "Room partners can read presence" on public.watch_presence_leases for select to authenticated using (public.watch_presence_visible(user_id));
create or replace function public.watch_presence(p_room_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
  if actor is null then raise exception using errcode='42501',message='Sign-in required'; end if;
  if p_room_id is not null and not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  return jsonb_build_object('members',coalesce((select jsonb_agg(jsonb_build_object(
    'userId',p.user_id,'displayName',coalesce(nullif(trim(p.display_name),''),'Partner'),'avatarKey',p.avatar_key,
    'online',exists(select 1 from public.watch_presence_leases l where l.user_id=p.user_id and l.seen_at>now()-interval '45 seconds')) order by p.user_id)
    from public.profiles p where (p_room_id is null and p.user_id=actor) or (p_room_id is not null and exists(
      select 1 from public.watch_room_members m where m.room_id=p_room_id and m.user_id=p.user_id))),'[]'::jsonb),
    'serverTime',now(),'leaseSeconds',45);
end $$;
create or replace function public.watch_presence_heartbeat(p_client_id uuid,p_online boolean,p_room_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
  if actor is null then raise exception using errcode='42501',message='Sign-in required'; end if;
  if p_client_id is null or p_online is null then raise exception using errcode='22023',message='Client and online state required'; end if;
  if p_room_id is not null and not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  -- Serialise only this account's tabs; a closing tab cannot mark its other tabs offline.
  perform pg_advisory_xact_lock(hashtextextended(actor::text,317));
  delete from public.watch_presence_leases where user_id=actor and seen_at<clock_timestamp()-interval '45 seconds';
  if p_online then
    if not exists(select 1 from public.watch_presence_leases where user_id=actor and client_id=p_client_id)
      and (select count(*) from public.watch_presence_leases where user_id=actor)>=12 then
      raise exception using errcode='22023',message='Too many active tabs';
    end if;
    insert into public.watch_presence_leases(user_id,client_id,seen_at) values(actor,p_client_id,clock_timestamp())
      on conflict(user_id,client_id) do update set seen_at=excluded.seen_at;
  else delete from public.watch_presence_leases where user_id=actor and client_id=p_client_id;
  end if;
  return public.watch_presence(p_room_id);
end $$;
revoke all on function public.watch_presence_visible(uuid),public.watch_presence(uuid),public.watch_presence_heartbeat(uuid,boolean,uuid) from public,anon;
grant execute on function public.watch_presence_visible(uuid),public.watch_presence(uuid),public.watch_presence_heartbeat(uuid,boolean,uuid) to authenticated;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='watch_presence_leases') then
    alter publication supabase_realtime add table public.watch_presence_leases;
  end if;
end $$;
commit;
