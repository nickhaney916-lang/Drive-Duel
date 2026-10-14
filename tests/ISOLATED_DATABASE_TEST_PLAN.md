# Drive Duel isolated database test plan

Status: preparation only. No production database or application is modified.

## Safety requirements

- Run PostgreSQL/Supabase locally in an ephemeral GitHub Actions runner, not against the hosted Drive Duel project.
- Do not use production Supabase URLs, production publishable keys, service-role keys, or production database passwords.
- Bind the test application to localhost Supabase URLs and locally generated credentials. Verify its resolved URL before creating users, rooms, or predictions.
- Do not run tests/load-realtime.spec.cjs unchanged: it uses the production-configured index.html and could write to the live project.
- Do not use supabase db push, supabase link, or remote deployment commands in this workflow.
- Stop immediately if the local stack cannot start or if a request attempts to reach *.supabase.co.
- Keep Closet Current completely out of scope.

## Database preparation

1. Review SQL scripts under supabase/ and determine their application order and dependencies. The existing supabase/schema.sql includes prototype-wide RLS policies and must not be treated as a secure production migration.
2. Assemble repeatable local migrations for rooms, players, drives, predictions, scoring RPCs, RLS and realtime publication.
3. Start the local Supabase stack using the official CLI in CI and apply migrations locally.
4. Replace hardcoded SUPABASE_URL and SUPABASE_ANON_KEY in a *temporary test-served copy* of index.html, never the deployed production page.
5. Run two separate Playwright browser contexts with real local auth, room membership, websocket subscriptions, locked predictions and settlement.
6. Verify score exactly once per drive, next possession, late/missed picks, and reconnect behavior.
7. Upload traces and logs and tear down the local stack.

## Current coverage

- Isolated mocked 100-player / 78-group Playwright workflow: passed in GitHub Actions run #2, per user-provided screenshot.
- Actual database-backed websocket synchronization: not yet executed or verified.
