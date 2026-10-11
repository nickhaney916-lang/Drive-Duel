create table public.group_game_details(
 room_id uuid not null references public.rooms(id) on delete cascade,
 game_id text not null,
 game_name text not null check(length(game_name)<=240),
 kickoff timestamptz not null,
 league text not null check(league in ('nfl','college')),
 primary key(room_id,game_id)
);
alter table public.group_game_details enable row level security;
grant select,insert on public.group_game_details to authenticated;
create policy "Members read game calendar" on public.group_game_details for select to authenticated using(exists(select 1 from public.room_members m where m.room_id=group_game_details.room_id and m.user_id=(select auth.uid())));
create policy "Members save game calendar" on public.group_game_details for insert to authenticated with check(exists(select 1 from public.room_members m where m.room_id=group_game_details.room_id and m.user_id=(select auth.uid())));
create or replace function public.drive_duel_group_standings(p_room_id uuid) returns jsonb language plpgsql security invoker set search_path=public,auth as $fn$
declare result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.room_members where room_id=p_room_id and user_id=auth.uid()) then raise exception 'Group membership required'; end if;
 with points as(
 select d.game_id,pr.player_id,sum(case when pr.is_locked and
 (case when pr.prediction_type='offense' then pr.predicted_outcome
 when pr.predicted_outcome='Force a punt' then 'Punt' when pr.predicted_outcome='Force a turnover' then 'Turnover'
 when pr.predicted_outcome='Stop on downs' then 'Stopped on downs' when pr.predicted_outcome='Hold to a field goal' then 'Field Goal'
 when pr.predicted_outcome='Allow a touchdown' then 'Touchdown' else 'Other' end)=d.actual_outcome
 then 10+case when d.actual_outcome='Touchdown' and d.conversion_success is true then 2 else 0 end else 0 end)::integer total
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
end $fn$;
revoke all on function public.drive_duel_group_standings(uuid) from public,anon;
grant execute on function public.drive_duel_group_standings(uuid) to authenticated;