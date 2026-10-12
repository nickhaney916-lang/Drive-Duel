begin;
do $simulation$
declare u uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); legacy uuid:=gen_random_uuid(); r uuid; p uuid; p2 uuid; lp uuid; d uuid; response jsonb; item record; expected integer:=0; n integer:=0; snapshot jsonb; completed jsonb:='[]'; actual integer; denied boolean; entry jsonb; state jsonb;
begin
 insert into auth.users(id,aud,role,is_anonymous) values(u,'authenticated','authenticated',true),(v,'authenticated','authenticated',true),(legacy,'authenticated','authenticated',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 response=public.create_drive_duel_room(upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)),'nfl','Simulation owner');r=(response->>'room_id')::uuid;p=(response->>'player_id')::uuid;
 perform public.add_drive_duel_cpu(r);
 insert into public.room_members(room_id,user_id) values(r,v),(r,legacy);
 insert into public.players(room_id,player_name,user_id,is_cpu) values(r,'Wrong pick player',v,false) returning id into p2;
 insert into public.players(room_id,player_name,user_id,is_cpu) values(r,'Legacy pick player',legacy,false) returning id into lp;
 for item in select * from (values
 ('Touchdown','Allow a touchdown',true,24),('Touchdown','Allow a touchdown',false,20),
 ('Field Goal','Hold to a field goal',null::boolean,20),('Punt','Force a punt',null::boolean,20),
 ('Turnover','Force a turnover',null::boolean,20),('Stopped on downs','Stop on downs',null::boolean,20),
 ('Safety','Force a safety',null::boolean,20),('Missed Field Goal','Force a missed field goal',null::boolean,20),
 ('End of half/game','End without a score',null::boolean,20)
 ) cases(outcome,defense,conversion,points) loop
 n=n+1;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 snapshot=jsonb_build_object('available',true,'revision',n*10,'state','in','completed',completed,'current',jsonb_build_object('source_id','sim-'||n,'number',n,'quarter',least(4,n),'plays',0,'terminal',false));
 perform public.drive_duel_apply_feed(r,'simulation',snapshot,0,0);
 select active_drive_id into d from public.room_game_state where room_id=r and game_id='simulation';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 perform public.drive_duel_lock_prediction(d,'offense',item.outcome);perform public.drive_duel_lock_prediction(d,'defense',item.defense);
 perform public.drive_duel_lock_prediction(d,'offense',item.outcome);
 denied=false;begin perform public.drive_duel_lock_prediction(d,'offense',case when item.outcome='Punt' then 'Touchdown' else 'Punt' end);exception when raise_exception then denied=true;end;
 if not denied then raise exception 'Locked pick was editable';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',v,'role','authenticated')::text,true);
 perform public.drive_duel_lock_prediction(d,'offense',case when item.outcome='Touchdown' then 'Punt' else 'Touchdown' end);
 denied=false;begin perform public.drive_duel_score_drive(d,item.outcome,item.conversion);exception when raise_exception then denied=true;end;
 if not denied then raise exception 'Client could self-score';end if;
 if item.outcome in ('Safety','Missed Field Goal','End of half/game') then
 perform set_config('request.jwt.claims',jsonb_build_object('sub',legacy,'role','authenticated')::text,true);
 perform public.drive_duel_lock_prediction(d,'offense','Other');
 end if;
 entry=jsonb_build_object('source_id','sim-'||n,'number',n,'quarter',least(4,n),'outcome',item.outcome,'conversion_success',item.conversion,'confirmed',true,'terminal',true);
 completed=completed||jsonb_build_array(entry);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 snapshot=jsonb_build_object('available',true,'revision',n*10+1,'state','in','completed',completed,'current',null);
 perform public.drive_duel_apply_feed(r,'simulation',snapshot,0,0);
 if (select status from public.drives where id=d)='scored' then raise exception 'Scored before result confirmation';end if;
 update public.drives set pending_since=clock_timestamp()-interval '3 seconds' where id=d;
 perform public.drive_duel_apply_feed(r,'simulation',snapshot,0,0);
 expected=expected+item.points;
 select score into actual from public.players where id=p;
 if actual<>expected then raise exception 'Wrong simulation total on %: %, expected %',item.outcome,actual,expected;end if;
 perform public.drive_duel_apply_feed(r,'simulation',snapshot,0,0);
 perform public.drive_duel_score_drive(d,item.outcome,item.conversion);
 if (select score from public.players where id=p)<>expected then raise exception 'Duplicate scoring added points';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 denied=false;begin perform public.drive_duel_lock_prediction(d,'offense',item.outcome);exception when raise_exception then denied=true;end;
 if not denied then raise exception 'Late pick accepted';end if;
 end loop;
 if expected<>184 or (select score from public.players where id=p2)<>0 or (select score from public.players where id=lp)<>30 then raise exception 'Fairness or legacy totals failed';end if;
 state=public.drive_duel_group_standings(r);
 select (x->>'points')::int into actual from jsonb_array_elements(state->'games') g cross join jsonb_array_elements(g->'players') x where x->>'player_id'=p::text;
 if actual<>184 then raise exception 'Leaderboard scoring diverged: %',actual;end if;
 select (x->>'points')::int into actual from jsonb_array_elements(state->'games') g cross join jsonb_array_elements(g->'players') x where x->>'player_id'=lp::text;
 if actual<>30 then raise exception 'Legacy leaderboard scoring diverged: %',actual;end if;
end $simulation$;
rollback;
select 'PASS: 9 simulated possessions, 184 correct-pick points, wrong picks 0, legacy Other 30, no late edits, no self-scoring and no duplicate points' result;