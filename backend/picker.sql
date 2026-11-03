-- Apply after the existing room migrations. No existing room data is changed.
begin;
create table if not exists public.watch_room_picker (
  room_id uuid primary key references public.watch_rooms(id) on delete cascade,
  round_id uuid not null,
  mode text not null check(mode in ('genre','title','trending')),
  revision bigint not null default 1,
  options jsonb not null default '[]',
  submissions jsonb not null default '{}',
  result jsonb,
  result_index integer,
  spin_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.watch_room_picker enable row level security;
revoke all on public.watch_room_picker from anon,authenticated;
grant select on public.watch_room_picker to authenticated;
drop policy if exists "Members read their picker" on public.watch_room_picker;
create policy "Members read their picker" on public.watch_room_picker for select to authenticated using(public.is_room_member(room_id));

create or replace function public.watch_picker_snapshot(p_room_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.watch_room_picker; people jsonb; pool jsonb; ready boolean;
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  select * into s from public.watch_room_picker where room_id=p_room_id;
  select coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'displayName',coalesce(nullif(trim(p.display_name),''),'Partner'),
    'submitted',coalesce(s.submissions ? m.user_id::text,false),'choices',coalesce(s.submissions->m.user_id::text,'[]'::jsonb)) order by m.user_id),'[]'::jsonb)
    into people from public.watch_room_members m left join public.profiles p on p.user_id=m.user_id where m.room_id=p_room_id;
  ready := jsonb_array_length(people)=2 and not exists(select 1 from jsonb_array_elements(people) p where not (p->>'submitted')::boolean);
  if s.mode='title' then
    select coalesce(jsonb_agg(item order by item->>'key'),'[]'::jsonb) into pool from (
      select distinct on (c->>'key') c as item from jsonb_each(coalesce(s.submissions,'{}')) sub,
      jsonb_array_elements(sub.value) c order by c->>'key',sub.key
    ) choices;
  else
    select coalesce(jsonb_agg(o.value order by o.ordinality),'[]'::jsonb) into pool from jsonb_array_elements(coalesce(s.options,'[]')) with ordinality o
      where s.mode<>'genre' or not exists(select 1 from jsonb_each(s.submissions) sub,jsonb_array_elements_text(sub.value) c where c=o.value->>'key');
  end if;
  return jsonb_build_object('roomId',p_room_id,'roundId',s.round_id,'revision',coalesce(s.revision,0),'mode',s.mode,'options',coalesce(s.options,'[]'),
    'members',people,'pool',pool,'ready',ready,'result',s.result,'resultIndex',s.result_index,'spinAt',s.spin_at,'serverTime',clock_timestamp());
end $$;

create or replace function public.watch_picker(
  p_room_id uuid,p_action text default 'get',p_round_id uuid default null,p_expected_round_id uuid default null,
  p_mode text default null,p_options jsonb default '[]',p_choices jsonb default '[]'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); s public.watch_room_picker; snap jsonb; option jsonb; n integer;
