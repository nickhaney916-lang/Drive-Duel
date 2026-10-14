# Drive Duel local database dependency audit

Audit date: 2026-10-14. This is an inspection, not a successful local database test.

## Verified dependencies

- `supabase/schema.sql` creates basic `rooms`, `players` and `predictions` tables. Its policies are explicitly labeled prototype-wide and are not production-grade.
- `supabase/automatic-drives.sql` starts by altering `public.drives`, then creates `room_game_state` with foreign keys to `drives` and policies referencing `room_members`. Therefore `schema.sql` followed directly by `automatic-drives.sql` is insufficient.
- `supabase/expanded-outcomes.sql` expects `room_game_state`, `drives`, `queued_predictions`, `room_members`, `game_players` and relevant scoring functions already installed.
- `supabase/queued-picks.sql`, `supabase/game-participants.sql`, and other files need dependency-order review before use.

## Required before executing local realtime probe

1. Identify the authoritative initial multiplayer schema and SQL installation sequence (including `drives` and `room_members`).
2. Build a deterministic migration bundle with a clean-schema smoke test.
3. Configure local Supabase Auth, PostgREST and Realtime; test credentials must never resolve to `*.supabase.co`.
4. Verify SQL score idempotency and websocket delivery from two distinct browser sessions.
5. Do not mark realtime database verification passed until a GitHub Actions log demonstrates it.

No remote SQL was executed during this audit.
