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
     cpu_pick=case when q.prediction_type='offense' then (array['Touchdown','Field Goal','Punt','Turnover','Other'])[1+floor(random()*5)::int]
       else (array['Force a punt','Force a turnover','Stop on downs','Hold to a field goal','Allow a touchdown','Other'])[1+floor(random()*6)::int] end;
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
end $function$
