begin;
set local statement_timeout='90s';
create temp table load_users(n int primary key,uid uuid default gen_random_uuid());
insert into load_users(n) select generate_series(1,100);
insert into auth.users(id,aud,role,is_anonymous) select uid,'authenticated','authenticated',true from load_users;
create temp table load_groups(n int primary key,rid uuid default gen_random_uuid(),code text default upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)));
insert into load_groups(n) select generate_series(1,78);
insert into public.rooms(id,room_code) select rid,code from load_groups;
create temp table load_members as select g.rid,u.uid,u.n user_number,gen_random_uuid() pid from load_groups g join load_users u on g.n=1 or u.n in(select ((g.n*7+i-2)%100)+1 from generate_series(1,8) i);
insert into public.room_members(room_id,user_id) select rid,uid from load_members;
insert into public.players(id,room_id,user_id,player_name,is_cpu) select pid,rid,uid,'Load player '||user_number,false from load_members;
create temp table load_cases(n int,outcome text,defense text,conversion boolean,correct_points int);
insert into load_cases values(1,'Touchdown','Allow a touchdown',true,24),(2,'Touchdown','Allow a touchdown',false,20),(3,'Field Goal','Hold to a field goal',null,20),(4,'Punt','Force a punt',null,20),(5,'Turnover','Force a turnover',null,20),(6,'Stopped on downs','Stop on downs',null,20),(7,'Safety','Force a safety',null,20),(8,'Missed Field Goal','Force a missed field goal',null,20),(9,'End of half/game','End without a score',null,20);
create temp table load_drives as select gen_random_uuid() did,g.rid,'load-game-'||game game_id,c.* from load_groups g cross join generate_series(1,2) game cross join load_cases c;
insert into public.drives(id,room_id,game_id,drive_number,status,feed_closed,prediction_deadline) select did,rid,game_id,n,'in_progress',false,now()+interval '30 seconds' from load_drives;
insert into public.game_players(room_id,game_id,player_id) select rid,'load-game-'||game,pid from load_members cross join generate_series(1,2) game;
insert into public.group_game_details(room_id,game_id,game_name,kickoff,league) select rid,'load-game-'||game,'Load game '||game,now()-(game-1)*interval '1 day','nfl' from load_groups cross join generate_series(1,2) game;
insert into public.room_game_state(room_id,game_id,game_state) select rid,'load-game-'||game,'post' from load_groups cross join generate_series(1,2) game;
insert into public.predictions(drive_id,player_id,prediction_type,predicted_outcome,is_locked)
 select d.did,m.pid,t.type,case when m.user_number%3=0 then case when t.type='offense' then case when d.outcome='Touchdown' then 'Punt' else 'Touchdown' end else case when d.outcome='Touchdown' then 'Force a punt' else 'Allow a touchdown' end end else case when t.type='offense' then d.outcome else d.defense end end,true
 from load_drives d join load_members m on m.rid=d.rid cross join(values('offense'),('defense')) t(type) where m.user_number%5<>0;
do $test$
declare d record;g record;member record;payload jsonb;denied boolean;actual int;expected int;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 for d in select * from load_drives order by n loop
 perform public.drive_duel_score_drive(d.did,d.outcome,d.conversion);
 perform public.drive_duel_score_drive(d.did,d.outcome,d.conversion);
 end loop;
 if exists(select 1 from public.players p join load_members m on m.pid=p.id where p.score<>case when m.user_number%3<>0 and m.user_number%5<>0 then 368 else 0 end) then raise exception 'Score mismatch or duplicate points';end if;
 if (select count(*) from load_users)<>100 or (select count(*) from load_groups)<>78 or (select count(*) from load_members)<>716 or (select count(*) from load_drives)<>1404 then raise exception 'Load coverage mismatch';end if;
 for g in select * from load_groups loop
 select * into member from load_members where rid=g.rid limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member.uid,'role','authenticated')::text,true);
 payload=public.drive_duel_group_standings(g.rid);
 if jsonb_array_length(payload->'games')<>2 then raise exception 'Group game isolation failed';end if;
 select sum((x->>'points')::int) into actual from jsonb_array_elements(payload->'games') a cross join jsonb_array_elements(a->'players') x;
 select count(*)*368 into expected from load_members where rid=g.rid and user_number%3<>0 and user_number%5<>0;
 if actual<>expected then raise exception 'Group leaderboard mismatch';end if;
 end loop;
 select * into g from load_groups where n=2;
 select * into member from load_members m where m.rid=(select rid from load_groups where n=1) and not exists(select 1 from load_members other where other.rid=g.rid and other.uid=m.uid) limit 1;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',member.uid,'role','authenticated')::text,true);
 denied=false;begin perform public.drive_duel_group_standings(g.rid);exception when raise_exception then denied=true;end;
 if not denied then raise exception 'Cross-group privacy failed';end if;
 if (select sum(p.score) from public.players p join load_members m on m.pid=p.id)<>139472 then raise exception 'Grand total mismatch';end if;
end $test$;
rollback;
select jsonb_build_object('passed',true,'identities',100,'groups',78,'memberships',716,'games',156,'scored_possessions',1404,'scoring_calls',2808,'expected_points',139472,'data_rolled_back',true) result;