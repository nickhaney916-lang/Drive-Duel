CREATE OR REPLACE FUNCTION public.drive_duel_apply_feed(p_room_id uuid, p_game_id text, p_snapshot jsonb, p_away_score integer, p_home_score integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth'
AS $function$
declare
 st public.room_game_state%rowtype; d public.drives%rowtype; entry jsonb; cur jsonb;
 rev bigint; result jsonb; pending boolean:=false; blocked boolean:=false; deadline timestamptz; bind_number integer; q public.queued_predictions%rowtype; target jsonb; cpu record; cpu_pick text;
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

 -- The state row serializes queue saves against official possession transitions.
 select coalesce(max((x->>'number')::integer),0) into st.latest_source_number
 from jsonb_array_elements(coalesce(p_snapshot->'completed','[]'::jsonb) ||
 case when p_snapshot->'current' is not null and p_snapshot->'current'<>'null'::jsonb then jsonb_build_array(p_snapshot->'current') else '[]'::jsonb end) x;
 for q in select * from public.queued_predictions where room_id=p_room_id and game_id=p_game_id and consumed_at is null for update loop
   select x into target from jsonb_array_elements(coalesce(p_snapshot->'completed','[]'::jsonb) ||
     case when p_snapshot->'current' is not null and p_snapshot->'current'<>'null'::jsonb then jsonb_build_array(p_snapshot->'current') else '[]'::jsonb end) x
     where (x->>'number')::integer>q.after_source_number order by (x->>'number')::integer limit 1;
   if target is null then continue; end if;
   select * into d from public.drives where room_id=p_room_id and game_id=p_game_id and feed_drive_id=target->>'source_id' for update;
   if not found then
     bind_number=(target->>'number')::integer;
     if exists(select 1 from public.drives where room_id=p_room_id and game_id=p_game_id and drive_number=bind_number) then
       select coalesce(max(drive_number),0)+1 into bind_number from public.drives where room_id=p_room_id and game_id=p_game_id;
     end if;
     deadline=clock_timestamp()+interval '30 seconds';
     if target->>'first_play_at' is not null then deadline=least(deadline,(target->>'first_play_at')::timestamptz+interval '30 seconds'); end if;
     if coalesce((target->>'plays')::integer,0)>0 and target->>'first_play_at' is null then deadline=clock_timestamp(); end if;
     insert into public.drives(room_id,game_id,drive_number,quarter,status,feed_drive_id,feed_closed,prediction_deadline)
     values(p_room_id,p_game_id,bind_number,coalesce((target->>'quarter')::integer,1),'in_progress',target->>'source_id',
       coalesce((target->>'terminal')::boolean,false) or target is distinct from p_snapshot->'current',deadline) returning * into d;
   end if;
   if d.status='scored' then raise exception 'Cannot attach a queued pick to an already scored possession'; end if;
   insert into public.predictions(drive_id,player_id,prediction_type,predicted_outcome,is_locked)
   values(d.id,q.player_id,q.prediction_type,q.predicted_outcome,true) on conflict(drive_id,player_id,prediction_type) do nothing;
   for cpu in select id from public.players where room_id=p_room_id and is_cpu=true loop
     cpu_pick=case when q.prediction_type='offense' then (array['Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Safety','Missed Field Goal','End of half/game'])[1+floor(random()*8)::int]
       else (array['Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Force a safety','Force a missed field goal','End without a score'])[1+floor(random()*8)::int] end;
     insert into public.predictions(drive_id,player_id,prediction_type,predicted_outcome,is_locked)
     values(d.id,cpu.id,q.prediction_type,cpu_pick,true) on conflict(drive_id,player_id,prediction_type) do nothing;
   end loop;
   update public.queued_predictions set consumed_drive_id=d.id,consumed_at=clock_timestamp() where id=q.id;
 end loop;
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
 -- An unresolved older result never earns points; a verified newer possession can still become active.
 if st.active_drive_id is not null then
   select * into d from public.drives where id=st.active_drive_id for update;
   if d.status<>'scored' and (p_snapshot->'current'->>'source_id') is distinct from d.feed_drive_id then
     update public.drives set feed_closed=true,status='awaiting_result' where id=d.id;
     pending=true;
     if not exists(select 1 from jsonb_array_elements(coalesce(p_snapshot->'completed','[]'::jsonb)) x where x->>'source_id'=d.feed_drive_id and coalesce((x->>'confirmed')::boolean,false)) then
       blocked=not (p_snapshot->'current'->>'source_id' is not null and coalesce((p_snapshot->'current'->>'number')::integer,0)>d.drive_number);
     end if;
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
 update public.room_game_state set latest_source_number=st.latest_source_number,revision=rev,active_drive_id=st.active_drive_id,game_state=p_snapshot->>'state',
   pending_reason=case when blocked then 'Confirming the completed drive. Picks are closed until the next shared drive.' else null end,
   away_score=p_away_score,home_score=p_home_score,updated_at=clock_timestamp() where room_id=p_room_id and game_id=p_game_id;
 return jsonb_build_object('pending',blocked,'scoring_pending',pending,'active_drive_id',st.active_drive_id,'state',p_snapshot->>'state');
end $function$;
CREATE OR REPLACE FUNCTION public.drive_duel_group_standings(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth'
AS $function$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=auth.uid()) then raise exception 'Group membership required'; end if;
 with points as(
 select d.game_id,pr.player_id,sum(case when pr.is_locked and
 (case when pr.prediction_type='offense' then pr.predicted_outcome
 when pr.predicted_outcome='Force a punt' then 'Punt' when pr.predicted_outcome='Force a turnover' then 'Turnover'
 when pr.predicted_outcome='Stop on downs' then 'Stopped on downs' when pr.predicted_outcome='Hold to a field goal' then 'Field Goal'
 when pr.predicted_outcome='Allow a touchdown' then 'Touchdown' when pr.predicted_outcome='Force a safety' then 'Safety' when pr.predicted_outcome='Force a missed field goal' then 'Missed Field Goal' when pr.predicted_outcome='End without a score' then 'End of half/game' else 'Other' end)=d.actual_outcome
 then 10+case when d.actual_outcome='Touchdown' and d.conversion_success is true then 2 else 0 end when pr.is_locked and pr.predicted_outcome='Other' and d.actual_outcome in ('Safety','Missed Field Goal','End of half/game') then 10 else 0 end)::integer total
 from public.drives d join public.predictions pr on pr.drive_id=d.id where d.room_id=p_room_id and d.status='scored' group by d.game_id,pr.player_id
 ), participants as(
 select game_id,player_id from public.game_players where room_id=p_room_id union select game_id,player_id from points
 ), games as(
 select game_id from public.room_game_state where room_id=p_room_id union select game_id from public.group_game_details where room_id=p_room_id union select game_id from participants
 )
 select coalesce(jsonb_agg(jsonb_build_object(
 'game_id',g.game_id,'name',coalesce(meta.game_name,'Game '||g.game_id),'kickoff',meta.kickoff,'league',meta.league,
 'state',state.game_state,'pending',coalesce(state.pending_reason is not null,false) or exists(select 1 from public.drives d where d.room_id=p_room_id and d.game_id=g.game_id and d.status='awaiting_result'),
 'players',coalesce((select jsonb_agg(jsonb_build_object('player_id',p.id,'user_id',p.user_id,'name',p.player_name,'is_cpu',p.is_cpu,'points',coalesce(pt.total,0)) order by p.created_at)
 from participants gp join public.players p on p.id=gp.player_id left join points pt on pt.game_id=gp.game_id and pt.player_id=gp.player_id where gp.game_id=g.game_id),'[]'::jsonb)
 ) order by meta.kickoff nulls last,g.game_id),'[]'::jsonb) into result
 from games g left join public.group_game_details meta on meta.room_id=p_room_id and meta.game_id=g.game_id
 left join public.room_game_state state on state.room_id=p_room_id and state.game_id=g.game_id;
 return jsonb_build_object('games',result);
end $function$;
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
  if p_prediction_type='offense' and p_predicted_outcome not in ('Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Safety','Missed Field Goal','End of half/game','Other') then raise exception 'Invalid offensive pick'; end if;
  if p_prediction_type='defense' and p_predicted_outcome not in ('Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Force a safety','Force a missed field goal','End without a score','Other') then raise exception 'Invalid defensive pick'; end if;
  insert into public.predictions(drive_id,player_id,predicted_outcome,is_locked,prediction_type)
  values(v_drive.id,v_player.id,p_predicted_outcome,true,p_prediction_type)
  on conflict (drive_id,player_id,prediction_type) do nothing;
  if not exists(select 1 from public.predictions pr where pr.drive_id=v_drive.id and pr.player_id=v_player.id and pr.prediction_type=p_prediction_type and pr.predicted_outcome=p_predicted_outcome and pr.is_locked) then
    raise exception 'This prediction was already locked and cannot be changed';
  end if;
  for v_cpu in select p.* from public.players p where p.room_id=v_drive.room_id and p.is_cpu=true loop
    if not exists(select 1 from public.predictions pr where pr.drive_id=v_drive.id and pr.player_id=v_cpu.id and pr.prediction_type=p_prediction_type) then
      if p_prediction_type='offense' then
        v_cpu_pick := (array['Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Safety','Missed Field Goal','End of half/game'])[1+floor(random()*8)::int];
      else
        v_cpu_pick := (array['Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Force a safety','Force a missed field goal','End without a score'])[1+floor(random()*8)::int];
      end if;
      insert into public.predictions(drive_id,player_id,predicted_outcome,is_locked,prediction_type)
      values(v_drive.id,v_cpu.id,v_cpu_pick,true,p_prediction_type);
    end if;
  end loop;
  return jsonb_build_object('ok',true,'prediction_type',p_prediction_type,'locked',true);
end $function$;
CREATE OR REPLACE FUNCTION public.drive_duel_queue_pick(p_room_id uuid, p_game_id text, p_prediction_type text, p_predicted_outcome text, p_expected_version uuid DEFAULT NULL::uuid, p_cancel boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare uid uuid:=auth.uid(); pl public.players%rowtype; st public.room_game_state%rowtype; q public.queued_predictions%rowtype; anchor integer;
begin
 if uid is null then raise exception 'Sign in first'; end if;
 if not exists(select 1 from public.room_members m where m.room_id=p_room_id and m.user_id=uid) then raise exception 'Room membership required'; end if;
 select * into pl from public.players where room_id=p_room_id and user_id=uid and not coalesce(is_cpu,false);
 if not found then raise exception 'Your player profile is required'; end if;
 if p_prediction_type not in ('offense','defense') then raise exception 'Invalid prediction type'; end if;
 if not p_cancel and ((p_prediction_type='offense' and p_predicted_outcome not in ('Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Safety','Missed Field Goal','End of half/game','Other'))
 or (p_prediction_type='defense' and p_predicted_outcome not in ('Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Force a safety','Force a missed field goal','End without a score','Other')) or p_predicted_outcome is null) then raise exception 'Invalid pick'; end if;
 select * into st from public.room_game_state where room_id=p_room_id and game_id=p_game_id for update;
 if not found or st.latest_source_number is null then raise exception 'Wait for verified possession data, then try again'; end if;
 select * into q from public.queued_predictions where room_id=p_room_id and game_id=p_game_id and player_id=pl.id and prediction_type=p_prediction_type for update;
 if p_expected_version is not null and (q.version is distinct from p_expected_version or q.consumed_at is not null) then raise exception 'This queued pick has already locked or changed. Refresh before making another pick'; end if;
 if p_expected_version is null and q.id is not null and q.consumed_at is null then raise exception 'A queued pick already exists. Refresh before editing it'; end if;
 if p_cancel then
   if p_expected_version is null then raise exception 'Choose the saved pick to cancel'; end if;
   delete from public.queued_predictions where id=q.id;
   return jsonb_build_object('ok',true,'cancelled',true);
 end if;
 if st.game_state='post' then raise exception 'This game has ended'; end if;
 anchor=case when q.id is not null and q.consumed_at is null then q.after_source_number else st.latest_source_number end;
 insert into public.queued_predictions(room_id,game_id,player_id,prediction_type,predicted_outcome,after_source_number)
 values(p_room_id,p_game_id,pl.id,p_prediction_type,p_predicted_outcome,anchor)
 on conflict(room_id,game_id,player_id,prediction_type) do update set predicted_outcome=excluded.predicted_outcome,
 after_source_number=excluded.after_source_number,version=gen_random_uuid(),consumed_drive_id=null,consumed_at=null,updated_at=clock_timestamp()
 returning * into q;
 return jsonb_build_object('ok',true,'version',q.version,'predicted_outcome',q.predicted_outcome,'after_source_number',q.after_source_number);
end $function$;
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
 if p_actual_outcome not in ('Touchdown','Field Goal','Punt','Turnover','Stopped on downs','Safety','Missed Field Goal','End of half/game','Other') then raise exception 'Invalid final drive result'; end if;
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
 when v_prediction.predicted_outcome='Allow a touchdown' then 'Touchdown' when v_prediction.predicted_outcome='Force a safety' then 'Safety' when v_prediction.predicted_outcome='Force a missed field goal' then 'Missed Field Goal' when v_prediction.predicted_outcome='End without a score' then 'End of half/game' else 'Other' end;
 v_points:=case when (v_expected=p_actual_outcome or (v_expected='Other' and p_actual_outcome in ('Safety','Missed Field Goal','End of half/game'))) then 10 else 0 end;
 v_bonus:=case when p_actual_outcome='Touchdown' and p_conversion_success is true and v_expected='Touchdown' then 2 else 0 end;
 update public.players set score=score+v_points+v_bonus where id=v_prediction.scorer_player_id;
 v_total:=v_total+v_points+v_bonus; v_count:=v_count+1;
 end loop;
 update public.drives set status='scored',actual_outcome=p_actual_outcome,conversion_success=case when p_actual_outcome='Touchdown' then p_conversion_success else null end,scored_at=now() where id=v_drive.id;
 select coalesce(jsonb_agg(jsonb_build_object('player_id',p.id,'player_name',p.player_name,'score',p.score,'is_cpu',p.is_cpu) order by p.created_at),'[]'::jsonb)
 into v_scores from public.players p where p.room_id=v_drive.room_id;
 return jsonb_build_object('ok',true,'already_scored',false,'drive_id',v_drive.id,'actual_outcome',p_actual_outcome,'conversion_success',p_conversion_success,'prediction_rows_scored',v_count,'points_awarded_total',v_total,'players',v_scores);
end $function$;