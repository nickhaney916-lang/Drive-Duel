begin;
do $test$
declare u uuid:=gen_random_uuid(); r uuid; p uuid; old_id uuid; current_id uuid; reply jsonb;
begin
insert into auth.users(id,aud,role,is_anonymous) values(u,'authenticated','authenticated',true);
perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
reply=public.create_drive_duel_room(upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)),'nfl','Pending recovery test');
r=(reply->>'room_id')::uuid;p=(reply->>'player_id')::uuid;
perform set_config('request.jwt.claims','{"role":"service_role"}',true);
perform public.drive_duel_apply_feed(r,'pending-test','{"available":true,"revision":15,"state":"in","completed":[],"current":{"source_id":"source15","number":15,"quarter":3,"plays":0,"terminal":false}}',20,20);
select active_drive_id into old_id from public.room_game_state where room_id=r;
insert into public.predictions(drive_id,player_id,prediction_type,predicted_outcome,is_locked) values(old_id,p,'offense','Punt',true);
perform public.drive_duel_apply_feed(r,'pending-test','{"available":true,"revision":16,"state":"in","completed":[],"current":null}',20,20);
if (select active_drive_id from public.room_game_state where room_id=r)<>old_id then raise exception 'Unverified gap advanced'; end if;
perform public.drive_duel_apply_feed(r,'pending-test','{"available":true,"revision":25,"state":"in","completed":[],"current":{"source_id":"source25","number":25,"quarter":4,"plays":0,"terminal":false}}',29,26);
select active_drive_id into current_id from public.room_game_state where room_id=r;
if current_id=old_id or (select drive_number from public.drives where id=current_id)<>25 then raise exception 'New verified possession stuck'; end if;
if (select status from public.drives where id=old_id)<>'awaiting_result' or (select score from public.players where id=p)<>0 then raise exception 'Unknown result was scored'; end if;
perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
perform public.drive_duel_lock_prediction(current_id,'offense','Touchdown');
if not exists(select 1 from public.predictions where drive_id=current_id and player_id=p and predicted_outcome='Touchdown') then raise exception 'New possession pick blocked'; end if;
end $test$;
rollback;
select 'PASS: pending old result stays unscored; new verified possession advances and accepts a fresh pick' result;