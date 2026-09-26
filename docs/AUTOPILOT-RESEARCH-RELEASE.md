> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Automatic selection and analysis — September 23, 2026

The main workspace now starts with a separate $10 paper bankroll. The bot selects eligible pregame full-game winner markets and evaluates both outcomes. It does not make real-money orders. Its balance and proceeds are independent of the original $100 manual paper profile.

## Decision system

`lib/bot/engine.ts` is shared by the site API and the standalone Node runner. Each cycle manages exits before considering a new entry. New sessions freeze the `paper-research-v2` configuration: one position, $2 fee-inclusive entry budget, $2 session loss limit, a five-point dip, a 1.5-point recovery and two confirming observations. These thresholds are experimental, not optimized profit claims.

An actual MLB team-results model supplies a pregame outcome estimate. Its parameters were selected on early 2025 games; later 2025 games were held out, followed by a separate chronological 2026 evaluation. Source captures, hashes, training script, prediction records, calibration and limitations live in `research/mlb-elo`. All predictions for a given day precede updates from that day. Current-day results never enter the frozen ratings.

The US API's documented long-side team is matched explicitly to official MLB team identities. No cross-provider ID assumption, slug guess or home/away ordering determines the YES outcome. New entries require the selected side's estimate to exceed executable entry price plus fees by three percentage points. This is an outcome-model filter, not a prediction that a short-term profit target will be reached.

The bot also requires independently received, current sports evidence, reported pitchers, injury-feed availability, sufficient price history and executable depth. Changed pitcher/passers or relevant injury facts remain quarantined rather than receiving an invented numerical impact. Initial repeated cached responses do not count as new evidence. It checks that an immediate exit would not already breach its loss rule and that the hypothetical old-price recovery could cover estimated round-trip costs.

## Ledger and controls

- Entries, exits, fees, partial fills, settlement and decision records persist with a profile compare-and-swap. A raced request cannot spend cash twice.
- Pause stops new entries while retaining exit management. Stop requests liquidation and remains active through partial fills.
- Manual Exit saves a persistent intent before requesting quotes, pauses reentry and retries remaining quantity on later cycles.
- User controls queue behind an in-flight scan; background ticks cannot overtake them.
- Held markets remain eligible for exit and official settlement checks even after disappearing from active discovery.
- A missing quote or forecast never creates a fill. A missing model or sports context does not prevent an otherwise executable exit.
- Completed sessions are archived separately and linked from Bot results. The original MLB simulation and manual portfolio remain intact.

## Runtime limits

The deployed page requests cycles while it is visible. Closing the page, locking a phone or suspending the browser stops both entry and exit checks. No scheduled Worker, always-on service or authenticated order submission is connected. This is stated beside Start and in the API runtime response.

`services/paper-bot/runner.ts` runs the same engine independently for a bounded observation window. It owns a locked, atomically written file checkpoint, preserves observations across explicit resume, validates restored cash/configuration/positions and retains provider backoff. It is a runnable service component, not a deployed background service connected to the Site's ledger.

NFL remains available for manual research. Automatic NFL entries are not supported: there is no tested NFL outcome model or reliable pregame QB evidence in the current free adapter. The automatic NFL control is therefore disabled and labeled Research only.

The MLB model uses team results only. It does not quantify pitchers, lineups, bullpen, injuries, park or weather effects. Ratings through September 22 expire after three days; new entries fail closed until a reviewed refresh is integrated. No scheduled model-refresh service exists yet.

## Source handling

Public reads use the official `polymarket-us` SDK where supported. Book and metadata fields were checked against current Polymarket US documentation, including `marketSides.long`, `marketSides.team`, `minimumTradeQty`, `orderPriceMinTickSize` and `feeCoefficient`.

The forward capture encountered provider rate limiting even below the published general ceiling. Public requests now serialize conservatively and pause after a provider limit; the Site persists the pause in D1. Local requests skipped during backoff are distinct from upstream responses. Historical prices cannot replace a missing executable book. US data still uses REST in this release; no WebSocket connection or sub-second execution claim is made.

## Verification and visual evidence

144 TypeScript/Node tests passed, including independent agent simulations for isolated balances, cash recycling, complementary outcomes, missing and stale evidence, cost thresholds, partial exits, manual takeover, settlement idempotence and provider backoff. Four Python tests check chronological training boundaries. TypeScript compilation passed. These synthetic tests check implementation, not expected profit.

The browser review covered the new default Bot workspace, league controls, amount editing, Results, evidence expansion and the Beginner toggle. At 375 CSS pixels the content and viewport widths match, with no horizontal overflow. Recorded development data is visibly labeled and cannot start a current bot session. Production removes that development-only replay.

Before: `docs/evidence/dugout-selector-before.jpg`. After: `docs/evidence/dugout-autopilot-release.jpg`. Beginner mode adds concise explanations; turning it off removes them while essential runtime and paper-money labels remain.

## Reproduction

```sh
npm test
npx tsc --noEmit --incremental false
node --experimental-strip-types services/paper-bot/runner.ts --minutes 6 --output data/my-paper-observation.json
# Existing finished checkpoint: explicitly add --resume, or use a new output file.
```

The runner freezes today's America/New_York date and evaluates remaining pregame MLB markets. It does not manufacture trades, final outcomes or returns to fill an observation window. For an interrupted process, inspect the saved ledger and confirm no runner remains before removing its lock.

## Actual forward observations

The final six-minute check (`data/bot-model-forward-2026-09-23.json`) observed 18 fresh books across 14 same-day MLB pregame markets. All 18 inputs produced a mapped outcome estimate. Two provider rate-limit responses activated backoff; 123 local checks were then skipped without a new Polymarket request. No position opened, so the separate paper bankroll stayed at $10.00. This sparse sequence does not test profitability or prove strategy selectivity.

An earlier three-minute connectivity capture is retained in `data/bot-forward-2026-09-23.json`. The intervening longer attempt was interrupted after provider throttling; its checkpoint, zero-position ledger and termination note are retained in `data/bot-research-2026-09-23.json`. The final runner now also skips entire cycles while its source backoff is active, avoiding unnecessary sports requests and repeated per-market local errors.

Session loss stops and price exits are triggers, not guaranteed execution prices; actual available bids and partial fills determine realized paper proceeds.
