# Bot-first workspace and free sports context

Implemented September 23, 2026, after feedback that the app was too crowded and that automation, player context and trading decisions should lead.

## What changed

The default view is Bot, with its actual state, reason, explicit paper setup/pause, filled positions and bot-only results. Manual trade and Results are separate destinations. Both Beginner and Advanced use the same layout and state. Beginner only adds short contextual explanations and plain-language labels. Setup is behind one action; strategy parameters, raw order books, injuries and source details expand on demand. The original $10 MLB experiment remains under Results.

The manual workspace uses one Enter/Exit control panel. Outcome, chart ranges, editable amount presets, saved watchlists (market/game/team), game details, scanner thresholds, positions, signal results and pending-order recovery remain available. A bot position links to its precise market, side and position ID. Missing markets cannot silently fall back to another game; known held markets can still retrieve their execution data by slug.

One mounted automation hook owns stepping throughout navigation. It blocks new steps/start on an unresolved manual command; Pause remains available. Account revisions come from D1's authoritative version and older responses cannot overwrite later fills, cash or bot state. Existing immutable commands and same-command retries remain unchanged.

## Player and game evidence

The free adapters attach current source context to selected MLB/NFL markets. MLB-owned feeds supply pitcher changes and player statistics. Public ESPN feeds supply NFL typed QB passing events and explicit availability reports for both sports. Replacement identity, event time, observed workload/statistics and provider provenance are exposed in the bot and manual flow. Team/date matching rejects ambiguous doubleheaders. See SPORTS-CONTEXT.md for exact endpoints, fields, limitations and cache policy.

An observed QB passer change is not necessarily an injury, benching or permanent substitution. Injury report times are distinct from injury occurrence times. Missing reports never imply a healthy roster. Player events do not directly create trades.

## What is still unavailable

The existing executable bot is an explicitly selected, single-market, pregame dip/recovery PAPER test. It is not an all-game prediction service. The app has no trained and validated injury/replacement win-probability model, no autonomous game selection, no continuously hosted sports collector and no connected real-money execution service. No profit expectation or accuracy statistic is fabricated.

A new internal forecast gate rejects missing/stale sports context, unmodeled material events, unmapped outcomes, replay quotes, inadequate held-out validation, insufficient depth or a fee-adjusted estimate below its configured thresholds. Passing this research gate never authorizes execution. No external forecast has been connected to it. It estimates settlement value, not guaranteed profit from an early exit.

## Verification

- 103 automated checks passed, including sports parsers, stale model/context handling, costs, side mapping, account revision races, idempotency and atomic ledger writes.
- TypeScript passed.
- Fresh desktop and 375px-content phone QA exercised navigation, the mode toggle, bot setup and rules, MLB change expansion, NFL availability, outcome and Enter/Exit selection, presets, watchlist/game details, Results and the original experiment.
- Provider schemas were checked against actual unauthenticated responses. A recorded live MLB capture correctly identifies Richard Lovelady → Brad Lord; historical typed NFL evidence recovers same-team QB changes and excludes receiver trick passes.
- Local Worker outbound requests are restricted. Development uses clearly labeled real captures for market and sports visual verification; production removes those development branches and requests current sources. Captures do not enable orders and are not evidence of strategy performance.
