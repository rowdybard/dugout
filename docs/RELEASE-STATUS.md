# Release evidence and known gaps

This records dated observations and test results; it is not a live account-status feed. Newest first.

## October 3, 2026: adaptive Tennis Auto and readable history

- New Auto uses separately registered Recovery/Momentum version 2 experiments: smaller independently confirmed moves, a fixed original dollar loss allowance and exits based on fully executable gains after fees. It has no fixed price target or two-minute holding timer. A confirmed lower-price rebound can permit one additional purchase, with weighted actual purchase costs and the original loss allowance retained. Legacy strategy hashes and saved exit policies remain unchanged.
- Both initial purchases and additions check the shared commitment limit against the resulting balance after fees. Independent review reproduced and corrected an old-quote addition and a case where fees pushed commitments above the resulting 50% cap. Regressions cover pending cancellations, repeated books, JSON persistence, partial exits, settlement and exact purchase/fee accounting.
- Trade and decision history scroll independently. Reading freezes the displayed rows; Show newest resumes updates without changing bot controls. Fill prices, fees, net results and original execution reasons appear separately. Holdings and chart labels update their weighted buy averages after actual fills.
- Verification: **934/934 tests passed**, main and runner TypeScript passed, changed-file ESLint passed, site production build and runner dry-run build passed, and static React rendering checked the history, fee/result labels, average costs and queued additions. Browser and phone-width visual checks were not performed at the owner's request. Hosted account settings were not changed; selecting Auto explicitly upgrades future entries in a saved original run.

## October 3, 2026: game-report audit during Montana State–Idaho

- At 03:52:21 UTC, Polymarket's scoreboard was about 2 seconds old with no drive details. ESPN supplied a correctly parsed Idaho first-and-10 at Montana State's 35, but its play was 48 seconds old. The original 45-second rule and 15-second source-gap rule both rejected it. This was not an absent ESPN feed or a field-direction parsing failure.
- The ESPN play clock stayed at 7:11 across eight plays whose wallclock times and resulting down/field positions advanced. Its `meta.lastUpdatedAt` matched the latest play wallclock; a successful HTTP receipt was not proof of a new play. Retaining Polymarket's clock is necessary. Fetch time and ESPN's later, minute-precision `modified` value must not freshen a play.
- At 03:54:41 UTC, the feeds briefly disagreed after Idaho scored: Polymarket showed 17–19, while ESPN bundled the touchdown and extra point as 17–20. Score disagreement and scoring/kick transitions remain reasons to wait for a complete next-play state.
- The owner approved a 90-second ESPN report allowance and up to 90 seconds behind a matching Polymarket scoreboard. Polymarket remains at 45 seconds, as do receipt ages; ESPN may lead the scoreboard by at most 15 seconds. This allows delayed reports; it does not establish that the current possession is known in real time.
- Audit fixes use one shared source-age policy, remove a hidden second 45-second check on cached engine reports, retain last-reported field display even before an entry-eligible report arrives, and distinguish a successful feed check from a report that cannot authorize a buy. Duplicate UI warnings are consolidated into one primary status. A failed primary request now explicitly blocks already-resting purchases; held exits continue on fresh books.
- At 04:00:53 UTC, another read-only check found Polymarket's 17–20/Q2 scoreboard 355 seconds old and ESPN's matching drive 264 seconds old. Both HTTP requests succeeded. The owner identified this gap as the two-minute warning: an unchanged play during a stoppage is not evidence of a broken connection. The revised policy kept entries blocked and retained Idaho's last touchdown without calling the successful checks failures.
- ESPN's conference/FCS scoreboards were also checked at 04:02:11 UTC. Both matched the event but had different last-play IDs and the same frozen 2:22 clock, with no play wallclock in those responses. Their HTTP Date cannot establish play freshness. Neither justified replacing the timestamped summary or Polymarket clock; the summary's alternate sync URL returned 404.
- Local verification: the complete suite passed **853 tests**, followed by **2 additional passing request-failure regressions**. Main and runner TypeScript, changed-file ESLint, site production build and runner production dry-run build passed. Static React rendering checked the two tabs and a single football freshness notice. No browser or phone-width visual check was performed, as requested.

