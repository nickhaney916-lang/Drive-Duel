begin;
alter table public.drives add column if not exists feed_drive_id text;
alter table public.drives add column if not exists feed_closed boolean not null default false;
alter table public.drives add column if not exists prediction_deadline timestamptz;
alter table public.drives add column if not exists pending_result jsonb;
alter table public.drives add column if not exists pending_since timestamptz;
create unique index if not exists drives_source_unique on public.drives(room_id,game_id,feed_drive_id) where feed_drive_id is not null;
create table if not exists public.room_game_state(
 room_id uuid not null references public.rooms(id) on delete cascade,
 game_id text not null, revision bigint not null default -1,
 active_drive_id uuid references public.drives(id),
 game_state text not null default 'pre', pending_reason text,
 away_score integer not null default 0, home_score integer not null default 0,
 updated_at timestamptz not null default now(),
 primary key(room_id,game_id)
);
alter table public.room_game_state enable row level security;
create policy "Room members read automatic game state" on public.room_game_state for select to authenticated
 using(exists(select 1 from public.room_members rm where rm.room_id=room_game_state.room_id and rm.user_id=(select auth.uid())));
grant select on public.room_game_state to authenticated;
grant all on public.room_game_state to service_role;
-- Scores, drive transitions and prediction locks can only be changed by their validated RPCs.
revoke insert,update,delete on public.players,public.drives,public.predictions from anon,authenticated;
CREATE OR REPLACE FUNCTION public.drive_duel_score_drive(p_drive_id uuid, p_actual_outcome text, p_conversion_success boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
 v_uid uuid := auth.uid(); v_drive public.drives%rowtype; v_prediction record;
 v_expected text; v_points integer; v_bonus integer; v_total integer:=0; v_count integer:=0; v_scores jsonb;
begin
 if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Scoring is applied only by the verified live feed'; end if;
 if p_actual_outcome not in ('Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Other') then raise exception 'Invalid final drive result'; end if;
 if p_actual_outcome <> 'Touchdown' and p_conversion_success is not null then raise exception 'Conversion result applies only to touchdowns'; end if;
 select * into v_drive from public.drives d where d.id=p_drive_id for update;
 if not found then raise exception 'Drive not found'; end if;
 if coalesce(auth.jwt()->>'role','') <> 'service_role' and not exists(select 1 from public.room_members rm where rm.room_id=v_drive.room_id and rm.user_id=v_uid)
 and not exists(select 1 from public.players p where p.room_id=v_drive.room_id and p.user_id=v_uid) then raise exception 'You are not a member of this room'; end if;
 if v_drive.status='scored' or v_drive.scored_at is not null then
 return jsonb_build_object('ok',true,'already_scored',true,'drive_id',v_drive.id,'actual_outcome',v_drive.actual_outcome,'scored_at',v_drive.scored_at); end if;
 if p_actual_outcome='Touchdown' and p_conversion_success is null then raise exception 'Wait for the confirmed conversion result'; end if;
 if not exists(select 1 from public.players p where p.room_id=v_drive.room_id) then raise exception 'No players are registered in this room'; end if;
 for v_prediction in select pr.*,pl.id as scorer_player_id from public.predictions pr join public.players pl on pl.id=pr.player_id where pr.drive_id=v_drive.id and pr.is_locked loop
 v_expected:=case when v_prediction.prediction_type='offense' then v_prediction.predicted_outcome
 when v_prediction.predicted_outcome='Force a punt' then 'Punt'
 when v_prediction.predicted_outcome='Force a turnover' then 'Turnover'
 when v_prediction.predicted_outcome='Stop on downs' then 'Stopped on downs'
 when v_prediction.predicted_outcome='Hold to a field goal' then 'Field Goal'
 when v_prediction.predicted_outcome='Allow a touchdown' then 'Touchdown' else 'Other' end;
 v_points:=case when v_expected=p_actual_outcome then 10 else 0 end;
 v_bonus:=case when p_actual_outcome='Touchdown' and p_conversion_success is true and v_expected='Touchdown' then 2 else 0 end;
 update public.players set score=score+v_points+v_bonus where id=v_prediction.scorer_player_id;
 v_total:=v_total+v_points+v_bonus; v_count:=v_count+1;
 end loop;
 update public.drives set status='scored',actual_outcome=p_actual_outcome,conversion_success=case when p_actual_outcome='Touchdown' then p_conversion_success else null end,scored_at=now() where id=v_drive.id;
 select coalesce(jsonb_agg(jsonb_build_object('player_id',p.id,'player_name',p.player_name,'score',p.score,'is_cpu',p.is_cpu) order by p.created_at),'[]'::jsonb)
 into v_scores from public.players p where p.room_id=v_drive.room_id;
 return jsonb_build_object('ok',true,'already_scored',false,'drive_id',v_drive.id,'actual_outcome',p_actual_outcome,'conversion_success',p_conversion_success,'prediction_rows_scored',v_count,'points_awarded_total',v_total,'players',v_scores);
end $function$;

revoke all on function public.drive_duel_score_drive(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.drive_duel_score_drive(uuid,text,boolean) to service_role;
CREATE OR REPLACE FUNCTION public.drive_duel_lock_prediction(p_drive_id uuid, p_prediction_type text, p_predicted_outcome text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare v_uid uuid := auth.uid(); v_room uuid; v_player public.players%rowtype; v_drive public.drives%rowtype; v_cpu public.players%rowtype; v_cpu_pick text;
begin
  if v_uid is null then raise exception 'Sign in first'; end if;
  if p_prediction_type not in ('offense','defense') then raise exception 'Invalid prediction type'; end if;
  select d.* into v_drive from public.drives d where d.id=p_drive_id for update;
  if not found then raise exception 'Drive not found'; end if;
  if v_drive.feed_closed or (v_drive.prediction_deadline is not null and clock_timestamp() >= v_drive.prediction_deadline) then raise exception 'Prediction window closed. Wait for the next shared drive'; end if;
  if v_drive.status <> 'in_progress' then raise exception 'Predictions are closed for this drive'; end if;
  select * into v_player from public.players p where p.room_id=v_drive.room_id and p.user_id=v_uid limit 1;
  if not found then raise exception 'No player profile found for your account in this room'; end if;
  if coalesce(v_player.is_cpu,false) then raise exception 'CPU picks are generated by the server'; end if;
  if p_prediction_type='offense' and p_predicted_outcome not in ('Touchdown','Field Goal','Punt','Turnover','Other') then raise exception 'Invalid offensive pick'; end if;
  if p_prediction_type='defense' and p_predicted_outcome not in ('Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Other') then raise exception 'Invalid defensive pick'; end if;
  insert into public.predictions(drive_id,player_id,predicted_outcome,is_locked,prediction_type)
  values(v_drive.id,v_player.id,p_predicted_outcome,true,p_prediction_type)
  on conflict (drive_id,player_id,prediction_type) do nothing;
  if not exists(select 1 from public.predictions pr where pr.drive_id=v_drive.id and pr.player_id=v_player.id and pr.prediction_type=p_prediction_type and pr.predicted_outcome=p_predicted_outcome and pr.is_locked) then
    raise exception 'This prediction was already locked and cannot be changed';
  end if;
  for v_cpu in select p.* from public.players p where p.room_id=v_drive.room_id and p.is_cpu=true loop
    if not exists(select 1 from public.predictions pr where pr.drive_id=v_drive.id and pr.player_id=v_cpu.id and pr.prediction_type=p_prediction_type) then
      if p_prediction_type='offense' then
        v_cpu_pick := (array['Touchdown','Field Goal','Punt','Turnover','Other'])[1+floor(random()*5)::int];
      else
        v_cpu_pick := (array['Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Other'])[1+floor(random()*6)::int];
      end if;
      insert into public.predictions(drive_id,player_id,predicted_outcome,is_locked,prediction_type)
      values(v_drive.id,v_cpu.id,v_cpu_pick,true,p_prediction_type);
    end if;
  end loop;
  return jsonb_build_object('ok',true,'prediction_type',p_prediction_type,'locked',true);
end $function$;

revoke all on function public.drive_duel_lock_prediction(uuid,text,text) from public,anon;
grant execute on function public.drive_duel_lock_prediction(uuid,text,text) to authenticated;
create or replace function public.drive_duel_apply_feed(p_room_id uuid,p_game_id text,p_snapshot jsonb,p_away_score integer,p_home_score integer)
returns jsonb language plpgsql security invoker set search_path=public,auth as $fn$
declare
 st public.room_game_state%rowtype; d public.drives%rowtype; entry jsonb; cur jsonb;
 rev bigint; result jsonb; pending boolean:=false; blocked boolean:=false; deadline timestamptz; bind_number integer;
begin
 if coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Trusted feed service required'; end if;
 if p_game_id is null or p_game_id='' or not coalesce((p_snapshot->>'available')::boolean,false) then raise exception 'Verified drive history required'; end if;
 if p_away_score<0 or p_home_score<0 then raise exception 'Invalid score'; end if;
 insert into public.room_game_state(room_id,game_id) values(p_room_id,p_game_id) on conflict do nothing;
 select * into st from public.room_game_state where room_id=p_room_id and game_id=p_game_id for update;
 rev=coalesce((p_snapshot->>'revision')::bigint,0);
 if rev<st.revision or p_away_score<st.away_score or p_home_score<st.home_score or (st.game_state='post' and p_snapshot->>'state'<>'post') then
   return jsonb_build_object('pending',true,'reason','Stale or conflicting feed. Keeping the last verified drive.','active_drive_id',st.active_drive_id);
 end if;
 -- Only score a source drive that was actually tracked by this room.
 for entry in select value from jsonb_array_elements(coalesce(p_snapshot->'completed','[]'::jsonb)) loop
   select * into d from public.drives where room_id=p_room_id and game_id=p_game_id and feed_drive_id=entry->>'source_id' for update;
   if not found or d.status='scored' then continue; end if;
   if not coalesce((entry->>'confirmed')::boolean,false) then continue; end if;
   if entry->>'outcome'='Touchdown' and entry->>'conversion_success' is null then continue; end if;
   result=jsonb_build_object('outcome',entry->>'outcome','conversion_success',entry->'conversion_success');
   -- Freeze picks immediately; confirm an unchanged outcome on a later fetch.
   update public.drives set feed_closed=true where id=d.id;
   if d.pending_result is null then
     update public.drives set status='awaiting_result',pending_result=result,pending_since=clock_timestamp() where id=d.id;
     pending=true;continue;
   end if;
   if d.pending_result<>result then
     update public.drives set status='awaiting_result',pending_result=result,pending_since=clock_timestamp() where id=d.id;
     pending=true;continue;
   end if;
   if clock_timestamp()-d.pending_since<interval '2 seconds' then pending=true;continue; end if;
   perform public.drive_duel_score_drive(d.id,entry->>'outcome',(entry->>'conversion_success')::boolean);
 end loop;
 -- A drive disappearing without an explicit completed result never earns points or advances.
 if st.active_drive_id is not null then
   select * into d from public.drives where id=st.active_drive_id for update;
   if d.status<>'scored' and (p_snapshot->'current'->>'source_id') is distinct from d.feed_drive_id then
     update public.drives set feed_closed=true,status='awaiting_result' where id=d.id;
     pending=true;
     if not exists(select 1 from jsonb_array_elements(coalesce(p_snapshot->'completed','[]'::jsonb)) x where x->>'source_id'=d.feed_drive_id and coalesce((x->>'confirmed')::boolean,false)) then blocked=true; end if;
   end if;
 end if;
 cur=p_snapshot->'current';
 if not blocked and cur is not null and cur<>'null'::jsonb and cur->>'source_id' is not null then
   select * into d from public.drives where room_id=p_room_id and game_id=p_game_id and feed_drive_id=cur->>'source_id' for update;
   if not found then
     bind_number=(cur->>'number')::integer;
     -- Do not silently attach old manual picks to a live source drive.
     if exists(select 1 from public.drives where room_id=p_room_id and game_id=p_game_id and drive_number=bind_number) then
       select coalesce(max(drive_number),0)+1 into bind_number from public.drives where room_id=p_room_id and game_id=p_game_id;
     end if;
     deadline=clock_timestamp()+interval '30 seconds';
     if cur->>'first_play_at' is not null then deadline=least(deadline,(cur->>'first_play_at')::timestamptz+interval '30 seconds'); end if;
     if coalesce((cur->>'plays')::integer,0)>0 and cur->>'first_play_at' is null then deadline=clock_timestamp(); end if;
     insert into public.drives(room_id,game_id,drive_number,quarter,status,feed_drive_id,feed_closed,prediction_deadline)
     values(p_room_id,p_game_id,bind_number,(cur->>'quarter')::integer,'in_progress',cur->>'source_id',coalesce((cur->>'terminal')::boolean,false),deadline) returning * into d;
   elsif coalesce((cur->>'terminal')::boolean,false) then
     update public.drives set feed_closed=true,status='awaiting_result' where id=d.id and status<>'scored';
   end if;
   st.active_drive_id=d.id;
 elsif not blocked then
   st.active_drive_id=null;
 end if;
 update public.room_game_state set revision=rev,active_drive_id=st.active_drive_id,game_state=p_snapshot->>'state',
   pending_reason=case when blocked then 'Confirming the completed drive. Picks are closed until the next shared drive.' else null end,
   away_score=p_away_score,home_score=p_home_score,updated_at=clock_timestamp() where room_id=p_room_id and game_id=p_game_id;
 return jsonb_build_object('pending',blocked,'scoring_pending',pending,'active_drive_id',st.active_drive_id,'state',p_snapshot->>'state');
end $fn$;
revoke all on function public.drive_duel_apply_feed(uuid,text,jsonb,integer,integer) from public,anon,authenticated;
grant execute on function public.drive_duel_apply_feed(uuid,text,jsonb,integer,integer) to service_role;
do $$begin alter publication supabase_realtime add table public.room_game_state; exception when duplicate_object then null; end$$;
commit;

revoke all on function public.drive_duel_get_drive(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.drive_duel_get_drive(uuid,text,integer,integer) to service_role;

-- Keep shared state readable to members but writable only by the trusted feed.
revoke all on public.room_game_state from anon, authenticated;
grant select on public.room_game_state to authenticated;
grant all on public.room_game_state to service_role;
