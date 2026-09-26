> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Tennis Paper Research Preview

September 25, 2026 · strategy `tennis-recovery-v1`

**Paper only. Keep the website open and visible. Profitability is unproven.**

ATP/WTA singles match-winner markets now support automatic paper trading, manual buys on either player, and a persisted fake balance. Tennis has its own strategy and account. No real orders are submitted.

## Hypothesis and frozen rules

Hypothesis: temporary declines followed by improving buyer prices sometimes recover far enough to cover both trades' costs. This has not demonstrated an advantage or predicted match winners.

| Rule | Default behavior |
| --- | --- |
| Fake balance | $100; reset an empty session to $5–$1,000 |
| Automatic amount | Smaller of $5 or 20% of starting balance; editable before starting |
| Position count | One open position or pending order at a time |
| Baseline | Previous midpoint observations' median within 60 seconds; at least 10 observations spanning 30 seconds |
| Dip | At least 3 percentage points below that baseline |
| Recovery | Midpoint and executable buyer price recover at least 1 point from their lows, with two later non-decreasing confirmations |
| Entry spread | At most 2¢ between best buying and selling prices |
| Net profit target | +3% of the remaining entry cost, after estimated exit fees; requires buyers for the full remaining position |
| Loss exit attempt | −8% net return; partial exits can reduce exposure |
| Planned holding time | Attempt an exit after 120 seconds |
| Cooldown | 60 seconds after exiting or an unsuccessful entry attempt |
| Session loss trigger | 20% of starting balance; blocks entries and attempts exits |

Entry also requires current verified market rules, sufficient buying and selling depth, and a receipt no older than five seconds. Suspended, ended, unsupported, malformed, stale, or replay data cannot authorize a new entry.

A **cost headroom** check asks whether buying now and returning to the old midpoint could cover the target after spread and both fees. The hypothetical selling price rounds down to the exchange tick. This scenario is not a quote or forecast; small dips can correctly produce no trade.

Settings freeze at start. Manual orders bypass the recovery signal but retain execution checks. Their cap is 25% of starting balance and $100; the automatic cap is 20% and $100.

## Execution and evidence

Orders wait at least one second **and** require a later fresh book, keeping their original price limits. Changed prices can cause partial or failed fills. Requested exits remain active until closed or settled. Targets and loss triggers cannot guarantee execution or a maximum loss.

The matcher accounts for depth, quantity increments, both fees, and unsold quantity. Aggregated-book simulations cannot reproduce private queues, other traders' reactions, or per-resting-order fee rounding exactly.

One server ledger persists state with revision checks and duplicate-command protection. Decisions, rejections, quoted versus simulated prices, timing, costs, and observations are recorded. Only explicit final Polymarket US settlement—including fractional fair-price results—resolves remaining quantity; scores and an open book's zero settlement field cannot.

**Strategy & run settings → Export this paper run** downloads the session and up to 10,000 journal records, with a truncation indicator. Judge actual forward outcomes, including unfilled and losing trades; profitable synthetic tests are not strategy evidence.

## Runtime and coverage

Visible browsers request checks approximately every 2.5 seconds. Closing, locking, or hiding the page stops checks. Storage persists; this is **not an always-on server bot**.

Discovery reads at most eight events per tour, caches for 30 seconds, and prioritizes live matches. Up to 12 eligible markets use WebSocket books. REST fallback covers a stable four-match pool, two per cycle. Positions and pending orders take priority. This does not scan all tennis inventory.

Charts use captured observations, never invented prices or profits. The strategy does not model players, serve state, injuries, medical timeouts, or match-win probabilities. Displayed scores/status are context only. See [verified API contracts](TENNIS-API-RESEARCH.md).

## Validation status

- Full automated suite: **242 passing tests** at this release checkpoint, including 18 independent tennis acceptance cases. These test implementation behavior, not expected returns.
- Covered: both player outcomes, delayed execution, stale and future books, price changes before fills, fees, partial exits, repeated commands, pause/stop behavior, settlement, and cash conservation.
- Preview UI: Start, Pause, reset to $10 with persistence, and Advanced mode were exercised successfully.
- Preview external-provider requests were blocked by that runtime's network environment. Consequently, local UI checks do not prove a live market-to-fill round trip.
- Hosted live-feed and paper-trading smoke tests were **pending when this note was written**. No live tennis profit, validated win rate, or repeatable edge is claimed.
