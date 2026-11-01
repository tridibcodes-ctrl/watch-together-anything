create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  avatar_key text not null default 'default',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own profile" on public.profiles;
create policy "Users can create their own profile"
on public.profiles for insert to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
on public.profiles for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

-- Each couple gets a separate room. Each room is limited to two members.
create table if not exists public.watch_rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our room',
  created_at timestamptz not null default now()
);
alter table public.watch_rooms drop column if exists singleton;
alter table public.watch_rooms add column if not exists created_by uuid references auth.users(id) on delete set null;

create table if not exists public.watch_room_members (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
alter table public.watch_room_members drop constraint if exists watch_room_members_user_id_key;

create or replace function public.enforce_room_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.room_id::text, 0)
  );
  select count(*) into member_count
  from public.watch_room_members
  where room_id = new.room_id;
  if member_count >= 2 then
    raise exception 'This room already has two members';
  end if;
  return new;
end;
$$;

drop trigger if exists watch_room_members_capacity on public.watch_room_members;
create trigger watch_room_members_capacity
before insert on public.watch_room_members
for each row execute function public.enforce_room_capacity();

create or replace function public.is_room_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.watch_room_members m
    where m.room_id = target_room_id
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;

alter table public.watch_rooms enable row level security;
alter table public.watch_room_members enable row level security;

drop policy if exists "Room members can read the room" on public.watch_rooms;
create policy "Room members can read the room"
on public.watch_rooms for select to authenticated
using (public.is_room_member(id));

drop policy if exists "Room members can read membership" on public.watch_room_members;
create policy "Room members can read membership"
on public.watch_room_members for select to authenticated
using (public.is_room_member(room_id));

-- Room creation and invite endpoints will add members dynamically. Keep user IDs out of this schema.