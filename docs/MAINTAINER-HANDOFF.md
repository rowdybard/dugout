# Dugout project handoff

Updated October 3, 2026. Read [the manual](BOT-MANUAL.md), [the decision engine](DECISION-ENGINE.md) and [release evidence](RELEASE-STATUS.md). Having this file or the source does not grant access to anyone's hosted account.

GitHub: https://github.com/rowdybard/dugout. `main` is the deployed branch. Cloudflare Workers Builds redeploys the site (`dugout`) and the runner (`dugout-paper-runner`) on every push to `main`.

## Current product

- **UI:** `app/page.tsx` renders `components/tennis/tennis-dashboard.tsx`. The view shows college football only (`lib/tennis/leagues.ts`, `VISIBLE_LEAGUES`). The engine and data paths still support ATP/WTA, NFL and MLB.
- **Layout:** game search, the bot card, game tracker, Trades & balance, and a closed Settings & history section.
  - **Bot card:** Steady/Bold/Auto, the Octopus, balance and reset, Pause/Resume/End run/New run, the status box, Both sides, and Open orders & shares.
- **Hosting:** the site is a Cloudflare Worker behind Cloudflare Access with Google sign-in; [CLOUDFLARE-HOSTING.md](CLOUDFLARE-HOSTING.md) has setup.
  - Each invited email gets its own D1 paper account.
  - Background runners are one SQLite Durable Object per account, allowed by `DUGOUT_RUNNER_USERS` / `RUNNER_OWNERS`.
- **Strategy:** the evidence-gated decision engine, mainly paper market making ([DECISION-ENGINE.md](DECISION-ENGINE.md)).
  - **Steady:** resting offers only. After a one-sided fill it pairs or exits within 10 minutes.
  - **Bold:** bigger offers plus hold-to-final bets the evidence allows; after a one-sided fill it pairs, buys once on a 5¢ dip, and has a 10¢ loss limit after that.
  - **Auto:** picks Bold while the research allows a bet on the game and the run is down less than 10%, Steady otherwise (`decideAuto`).
  - **Comeback test:** Bold and Auto paper-trade `comeback-drive@1` (`config.explore`) to measure it.
  - **Octopus** (experimental, `lib/tennis/octopus.ts`): up to 6 extra games in either mode, pinned or auto-picked every 5 minutes, all offers within 50% of the balance with the main game first, logged as tiny JSONL files.
- **Paper only:** real money is not connected (`lib/live/README.md`). Connecting it is the owner's decision.

## Components and authority

| Component | Source |
| --- | --- |
| Dashboard and panels | `components/tennis/` (dashboard, `open-book.tsx`, `octopus-panel.tsx`, `decision-card.tsx`, `use-tennis.ts`) |
| Session engine, resting orders, pairing/exit, Bold rules | `lib/tennis/engine.ts`, `lib/tennis/maker.ts`, `lib/tennis/modes.ts` |
| Decision engine, strategies, evidence | `lib/decision/` |
| Status text, open orders view | `lib/tennis/decision-view.ts`, `lib/tennis/open-book.ts` |
| Game reports | `lib/tennis/priority-context.ts`, `lib/trading/fresh-event.ts` |
| Simulated depth/fee execution | `lib/trading/` |
| Site routes | `app/api/tennis/` |
| Sign-in | `worker/cloudflare-entry.ts`, `lib/server/cloudflare-access.ts` |
| Signed runner proxy, allow-lists, personal key | `lib/runner/` |
| Runner Worker and Durable Object | `services/runner/` |
| D1 schema/migrations | `db/`, `drizzle/` |
| Research (PC) | `research/` (studies, rule miner, Lab GUI) |

## Dated state, not live state

On October 2–3, 2026 the owner's account and invited accounts ran on Cloudflare during live college games.
- **Owner account:** a background runner. The site's D1 holds only its pre-migration snapshot; the runner is authoritative.
- **Observed:** resting offers, a one-sided fill, and the issues fixed that day ([RELEASE-STATUS.md](RELEASE-STATUS.md)).
- **Read live state yourself:** use a fresh export or the dashboard.

## Preserve these constraints

1. **Paper only:** no real orders, automatic AI calls, forced fills or profit promises.
2. **Gates stay:** live resting orders require a game report under 45 s, and are pulled for 30 s after each play. The engine's evidence verdicts decide what is allowed.
3. **Fail closed:** missing or stale reports block entries, never risk exits. The site refuses everyone without valid Access settings.
4. **Runner identity:** keep the Durable Object namespace, the runner fences and each account's epoch. Don't reset write counters or restore browser writes for a migrated account.
5. **No secrets in the repo:** never commit API keys, signing secrets, `.wrangler` state or `.env` files. Secrets go in Cloudflare (type Secret).
6. **Free-plan limits are real:** 10 ms CPU per site request, 100,000 D1 rows written a day, and the runner's own 90,000-row entry pause. Keep per-poll work small.

## Evidence still needed

- A weekend of resting-order results per mode (Steady, Bold, Octopus), reconciled from exports, before any claim about returns.
- Whether Auto's switches and the comeback test help or hurt: compare "AUTO_MODE" decision rows and comeback-drive ledger rows.
- Whether Bold's dip buys and loss-limit exits help or hurt: compare the "Bold dip buy" and "Bold loss limit" ledger rows.
- Behaviour on the Workers Paid plan, if adopted (CPU, writes).
- The PC research items in [STRATEGY-LAB-HANDOFF.md](STRATEGY-LAB-HANDOFF.md) and [STRATEGY-ARCHITECTURE.md](STRATEGY-ARCHITECTURE.md).

Repository-wide lint has pre-existing failures in older files. Changed files are kept lint-clean.

## Editing and publishing

- **Engine changes:** pure engine and rule changes come with focused tests (`tests/maker-bot.test.ts`, `tests/steady.test.ts`, `tests/modes.test.ts` and so on).
- **Before pushing:** run `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm runner:check` and `pnpm build`.
- **Pushing:** a push to `main` deploys both Workers. Check Cloudflare → Workers → Deployments for success.
- **UI changes:** check the page at phone width.
- **Keep docs current:** update this file, the manual and `chad.md` when behaviour changes, and keep dates on historical evidence.
