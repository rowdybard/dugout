# Dugout project handoff

Updated September 26, 2026. Read [the manual](BOT-MANUAL.md) and [release evidence](RELEASE-STATUS.md). Possessing this file or source ZIP does not grant hosted account access.

September 27 UTC follow-up: `2f02e87` passed 573 tests and both builds and was deployed to the dashboard and native Worker. A workerd reproduction confirmed the old upgrade timeout closed an open WebSocket; the handshake timer now clears after upgrade. Production subsequently retained a streaming connection and collected 64 observations per side. At 02:04:44 UTC the account was running, flat, with unchanged cash; stale football context blocked entry. Earlier paused-account statements below describe the dated cutover. This short observation does not complete live acceptance.

GitHub is public at https://github.com/rowdybard/dugout. `main` contains the full project. Original GitHub history was preserved as a merge parent without changing the tested source tree or force-pushing. Sites publication and GitHub pushes are separate: publishing to one does not update the other. Use `git status -sb` for local changes and tracking, and `git log origin/main..HEAD` for unpushed commits after fetching.

## Current product

- Active UI: `app/page.tsx` and `app/tennis/page.tsx` render `components/tennis/tennis-dashboard.tsx`; `/sports` redirects to `/`.
- Sports: ATP/WTA tennis and NFL/CFB football, limited to verified available Polymarket US winner markets. Do not promise every real-world game has a market or complete report.
- Bot-only paper UI. Beginner mode is disabled; technical details/history expand on demand. The old browser beginner preference must not change this.
- Game selection controls the chart. Explicit focus controls future entries. Both outcomes are evaluated, with one open position across the account.
- Dashboard remains on its existing owner-private Sites host. Cloudflare hosts the background paper runner, not a new public dashboard or Google login flow.
- Customer access uses a private hosting invitation and the visitor's own identity. Accounts have separate D1 balances/history. The server-only `DUGOUT_OWNER_ID` restricts background setup and paid adviser access to the existing owner; it must match native `RUNNER_OWNER_ID`. Guests use browser-mode paper checks with the tab open and visible. Chad's invitation and complete customer run remain unverified.

## Components and authority

| Component | Source |
| --- | --- |
| Dashboard/charts | `components/tennis/` |
| Strategy, rules, football assessment | `lib/tennis/` |
| Pure local entry analysis / adaptive exit measurements | `lib/tennis/opportunity.ts`, `lib/tennis/exit-analysis.ts` |
| Recorded UI policy upgrade / optional decision measurements | `lib/tennis/start-control.ts`, `components/tennis/decision-metrics.tsx` |
| Simulated depth/fee execution and source validation | `lib/trading/` |
| Sites HTTP routes | `app/api/tennis/` |
| Signed runner proxy/migration contracts | `lib/runner/` |
| Native Worker and SQLite Durable Object | `services/runner/` |
| Sites D1 schema/migrations | `db/`, `drizzle/` |
| Optional standalone read-only stream service | `services/trading/` |

Legacy manual/research modules remain in source for historical compatibility. Do not describe them as current homepage controls or remove historical journal rows to make the interface look bot-only.

## Versioned decision policy

`config.decisionEngine: 'local-move-v1'` selects the new deterministic local entry analysis. An absent field preserves the old strategy path. `defaultTennisConfig()` remains the legacy factory for compatibility; `defaultLiveTennisConfig()` selects local analysis for fresh server accounts. Reset retains the previous local/legacy policy family. Dashboard Start/Resume records an explicit `update-rules` before starting older accounts, preserving money/risk/rest settings and tightening history/spread/freshness only to the required floors/limits.

The new entry module measures causal pre-drop noise, buyer recovery, depth pressure, executable fees and delay friction. Its return scenario is not a calibrated win probability or expected profit. The exit module uses executable net marks, an upward-only profit floor, structural invalidation and remaining scenario headroom versus measured waiting risk. A fixed `targetReturn` is retained in the snapshot for compatibility but is not a local profit trigger. Original stop and maximum hold remain absolute bounds on the policy; delayed fills can still lose more than a trigger value.

`TennisDecision.analysis` and `exitAnalysis` store serializable measurements. Pending intents carry entry analysis; actual buys save `position.entryAnalysis` and an immutable `exitPlan`, while `exitState` evolves with distinct executable books. Existing legacy positions do not acquire adaptive plans by an incidental settings edit. Optional details select evidence for the displayed game/outcome rather than borrowing a newer result from another game. No model calls are added.

These source changes require their own test/deployment and live validation record. The dated 503-test interface release and earlier runner feed smoke do not validate the new strategy's live behavior or profitability. See release evidence for results actually completed.

## Dated state, not live state

The September 26 cutover transferred 285 resumable chunks. Reconciliation found cash 93.93805, 19 historical fills, 4.11 execution fees, 13,130 journal records and 4,373 observations, with zero missing references in that export. Local dated exports and the reconciliation script remain under ignored `outputs/`; see release evidence. Reread a fresh export before making new state claims.

The account was left paused, flat, with no pending order. No Start was issued during the runner/report-refresh deployment. The old Clemson automation remains paused. Do not restart either automatically.

Report-refresh source `5ac6e98f89755381d9164980ab8556b18efd7ede` was deployed to Sites and the native runner. It uses compact identity-checked football reads with uncached-response evidence, separate report/check timestamps, bounded response sizes, and backoff that cannot be shortened by concurrent 429 responses. Current source also includes the clean-interface/documentation changes in the release record.

## Preserve these constraints

1. Paper only: no real orders, automatic AI calls, forced fills or profit promises.
2. Do not relax the runner's 2-cent spread/5-second book limits or required 45-second football entry context.
3. Preserve tennis, balances, journals, provider ordering, delayed fills, depth and fees. Held positions keep their entry-time exit limits.
4. Missing/stale game reports block relevant entries, not ordinary risk exits. Shadow context exits do not change cash.
5. Preserve the old-writer fence and native namespace. Do not restore stale balances, reset quota counters or enable a paid plan as a repair.
6. Runner Start is an explicit dashboard action. Pause keeps managing held exits; Stop is not guaranteed immediate liquidation.
7. Never include actual API keys, signing secrets, credentials, `.wrangler` state or `.env` files in a source export/commit.

## Evidence still needed

- 60 minutes of genuine new-runner background operation, including closed dashboards, then full journal/cash/fee reconciliation.
- A genuine bot-initiated live entry and exit on that runner; read-only checks are not fills.
- A genuine live entry/exit using `local-move-v1`, with recorded analysis and fee/cash reconciliation; synthetic scenario tests alone are insufficient.
- Later-game comparison of fixed versioned policies against an unchanged baseline; no automatic rule tuning.
- Fresh-install verification on a new machine.
- Current provider model availability/pricing and paid Claude integration; no paid verification call was made.

Repository-wide lint has pre-existing failures. Report actual results rather than claiming that everything is verified.

## Editing and publishing

Change the pure engine/rules with focused regression tests. Test both teams, held-position behavior and unchanged tennis paths. Label synthetic data/results as synthetic. For presentation-only changes, inspect the actual layout and controls.

Run the root README commands. Publish exact tested source to the configured Sites repository and preserve private access. Build/deploy the separate Worker when runner/shared-runtime code changes, preserving bindings and secrets. UI/docs changes alone do not require migration or account restart.

The source archive is not a full backup of live databases. See [distribution notes](DISTRIBUTION.md). Update this file and the manual when behavior changes; retain dates on historical evidence.
