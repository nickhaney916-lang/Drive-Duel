-- Drive Duel shared-room foundation
-- Run this entire file in Supabase Dashboard -> SQL Editor -> New query.
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  league text not null default 'nfl' check (league in ('nfl','college')),
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  is_cpu boolean not null default false,
  score integer not null default 0 check (score >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  drive_key text not null,
  pick text not null check (pick in ('Touchdown','Field Goal','Punt','Turnover','Other')),
  locked_at timestamptz not null default now(),
  result text check (result in ('Touchdown','Field Goal','Punt','Turnover','Other')),
  points integer not null default 0 check (points >= 0),
  created_at timestamptz not null default now(),
  unique(player_id, drive_key)
);

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.predictions enable row level security;

-- Prototype access: anyone with the public app can create/join rooms.
-- Replace these broad policies with authenticated, room-scoped policies before public production use.
drop policy if exists "prototype rooms public read" on public.rooms;
create policy "prototype rooms public read" on public.rooms for select to anon, authenticated using (true);
drop policy if exists "prototype rooms public create" on public.rooms;
create policy "prototype rooms public create" on public.rooms for insert to anon, authenticated with check (true);

drop policy if exists "prototype players public read" on public.players;
create policy "prototype players public read" on public.players for select to anon, authenticated using (true);
drop policy if exists "prototype players public add" on public.players;
create policy "prototype players public add" on public.players for insert to anon, authenticated with check (true);
drop policy if exists "prototype players public update" on public.players;
create policy "prototype players public update" on public.players for update to anon, authenticated using (true) with check (true);

drop policy if exists "prototype predictions public read" on public.predictions;
create policy "prototype predictions public read" on public.predictions for select to anon, authenticated using (true);
drop policy if exists "prototype predictions public add" on public.predictions;
create policy "prototype predictions public add" on public.predictions for insert to anon, authenticated with check (true);
drop policy if exists "prototype predictions public update" on public.predictions;
create policy "prototype predictions public update" on public.predictions for update to anon, authenticated using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.rooms to anon, authenticated;
grant select, insert, update on public.players to anon, authenticated;
grant select, insert, update on public.predictions to anon, authenticated;

-- Enable realtime player-list updates.
do $$
begin
  alter publication supabase_realtime add table public.players;
exception when duplicate_object then null;
end $$;
