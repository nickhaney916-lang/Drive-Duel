create table public.game_players (
 room_id uuid not null references public.rooms(id) on delete cascade,
 game_id text not null check (length(game_id) between 1 and 80),
 player_id uuid not null references public.players(id) on delete cascade,
 joined_at timestamptz not null default now(),
 primary key(room_id,game_id,player_id)
);
alter table public.game_players enable row level security;
grant select,insert on public.game_players to authenticated;
create policy "Members read game participants" on public.game_players for select to authenticated
 using (exists(select 1 from public.room_members rm where rm.room_id=game_players.room_id and rm.user_id=(select auth.uid())));
create policy "Players enter games as themselves" on public.game_players for insert to authenticated
 with check (
 exists(select 1 from public.room_members rm where rm.room_id=game_players.room_id and rm.user_id=(select auth.uid()))
 and exists(select 1 from public.players p where p.id=game_players.player_id and p.room_id=game_players.room_id and (p.user_id=(select auth.uid()) or p.is_cpu))
 );
insert into public.game_players(room_id,game_id,player_id)
 select distinct d.room_id,d.game_id,p.player_id from public.predictions p join public.drives d on d.id=p.drive_id where d.game_id is not null
 union select q.room_id,q.game_id,q.player_id from public.queued_predictions q
 on conflict do nothing;