-- Local-only realtime transport fixture; NOT a production migration.
-- Used exclusively in an ephemeral Supabase instance in GitHub Actions.
create table if not exists public.realtime_probe (
 id uuid primary key default gen_random_uuid(),
 room_code text not null,
 revision integer not null default 0,
 score integer not null default 0,
 updated_at timestamptz not null default now()
);
alter table public.realtime_probe enable row level security;
create policy "local probe read" on public.realtime_probe for select to anon, authenticated using (true);
-- Writes are intentionally service-role only; browser clients must not edit scores.
grant select on public.realtime_probe to anon, authenticated;
do $$
begin
 alter publication supabase_realtime add table public.realtime_probe;
exception when duplicate_object then null;
end $$;
