# Drive Duel — phased gameplay improvement plan

Keep Closet Current completely separate. Prefer reliable, understandable gameplay over visual decoration.

## Phase 1 — Make picks easy and trustworthy (in progress)
- [x] One tap immediately attempts server-backed offense or defense save.
- [x] Show **SAVING**, **LOCKED**, **SAVED FOR NEXT DRIVE**, or **NOT SAVED** honestly.
- [ ] On a live game, test separate offense and defense taps against a running possession.
- [ ] Test a tap when the shared window expires; must not score as an on-time locked pick.
- [ ] Test an intentional network failure; selection must not appear saved.
- [ ] Verify Android phone layout with an older/nontechnical player.

**Exit criteria:** A player can join a game, save both picks, and find their saved selections without explanation; no false success states.

## Phase 2 — Clean one-screen dashboard
- Compact verified scoreboard and turf field.
- Current possession and two readable personal picks above extra details.
- Collapse history, CPU picks, timestamps and verbose feed details.
- Make All Games navigation unambiguous; distinguish participated games from LIVE games.

**Exit criteria:** Score, possession, personal picks, and next action are visible without hunting through stacked panels.

## Phase 3 — Confidence in live data and timing
- Audit quarter/clock mismatch between different screen regions.
- Preserve a single trusted feed snapshot and do not invent ball coordinates.
- Validate deadline/possession transitions, queue handoffs, and duplicate saves.

**Exit criteria:** No misleading possession, clock, result, or scoring status.

## Phase 4 — Practice mode
- Isolated simulated drives against a CPU, clearly labeled PRACTICE.
- Do not write practice points into real room leaderboards.
- Reuse one-tap experience to test multiple drives quickly.

## Phase 5 — Fun polish and launch readiness
- Optional compact celebrations for correct picks.
- Simple readable friends/family leaderboard.
- Device accessibility, high contrast, large touch targets, performance, and end-to-end acceptance tests.

These are phase gates, not promises of completion dates. Reprioritize based on confirmed test results.