begin
  if actor is null or not public.is_room_member(p_room_id) then raise exception using errcode='42501',message='Room membership required'; end if;
  if p_action='get' then return public.watch_picker_snapshot(p_room_id); end if;
  perform 1 from public.watch_rooms where id=p_room_id for update;
  select * into s from public.watch_room_picker where room_id=p_room_id for update;
  if p_action='start' then
    if p_round_id is null or p_mode is null or p_mode not in ('genre','title','trending') or jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options)>80 then
      raise exception using errcode='22023',message='Invalid picker round'; end if;
    if s.round_id=p_round_id then return public.watch_picker_snapshot(p_room_id); end if;
    if s.round_id is distinct from p_expected_round_id then return jsonb_build_object('conflict',true); end if;
    if p_mode<>'title' and jsonb_array_length(p_options)=0 then raise exception using errcode='22023',message='No options available'; end if;
    for option in select * from jsonb_array_elements(p_options) loop
      if jsonb_typeof(option) is distinct from 'object' or coalesce(length(option->>'key'),0) not between 1 and 160 or coalesce(length(option->>'title'),0) not between 1 and 250 then
        raise exception using errcode='22023',message='Invalid picker option'; end if;
    end loop;
    if (select count(distinct value->>'key') from jsonb_array_elements(p_options))<>jsonb_array_length(p_options) then raise exception using errcode='22023',message='Duplicate picker option'; end if;
    insert into public.watch_room_picker(room_id,round_id,mode,options) values(p_room_id,p_round_id,p_mode,case when p_mode='title' then '[]'::jsonb else p_options end)
      on conflict(room_id) do update set round_id=excluded.round_id,revision=watch_room_picker.revision+1,mode=excluded.mode,options=excluded.options,submissions='{}',result=null,result_index=null,spin_at=null,updated_at=clock_timestamp();
  elsif p_action in ('submit','spin') then
    if p_round_id is null or s.round_id is distinct from p_round_id then return jsonb_build_object('conflict',true); end if;
    if s.result is not null then return public.watch_picker_snapshot(p_room_id); end if;
    if p_action='submit' then
      if jsonb_typeof(p_choices) is distinct from 'array' or jsonb_array_length(p_choices)>80 then raise exception using errcode='22023',message='Invalid choices'; end if;
      if s.mode='genre' then
        for option in select * from jsonb_array_elements(p_choices) loop
          if jsonb_typeof(option) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(s.options) o where o->>'key'=option#>>'{}') then
            raise exception using errcode='22023',message='Choose a listed genre'; end if;
        end loop;
      elsif s.mode='title' then
        if jsonb_array_length(p_choices) not between 2 and 10 or (select count(distinct value->>'key') from jsonb_array_elements(p_choices))<>jsonb_array_length(p_choices) then
          raise exception using errcode='22023',message='Choose at least two different titles (maximum ten)'; end if;
        for option in select * from jsonb_array_elements(p_choices) loop
          if coalesce(option->>'mediaType','') not in ('movie','tv') or coalesce(option->>'tmdbId','') !~ '^[1-9][0-9]{0,9}$'
            or coalesce(option->>'key','')<>concat(option->>'mediaType',':',option->>'tmdbId') or coalesce(length(option->>'title'),0) not between 1 and 250 then
            raise exception using errcode='22023',message='Invalid movie or series'; end if;
        end loop;
      elsif jsonb_array_length(p_choices)<>0 then raise exception using errcode='22023',message='Trending uses its shared list';
      end if;
      update public.watch_room_picker set submissions=jsonb_set(submissions,array[actor::text],p_choices),revision=revision+1,updated_at=clock_timestamp() where room_id=p_room_id;
    else
      snap:=public.watch_picker_snapshot(p_room_id);
      if not (snap->>'ready')::boolean then raise exception using errcode='22023',message='Both partners must submit first'; end if;
      n:=jsonb_array_length(snap->'pool');if n=0 then raise exception using errcode='22023',message='All genres were excluded. Edit choices or try Trending This Week.'; end if;
      n:=floor(random()*n)::integer;
      update public.watch_room_picker set result=(snap->'pool')->n,result_index=n,spin_at=clock_timestamp()+interval '3 seconds',revision=revision+1,updated_at=clock_timestamp() where room_id=p_room_id;
    end if;
  else raise exception using errcode='22023',message='Unknown picker action';
  end if;
  return public.watch_picker_snapshot(p_room_id);
end $$;
revoke all on function public.watch_picker_snapshot(uuid),public.watch_picker(uuid,text,uuid,uuid,text,jsonb,jsonb) from public,anon;
grant execute on function public.watch_picker_snapshot(uuid),public.watch_picker(uuid,text,uuid,uuid,text,jsonb,jsonb) to authenticated;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='watch_room_picker') then
    alter publication supabase_realtime add table public.watch_room_picker;
  end if;
end $$;
commit;
