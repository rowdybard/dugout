> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# September 23, 2026 — a separate $10 MLB paper test

This experiment uses **$10 total**, separate from the owner’s $100 personal paper portfolio. It calls only public Polymarket US read endpoints. It never submits an order and never changes a personal position, watchlist, balance, or scanner setting.

## Actual captured run

The script fetched live official data from **16:00:24 through 16:00:40 UTC on September 23, 2026**. The immutable record is `data/mlb-simulation-2026-09-23.json`. This is a timestamped simulation using actual observed quotes, not development mock data and not a claim of actual executions.

| Test outcome | Game starts (EDT) | Side | Whole contracts | Average contract price | Cost including estimated entry fees |
|---|---|---|---:|---:|---:|
| Detroit Tigers win | 1:10 PM | NO to Washington | 3 | 62.0¢ | $1.9091226 |
| Baltimore Orioles win | 6:35 PM | NO to Toronto | 3 | 53.5¢ | $1.6568695875 |
| Philadelphia Phillies win | 6:40 PM | NO to Milwaukee | 4 | 46.5¢ | $1.92915945 |
| Pittsburgh Pirates win | 6:40 PM | NO to St. Louis | 3 | 56.5¢ | $1.7462440875 |
| Tampa Bay Rays win | 7:05 PM | YES to Tampa Bay | 4 | 45.5¢ | $1.88893705 |

- Starting cash: **$10.00**.
- Simulated cost: **$9.130332775**, including **$0.290332775** estimated entry fees.
- Unspent cash: **$0.869667225**.
- Entry-time liquidation estimate, including estimated exit fees: about **$9.3341** including unspent cash. A below-$10 starting selling value reflects the buyer/seller gap and fees, not a game result.
- Results at capture: **five pending**. No outcomes or future profits are invented.

The listing returned 58 distinct events across three pages, including 16 games starting on this New York calendar date. Six had nonzero, valid recent movement. The test entered the top five that could fill its budget. Ten games had flat observed prices; Cincinnati–Atlanta ranked sixth and was skipped. Exact skipped identifiers and reasons are in the immutable record and the UI.

One Toronto–Baltimore market retained September 22 in its slug while its event start time was September 23 at 1:35 PM EDT. We use the official event’s `startTime` for the calendar date, preserving its actual identifier. That market was flat and skipped; the entered Baltimore game is the separate 6:35 PM EDT September 23 market.

## Predeclared selection and accounting rule

1. Interpret “today” using **America/New_York**, not the date embedded in a market slug.
2. Read the documented MLB league event endpoint with `type=sport`, 20 events per page, a maximum of 100, stopping at a short or repeated page. Report incomplete coverage if capped or a request fails.
3. Consider active, visible full-game-winner markets on events that have not started or ended. Require the actual official YES and NO outcome descriptions.
4. Read official one-hour history at one-minute fidelity. Require at least 45 minutes between first and last valid observations and a most recent observation no older than five minutes. Reject flat or unavailable histories. Store observed points unchanged.
5. Rank by the absolute first-to-last change of `longPrice`. Ties use earlier official game start, then market slug. This separate experiment includes nonzero movement below the scanner’s default alert threshold.
6. Choose YES for a positive change; choose NO for a negative change. YES is the official `marketSides[].long === true` outcome, never inferred from the home/away order. An opposite team’s buying price also depends on spread; a YES-price decline is not proof its opposite’s ask rose by precisely that amount.
7. Read the real current order book. Recheck first pitch and `MARKET_STATE_OPEN`. Use the existing whole-contract paper execution engine, which walks prices and caps each fill by observed available quantity. Use no more than five entries and no more than $2 including estimated fees per entry. Unspent cash is retained; unused allocations are not redistributed or reinvested.
8. Hold entries for the official settlement response. Do not infer a result from price, a score, or the BBO’s settlement-like fields. An official fractional settlement pays its fraction for YES and one minus its fraction for NO.

The fee estimate uses the market’s `feeCoefficient` (0.0695 in this run): `coefficient × quantity × price × (1 − price)` at each level. Exchange per-fill banker's rounding, queue position, latency, changing book depth, fractional minimum quantities, and any account-specific rebates can make real executions differ. Fees here remain exact mathematical estimates internally and are displayed rounded to cents. No settlement fee is added.

## Source contracts

The existing current-official-API research in `docs/API-RESEARCH.md` applies. This feature adds no new API assumptions:

- Official events: https://docs.polymarket.us/api-reference/sports/get-events-by-league-slug
- Official history: https://docs.polymarket.us/api-reference/price-history/get-price-history
- Official book: https://docs.polymarket.us/api-reference/markets/get-market-book
- Official settlement: https://docs.polymarket.us/api-reference/markets/get-market-settlement
- Official fees: https://docs.polymarket.us/fees
- SDK: `polymarket-us` 0.1.1, unauthenticated `markets.book(slug)` and `markets.settlement(slug)`.

The gateway is `https://gateway.polymarket.us`. Events/history use the documented REST surface. The raw documented book envelope is `marketData`; bid/offer levels use `px.value` and `qty`. The captured JSON retains full normalized books, fee coefficients, market identifiers, entry times, first-pitch times, entry history, amounts and quantities, allowing the simulated fills to be audited.

## UI and persistence

`components/dugout/mlb-simulation.tsx` is a self-contained component with no props. It fetches `GET /api/simulation`, labels the experiment as app-chosen, dated, paper-only and separate from personal picks, displays each outcome and if-right/if-wrong amounts, and exposes exact rule, sample size, entry details, timestamps and skipped games.

The route imports the immutable capture. In production it checks official results and, for pending entries, current full-book liquidation estimates at most once per minute. It retains last-known values with their actual observation times if quotes are unavailable. Explicit “Check results” refreshes observations; it does not rerun selection. The development preview returns the actual entry snapshot with a conspicuous message that live results are not checked there.

Observations use separate D1 `cache` keys prefixed `simulation:`. Official settlements use insert-only result keys so an overlapping slower pending response cannot overwrite a confirmed result. Cash, equity and P/L are derived from immutable entries plus observed settlements on every read. No read increments a cash ledger, so repeated reads cannot double-credit results. No production endpoint creates or reruns experiments.

## Reproduce or verify

The capture command was:

```sh
NODE_USE_ENV_PROXY=1 node --experimental-strip-types scripts/run-mlb-simulation.ts
```

The script refuses to overwrite an existing date’s capture. Running it again is unnecessary; entries are intentionally fixed. A future date requires a deliberate run and a deliberate route import change.

Meaningful tests cover total budget, fee/depth-aware fills, correct slate/date and pregame eligibility, direction selection from the actual captured history, repeated settlement reads, fractional YES/NO payout math, and unknown results when only prices are available:

```sh
node --experimental-strip-types --test tests/simulation.test.ts
```

Five entries on one date cannot establish whether this rule is useful. This is an auditable starting sample, not evidence of profitability or predictive accuracy.
