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
-- Invite codes let the second authenticated user join the room.
alter table public.watch_rooms add column if not exists invite_code text;
update public.watch_rooms
set invite_code = lower(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12))
where invite_code is null;
create unique index if not exists watch_rooms_invite_code_key
on public.watch_rooms(invite_code);
alter table public.watch_rooms alter column invite_code set not null;

create or replace function public.create_watch_room(p_name text default 'Our room')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_room public.watch_rooms;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception using errcode = '28000', message = 'Sign-in required';
  end if;
  if length(trim(coalesce(p_name, ''))) < 1 or length(trim(p_name)) > 60 then
    raise exception using errcode = '22023', message = 'Room name must be 1 to 60 characters';
  end if;
  insert into public.watch_rooms(created_by, name, invite_code)
  values (current_user_id, trim(p_name), lower(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12)))
  returning * into new_room;
  insert into public.watch_room_members(room_id, user_id)
  values (new_room.id, current_user_id);
  return pg_catalog.jsonb_build_object('roomId', new_room.id, 'name', new_room.name, 'inviteCode', new_room.invite_code);
end;
$$;

create or replace function public.join_watch_room(p_invite_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_room public.watch_rooms;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception using errcode = '28000', message = 'Sign-in required';
  end if;
  select * into target_room from public.watch_rooms
  where invite_code = lower(trim(coalesce(p_invite_code, '')))
  for update;
  if target_room.id is null then
    raise exception using errcode = 'P0002', message = 'Invite code not found';
  end if;
  insert into public.watch_room_members(room_id, user_id)
  values (target_room.id, current_user_id)
  on conflict (room_id, user_id) do nothing;
  return pg_catalog.jsonb_build_object('roomId', target_room.id, 'name', target_room.name);
end;
$$;

revoke all on function public.create_watch_room(text) from public;
revoke all on function public.join_watch_room(text) from public;
grant execute on function public.create_watch_room(text) to authenticated;
grant execute on function public.join_watch_room(text) to authenticated;
-- Saved room chat. Messages are plain text, visible only to room members.
create table if not exists public.watch_room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id),
  client_message_id uuid not null,
  sender_name text not null,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  unique (room_id, sender_id, client_message_id)
);
create index if not exists watch_room_messages_room_time_idx
on public.watch_room_messages(room_id, created_at desc, id desc);
alter table public.watch_room_messages enable row level security;
drop policy if exists "Room members can read messages" on public.watch_room_messages;
create policy "Room members can read messages"
on public.watch_room_messages for select to authenticated
using (public.is_room_member(room_id));
drop policy if exists "Room members can send their own messages" on public.watch_room_messages;
create policy "Room members can send their own messages"
on public.watch_room_messages for insert to authenticated
with check (sender_id = (select auth.uid()) and public.is_room_member(room_id));