## October 3, 2026: shared Football and Tennis wallet

- Football and Tennis have independent focus, strategies and controls with one retained cash balance, ledger and account history. Tennis starts idle, with Auto selecting the registered Recovery or Momentum paper experiments. Opening or starting a tab does not reset the wallet.
- Held cost, pending purchases and resting offers share one 50% account limit. Loss stops block both bots; acknowledgement retains history and the original dollar allowance. Reset balance and Sell everything apply account-wide. Existing untagged holdings and historical replay paths remain supported.
- Regression coverage includes actual Tennis signal/stage/fill execution, independent pauses and completed-game behavior, shared reservations, exact loss boundaries, acknowledgement consent, restart windows, historical ATP exits, scoped signed commands and replay. Independent review found and fixed optional Tennis state inheriting Football's timers/orders.
- Deployment is performed through the existing GitHub main branch and checked separately from local validation. No live account controls or balances were changed during development.

## October 3, 2026: Montana drive fallback

- Polymarket's Montana State–Idaho event repeatedly returned a working scoreboard and clock with no drive state. A reviewed ESPN mapping supplies missing drive details while Polymarket retains all scoreboard and market authority.
- The two sources must agree on teams, game, score and quarter. Both report and receipt ages stay within 45 seconds, with a maximum 15-second report-time difference. ESPN's clock is not used. Transitions and incomplete end-of-play states wait for the next complete report.
- Source ages appear separately; last-known drive details stay labeled. New buys wait on unusable context, while book exits and fresh Polymarket score/half exit triggers continue.
- Verification: 787 tests passed, including native Penn State/Pitt fixtures, independent source clocks, stale/conflicting reports, field direction, turnovers, source handoffs, maker/dip buy guards and score-triggered exits. Main TypeScript, runner TypeScript, site build and runner dry-run build passed. Changed-file lint passed after its final constant-binding correction.
- A read-only paired check at 03:30:16 UTC matched Montana correctly but found ESPN's play 54 seconds old; the combined drive was rejected. No automatic live fill is claimed. No account controls, cash or positions were changed during verification. Deployment evidence is recorded separately from these local checks.
- Deployed commit `f5d916d`: GitHub reported successful Cloudflare builds for both `dugout` and `dugout-paper-runner`. Public read-only checks returned the expected site Access redirect and runner authentication rejection; private account contents were not inspected.

## October 2–3, 2026: Cloudflare hosting and live college football

**Hosting**
- The site moved to the owner's Cloudflare account, behind Cloudflare Access with Google sign-in (Access token verified on every request).
- **Deploys:** both Workers deploy from GitHub with Workers Builds.
  - **Build guard:** on Workers Builds, the build refuses to produce an unprotected site.
  - **Sign-in fix:** the Access signing keys are fetched with `redirect: 'manual'`. Workers reject `'error'`, which had broken every sign-in.
- **Runners:** background runners for invited accounts (allow-lists), and an optional personal Polymarket key, encrypted in the account's runner.

**Product**
- **Layout:** game search, the bot card, game tracker, and Trades & balance.
- **Modes:** Steady and Bold.
- **Controls:** Pause/Resume/End run/New run, and Reset balance up to $10,000 at any time.
- **Panels:** the plain-English status box, per-team Both sides, and Open orders & shares.
- **Switching games:** allowed while holding.
- **Chaos mode:** experimental, Steady only, up to 6 extra games, logged as tiny JSONL files.
- **One-sided fills:**
  - Steady pairs or exits within 10 minutes.
  - Bold pairs, buys once on a 5¢ dip (capped at 2× the order size), and sells at 10¢ below its average after a dip buy.

**Found in live use and fixed the same day**
- **Database writes:** the game-list cache rewrote one D1 row per game every 30 s, about 27,000 rows an hour. It now writes about 20× fewer, only when a game changes or every 10 minutes.
- **Runner writes:** about 9 rows per 2.5 s check. Now about 6 per check, and every 10 s before kickoff.
- **Plain 503s:** caused by the site re-parsing large runner state, over the Free plan's 10 ms CPU. It now passes the state through as text.
- **Flickering status box:** a device clock slightly behind the server read fresh checks as stale. Small skew now reads as "just now".
- **Stale game reports for minutes:** reports shared one queue and one 429 pause (2 min on the site) with prices and the game list. Reports now have their own lane, a 15 s pause, a 3 s limit, and the panel shows why a check failed.
- **Second team looked unchecked:** "Both sides" showed the second team as "not checked". Each team now gets its own line.
- **Mode switch lag:** Steady/Bold needed a second tap because it waited on an in-flight check. It now updates instantly.

