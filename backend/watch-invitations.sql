-- Apply LAST, after schema.sql, playback.sql and phase2.sql. Safe to reapply.
begin;
create table if not exists public.watch_invitations (
  room_id uuid primary key references public.watch_rooms(id) on delete cascade,
  id uuid not null unique default gen_random_uuid(),
  session_id uuid not null,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  check(sender_id <> recipient_id)
);
alter table public.watch_invitations enable row level security;
revoke all on public.watch_invitations from anon, authenticated;
grant select on public.watch_invitations to authenticated;
drop policy if exists "Couple can read movie invitations" on public.watch_invitations;
create policy "Couple can read movie invitations" on public.watch_invitations for select to authenticated
  using ((auth.uid()=sender_id or auth.uid()=recipient_id) and public.is_room_member(room_id));

create or replace function public.watch_invite(p_room_id uuid, p_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid(); recipient uuid; state public.watch_room_playback; invitation public.watch_invitations;
begin
  if actor is null or not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  perform 1 from public.watch_rooms where id=p_room_id for update;
  select * into state from public.watch_room_playback where room_id=p_room_id for update;
  if state.session_id is distinct from p_session_id or p_session_id is null then
    raise exception using errcode='22023',message='This movie has changed. Choose it again.';
  end if;
  select user_id into recipient from public.watch_room_members where room_id=p_room_id and user_id<>actor;
  if recipient is null then return jsonb_build_object('invited',false); end if;
  select * into invitation from public.watch_invitations where room_id=p_room_id;
  -- An HTTP retry must not turn a pending invitation into repeated notifications.
  if invitation.session_id=p_session_id and invitation.sender_id=actor and invitation.status='pending' and invitation.expires_at>clock_timestamp() then
    return jsonb_build_object('invited',true,'id',invitation.id);
  end if;
  insert into public.watch_invitations(room_id,session_id,sender_id,recipient_id)
    values(p_room_id,p_session_id,actor,recipient)
    on conflict(room_id) do update set id=gen_random_uuid(),session_id=excluded.session_id,sender_id=actor,
      recipient_id=recipient,status='pending',created_at=clock_timestamp(),expires_at=clock_timestamp()+interval '10 minutes'
    returning * into invitation;
  return jsonb_build_object('invited',true,'id',invitation.id);
end $$;

-- Creating the invitation in the playback transaction avoids a selected movie with a lost invite.
create or replace function public.watch_invite_on_selection() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if TG_OP='INSERT' or NEW.session_id is distinct from OLD.session_id then
    perform public.watch_invite(NEW.room_id,NEW.session_id);
  end if;
  return NEW;
end $$;
drop trigger if exists watch_invite_on_selection on public.watch_room_playback;
create trigger watch_invite_on_selection after insert or update of session_id on public.watch_room_playback
for each row execute function public.watch_invite_on_selection();

create or replace function public.watch_invitation_inbox() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'roomId',i.room_id,'sessionId',i.session_id,'senderId',i.sender_id,'recipientId',i.recipient_id,
    'senderName',coalesce(nullif(trim(p.display_name),''),'Your partner'),'status',i.status,
    'media',s.media,'createdAt',i.created_at,'expiresAt',i.expires_at) order by i.created_at desc),'[]'::jsonb))
  from public.watch_invitations i join public.watch_room_playback s on s.room_id=i.room_id and s.session_id=i.session_id
    left join public.profiles p on p.user_id=i.sender_id
  where (i.sender_id=auth.uid() or i.recipient_id=auth.uid()) and public.is_room_member(i.room_id) and i.expires_at>now();
$$;

create or replace function public.watch_respond_invitation(p_id uuid,p_accept boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare invitation public.watch_invitations; selected_room uuid; state public.watch_room_playback; desired text;
begin
  select room_id into selected_room from public.watch_invitations where id=p_id and recipient_id=auth.uid();
  if selected_room is null or not public.is_room_member(selected_room) then
    raise exception using errcode='42501',message='This invitation is not for your account'; end if;
  -- Same lock order as playback selection: room, playback, invitation.
  perform 1 from public.watch_rooms where id=selected_room for update;
  select * into state from public.watch_room_playback where room_id=selected_room for update;
  select * into invitation from public.watch_invitations where id=p_id for update;
  if invitation.id is null or invitation.session_id is distinct from state.session_id or invitation.expires_at<=clock_timestamp() then
    return jsonb_build_object('conflict',true);
  end if;
  if p_accept is null then raise exception using errcode='22023',message='Choose accept or decline'; end if;
  desired := case when p_accept then 'accepted' else 'declined' end;
  if invitation.status<>'pending' and invitation.status<>desired then return jsonb_build_object('conflict',true); end if;
  update public.watch_invitations set status=desired where id=p_id;
  return jsonb_build_object('roomId',selected_room,'sessionId',state.session_id,'status',desired);
end $$;

revoke all on function public.watch_invite(uuid,uuid),public.watch_invitation_inbox(),public.watch_respond_invitation(uuid,boolean),public.watch_invite_on_selection() from public,anon;
grant execute on function public.watch_invite(uuid,uuid),public.watch_invitation_inbox(),public.watch_respond_invitation(uuid,boolean) to authenticated;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='watch_invitations') then
    alter publication supabase_realtime add table public.watch_invitations;
  end if;
end $$;
commit;
