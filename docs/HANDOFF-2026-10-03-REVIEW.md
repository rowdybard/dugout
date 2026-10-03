# Handoff: dependable limits, history and displays (October 3, 2026)

This covers the ChatGPT review ("Improve Dugout with small, targeted changes") and the Auto mode change before it.

## Where things are

- **Already live:** Auto mode and the comeback test went to `main` in commit `491694a`, before the review arrived, so they are deployed.
- **Not deployed:** the four review commits are on branch `claude/decision-engine-bot-alternative-ifuig1`. Merging that branch into `main` deploys them, since Workers Builds redeploys on every push to `main`.
- **Not touched:** no live account settings, balances or positions.

| Commit | What |
| --- | --- |
| `491694a` (main, live) | **Auto mode:** the bot picks Steady or Bold each check. Bold and Auto also paper-trade the comeback re-entry. |
| `8d17c5e` | Trading safeguards |
| `b99482f` | Traceable live changes |
| `1a5a104` | Dashboard consistency |
| `b6335ac` | Results and history |

**Checks run:** `pnpm test` passes 729 of 729. `tsc`, `pnpm runner:check`, `pnpm build` and `pnpm runner:build` are clean. Lint is clean on every changed file; older files still have their pre-existing lint failures. Not done: a phone-width screenshot.

## What changed and why

### 1. Trading safeguards (`lib/tennis/engine.ts`, `engine-plan.ts`, `maker.ts`)
- **One spending limit:** held shares at cost, a pending buy and every resting offer (main game and Octopus arms) together stay within **50% of the balance** (`SPEND_LIMIT_FRACTION`, `committed()`). Each single bet keeps its 25%/$100 cap. An offer that completes a pair only needs the cash. The owner chose this limit.
  - **What the tests show:** the old code mostly stayed inside the limit too, because the engine's 25% cap on held shares blocked new offers first. The change makes one explicit limit and raises the engine's account cap from 25% to 50%. With bigger balances or the Octopus, more can now rest at once, up to 50%.
- **No fills on closed or stale markets:** before, resting offers and dip buys could fill when the market was closed, suspended or inactive, or its status was out of date. Now they fill only on an open, active market with status under 45 s old (`unfillable()`). Exits and settlement don't use this check.
  - **Side effect:** a Bold pairing offer can't fill on stale status either, so the direct take-profit sale may happen instead.
- **Bold dip buy:**
  - it is limited to what's left of the run's loss allowance, and skipped at the limit (`DIP_BUY_LOSS_LIMIT`);
  - the holding is re-valued right after the buy;
  - only a **filled** dip buy counts. Before, a failed attempt counted, which switched on the 10¢ loss limit. Now a failed attempt waits a minute (`dipTriedAt`).

### 2. Traceable live changes
- **Rule-change record:** every rule change is a `RULES_UPDATED` decision with each setting before and after, the mode before and after, and a plain note on held shares. The session keeps the last 50 changes in `session.ruleChanges`.
- **Terms on each purchase:** every ledger BUY row has `terms` (rules revision, mode, Auto, order size, main or Octopus). A position keeps `openedUnder`.
  - **Scope:** this applies to evidence-engine accounts only, so older replays stay byte for byte.
- **Effect on held shares:** a mode change also changes the one-sided rules for shares already held. Sizes, the Octopus and the focus only change new offers. Open orders & shares shows a recent change and its effect.

### 3. Dashboard
- **One valuation:** the balance, the holdings list and Sell everything use the same valuation (`accountValue`, `priceOf` in `lib/tennis/open-book.ts`), with labels for old, partial and missing prices.
  - **Old prices:** they now show, with their age ("price 40 s old"); the holdings list used to hide them.
  - **Partly priced holdings:** compared with the cost of the priced shares only.
- **Decision card:** shows only the focused game's plan, offers and reason (`focusedEngine`). It used to show the old game's plan, with the new game's team names, after a switch.
- **Error messages:** in browser mode, the routine 2.5 s check used to clear a failed action's message. Now it doesn't.
- **Button help:** one line explains Pause, End run, Sell everything and Reset balance.

### 4. Results and history
- **Resting-order trades in the scorecard:** closed resting-order holdings now appear, grouped by mode, main game or Octopus, and rules revision. Older holdings show as "before tracking".
  - Each holding is one trade, so a pair shows as one win and one loss. Total P&L is the meaningful number.
- **Verdicts need enough games:** a verdict now needs enough trades **and** enough different games (`minGames` from each spec).
- **Paper-fill note:** `PAPER_FILLS` states how paper fills are simulated, on the scorecard and in both downloads.
  - A resting offer fills in full when the best ask reaches its price; queue position is not modelled, so real fills would be fewer.
- **Runner export pages:** they stop at about 4 MB, and only the first page carries the session snapshot. The site's downloader already reads it from there.
- **Idle polling:** background-runner accounts that are stopped or not started, with nothing held or pending, are polled every 30 s instead of 2.5 s. The runner's own alarm already stopped in that state.

## Not done or uncertain

- **Docs:** `chad.md`, `docs/BOT-MANUAL.md` and `docs/DECISION-ENGINE.md` describe Auto but not yet the review changes: the 50% limit, the stale-market rule, the dip-buy fixes, the rule-change history and the valuation labels. Update them before or right after merging.
- **Not checked by eye:** the new help line and price labels at phone width.
- **Maker strategy in reports:** it is read from the current `config.maker`, not saved per purchase. A switch between resting-order strategies would be scored under the current one.
- **Export byte cap:** it counts journal row bytes only. Price evidence fetched separately for older (non-bundle) rows is not counted.
- **Untested hooks:** the engine card and `use-tennis` hook changes have no component tests (the repo has no React test setup). The pure helpers behind them are tested.
- **How realistic paper fills are** is still unknown, and so is whether the 50% limit leaves the Octopus enough room. Compare results from the reports' "mode · game · rules" groups after a weekend.

## To deploy

Merge `claude/decision-engine-bot-alternative-ifuig1` into `main` (or ask Claude to). Then check Cloudflare → Workers → Deployments for both `dugout` and `dugout-paper-runner`.