**Tests:** 709 passing on October 3, plus both TypeScript checks and the build. The page was checked in a browser locally, including at phone width.

**Not established:** profitability, or real-exchange fill quality.


## Accepted-feed status correction

Scoring follow-up: explicit provider down zero now has a separate between-plays state and ordered scoreboard record; it does not fabricate a kick/TD label or playable down. Regression tests cover pending-buy cancellation, next-drive recovery and a new local automatic simulated fill, stale transitions, equal-time conflicts and hidden field markers. The complete 577-test suite passed, including empty-tick transition aging. These synthetic fills are not live automatic fills.

- Observed a newly fetched REST response containing an older, different book than the accepted WebSocket book. The ordering guard rejected it correctly, but runtime health previously reported the rejected receipt's age as quote freshness.
- Runtime quote age now derives from the accepted focused/held book; football report age derives from saved verified report evidence. The UI distinguishes these from runner updates and never substitutes chart timestamps. Flat paused/idle/stopped sessions have explicit labels.
- The WebSocket handshake deadline is cancelled after upgrade, and the subscription explicitly requests unbatched updates. The old lifetime timeout and the fix have regression coverage. Older, conflicting books remain rejected; spread and freshness checks are unchanged.
- Both outcomes remain eligible in the focused game. The decision card adds an expandable comparison of both teams. Out-of-order session responses cannot update runtime/catalog independently of their rejected session snapshot.
- Full suite: **573 tests passed**, zero failed/skipped. Runtime observation at 01:59:30 UTC September 27, before this release: running UMass–Sacramento State, 70 recent quotes per outcome, 19 historical fills, unchanged cash 93.93805, no open position. The current decision rejected an insufficient volatility-adjusted drop. This is not evidence of a completed trade under the new engine.

## Background cutover

The Cloudflare Worker `dugout-paper-runner` was deployed with its SQLite Durable Object namespace and migration tag `v1`. Account migration completed through the authenticated UI while paused and flat; it did not start the bot.

Authenticated before/after exports were reconciled locally. The post-cutover export contained cash 93.93805, 19 historical fills, 4.11 execution fees, 13,130 journal records and 4,373 observations. All 13,103 records in the earlier export and all 4,373 observations retained matching canonical SHA256 payloads. Later rows were 25 decisions, one pause control and one migration checkpoint. Ledger and positions matched, missing observation IDs were empty, and the export was not truncated. Local evidence: `outputs/pre-runner-export-20260926.json`, `outputs/post-runner-export-20260926.json`, and `outputs/reconcile-migrated-export.mjs`. These private account exports are not in the source ZIP.

Old Sites records remain an archive behind the writer fence. Exact prospective replay begins at the migration checkpoint; older records are not automatically exact replay evidence.

## Report-refresh verification

Source `5ac6e98f89755381d9164980ab8556b18efd7ede` was privately published at 23:30:51 UTC; the native Worker was updated at 23:26:24 UTC on September 26.

- A full event response measured 1,115,907 bytes, exceeding the former runner 1 MB cap. A 20-event discovery page measured 7,647,234 bytes. Endpoint-specific bounded caps now accommodate these responses.
- A fixed-event/winner-filter request reduced the selected football report to about 16 KB. Scoped uncached reads removed an observed 30-second CDN delay; original play timestamps remained authoritative.
- A read-only adapter check completed in 191 ms with one matched game, no failures, an 18.161-second-old report, an 80 ms-old REST receipt and a 0.5-cent spread. Its in-memory test account did not trade or change production state.
- The hosted Wisconsin–Penn State field advanced from Wisconsin 36 / 1st & 10 to Wisconsin 40 / 3rd & 6. Report age and Last checked advanced independently; the book refreshed within seconds after selecting the game.
- An uncached response could still contain an 82-second-old kickoff report. Upstream play-report latency remains a limitation.
- A 495-test full suite passed. Three later concurrent-429 regressions passed within 23 targeted tests. Main/runner TypeScript, relevant lint and both production builds passed.

Relevant lint excluded two existing `no-explicit-any` declarations only for `lib/server/polymarket.ts`. This does not mean the repository-wide lint command passes.

## Clean-interface/source-package release

The package removes the active Beginner mode toggle/preference, collapses technical details, and replaces stale current documentation. It also restricts background setup/migration and paid adviser access to the server-configured owner, while retaining separate browser-mode paper accounts for invited visitors. No engine parameters, balances or migration state are changed by this release.

- Full suite: **503 tests passed**, zero failed/skipped.
- Main and runner TypeScript checks passed.
- ESLint passed on all changed TypeScript/TSX files and new/updated tests. This is scoped validation, not a repository-wide lint result.
- Frontend/Sites production build and native runner dry-run production bundle passed.
- New integration tests use actual session, runner and adviser routes with real SQLite. They verify separate customer cash/history, Start/Pause, denied migration without writes, denied adviser calls without database/provider access, missing-pin behavior and retained owner capabilities.
- Tests use synthetic identities. A hosted customer invitation, customer login and complete customer paper run have not been verified. Customer accounts require the page to remain open and visible; this release does not provision customer background runners.

The new `DUGOUT_OWNER_ID` Sites setting must match the existing native `RUNNER_OWNER_ID` before owner setup/adviser controls are available. An absent pin does not remove a writer fence or stop existing runner exit management. Hosted layout/deployment verification is separate from the local checks above.

## Local decision engine verification

The `local-move-v1` engine replaces the current entry decision path with a causal volatility-adjusted recovery scenario. It measures elapsed-time drop magnitude/speed, pre-drop noise, executable bid recovery and its uncertainty, depth imbalance, simulated fees/slippage, spread, delay friction and net scenario headroom versus structural risk. Every assessed opportunity records enter/wait/reject and its measurements. This is an uncalibrated scenario model, not an estimated win probability or demonstrated trading edge.

New fills save adaptive exit evidence, a ratcheting volatility-based profit floor, and immutable loss/holding/delay limits. Confirmed structural failure and exhausted fee-adjusted recovery headroom can request early exits. Existing historical positions retain their old policy. Saved legacy accounts upgrade through a recorded explicit rule command; no implicit account-load migration or automatic Start is introduced.

- Full suite: **564 tests passed**, zero failed/skipped, including 61 new tests.
- Main and runner TypeScript checks, changed-file ESLint, frontend/Sites production build and native runner production dry build passed.
- Both outcomes reached real delayed simulated entry through the reducer; spread/depth/context failures canceled entries without cash debits. An integrated sequence held beyond the old target and closed through a delayed volatility-trail exit with reconciled fees and cash.
- The native SQLite test closed and reopened the database with a pending entry, completed the automatic buy/exit, reopened again, and reproduced every exported replay hash and the full final state. Network access was disabled in that test.
- Twenty-two full-state golden checkpoints captured from the actual pre-change `e160ec8` implementation matched unchanged legacy Auto entry, fill, held rules, exit, reset and rule-update behavior.
- Independent review found and fixed malformed-book rejection and changed-setting versus frozen exit-delay mismatches; regression tests cover both.

These are synthetic execution/replay tests. They do not establish a live entry/exit, profitability, calibrated confidence, or a comparison against later games. Publication/account activation evidence is recorded separately after deployment.

## Not established

- 60 continuous minutes of new-runner live background operation including closed dashboards.
- A new-runner automatic live entry and exit, with full journal reconciliation afterward.
- Profitability or an edge; historical paper fills and tests do not establish either.
- The proposed later-game fixed-candidate versus baseline comparison.
- Uninterrupted free operation. The local 75,000-write entry guard is an estimate; account-wide quotas and other usage can stop service.
- Current Claude model availability, provider pricing or the owner's provider balance. No paid verification call was made.
- Fresh dependency installation and account restoration from the ZIP on a different machine.

The old Clemson monitor remains paused. A new experiment needs explicit dashboard Start and available operating budget. Do not reset history or counters to manufacture acceptance evidence.
