# Dugout: user and developer manual

This manual describes the paper bot as of **October 3, 2026**. A saved account can have different settings from the defaults listed here. Its loaded configuration and exported journal are authoritative for its balance, rules, focus and status. [RELEASE-STATUS.md](RELEASE-STATUS.md) records dated test and deployment evidence.

Dugout is a **paper-trading dashboard** for Polymarket US sports markets, with Football and Tennis tabs. Its decision engine uses deterministic calculations, not Claude, and it simulates every fill. Tennis Recovery and Momentum are explicitly registered paper experiments, not established profitable strategies.

The Tennis tracker shows Polymarket's set, game and point scores plus the server when those fields can be assigned to the verified players. It checks the selected match every five seconds independently of trading, so it works while the bot is idle. Missing fields stay blank, ambiguous point scores remain labeled as reported, and a failed check retains the last score with its original update age. Football's detailed source timings are under the closed **Feed details** disclosure.

New Tennis bots default to $10 per bet on a $100 starting balance (10%, within the existing cap and $1 minimum). The bot card's Small, Default and Large buttons change the saved size for future entries; existing saved sizes are preserved until changed. New Auto uses the adaptive rules below. Saved original Auto runs keep their rules until you select Auto to upgrade; open positions retain the exit plan saved when bought. The Both sides summary shows an actual queued order or the latest check; old plans are never presented as current buy instructions.

Trade history and Bot activity have separate scrollable lists. Scrolling, selecting a row, or opening its explanation pauses that list while the bot keeps running. **Show newest** resumes live updates. Timestamps include seconds; each fill shows fees, and a sale's result includes allocated purchase costs. **Why** preserves the execution reason, including a stop requested before a later price recovery.
- **The site:** a Cloudflare Worker behind Cloudflare Access with Google sign-in, using a D1 database.
- **The runner:** each person's background bot is a separate Cloudflare Worker with a per-account SQLite Durable Object. Closing the page does not stop a running background bot, and a paused account does not start itself.

## Contents

- [Verified status](#verified-status)
- [Using the dashboard](#using-the-dashboard)
- [Prices, charts, and game reports](#prices-charts-and-game-reports)
- [The decision engine](#the-decision-engine)
- [Execution, fees, exits, and accounting](#execution-fees-exits-and-accounting)
- [Rules and defaults](#rules-and-defaults)
- [Claude adviser and memory](#claude-adviser-and-memory)
- [Architecture and interfaces](#architecture-and-interfaces)
- [Authentication and secrets](#authentication-and-secrets)
- [Background migration and operation](#background-migration-and-operation)
- [Journal exports and replay](#journal-exports-and-replay)
- [Local development](#local-development)
- [Editing, testing, and publishing](#editing-testing-and-publishing)
- [Troubleshooting](#troubleshooting)
- [Limitations and outstanding validation](#limitations-and-outstanding-validation)

## Verified status

- **Hosting:** the site and runner are deployed from GitHub to the owner's Cloudflare account with Workers Builds ([CLOUDFLARE-HOSTING.md](CLOUDFLARE-HOSTING.md)). Sign-in is Cloudflare Access with Google and an invite list.
- **Live use, October 2–3, 2026:**
  - Accounts ran on background runners during live college games.
  - Resting offers were posted, a one-sided fill occurred (Penn State, 23.76 shares at 50.5¢), and the panels showed it.
  - Issues found in that use were fixed the same day: game-report staleness, write budgets, 503s and a status flicker ([RELEASE-STATUS.md](RELEASE-STATUS.md)).
- **Automated tests:** the full suite (853 tests on October 3, plus two subsequent request-failure regressions) covers the engine, shared wallet, independent Football/Tennis controls, source-specific game reports, resting-order fills, pairing and exits, the runner store and protocol, and sign-in verification.
- **Not established:** that any strategy is profitable, or that real exchange fills would match paper fills. Paper results are evidence collection, not a forecast.

## Using the dashboard

### Two bots, one wallet

Football and Tennis use the same layout and share your existing balance, open holdings and trade history. Each has its own chosen game, settings and Start/Pause/Resume/End run controls. Tennis begins idle. Switching tabs or starting a stopped bot does not reset money or history, and one bot can keep running while the other is paused.

Football has Steady, Bold and Auto. Tennis has Recovery, Momentum and Auto: Recovery waits for a price decline and recovery, while Momentum waits for a confirmed rise. Auto selects between more responsive versions of those signals. All still check executable prices, fees, available money and the saved exit rules.

**Adaptive Tennis Auto:** after at least 30 seconds and ten quotes of warm-up, it can act on a two-cent move when the spread and recent price noise allow it. It still needs two independent confirmations and a later execution check. There is no fixed entry price, sell price, or two-minute exit. A complete executable profit after fees can establish a protected profit floor, allowing the move to continue until two fresh quotes confirm a reversal. A stopped or thin feed cannot establish a new profit peak. The original dollar stop and explicit user exits remain active.

The first actual purchase fixes the position's loss allowance: 25% by default, about $2.50 for a $10 purchase including fees. Auto may add once after a confirmed rebound at a lower price. That extra purchase must fit the same original dollar loss allowance, available cash, the shared 50% spending limit, and a total position purchase cap of 20% of starting cash. The extra buy does not double the loss allowance or require holding to the end. Average purchase price is total purchase value before fees divided by total bought shares; the holdings list also shows the cost per remaining share including purchase fees. Sale fees are still additional.

Recovery, Momentum and saved original Auto positions retain their registered first-version rules, including the original 8% loss and two-minute holding defaults. A source-code release or viewing the tab does not rewrite these positions. Adaptive Auto is a separately registered paper experiment, not evidence of profitable behavior.

Together the bots reserve at most half the lower of your starting balance and current conservatively valued balance, counting holdings at cost, pending purchases and resting offers. A loss stop blocks new entries for both bots. After all exits finish, acknowledgement grants the original dollar loss allowance again and resumes the bot you selected; it keeps your balance and full history. **Sell everything now** and **Reset balance** apply to both bots. Reset is the explicit way to start a fresh wallet.

### First run

1. **Sign in:** Google, through Cloudflare Access. Each invited email gets its own paper account (new accounts start with $100).
2. **College football:** if the account still lists other sports, press **Show college football games** once.
3. **Pick a game:** search and choose a live or upcoming one. Choosing a game sets the bot's focus.
4. **Choose a mode:** **Steady**, **Bold** or **Auto** (see [Trading modes](#trading-modes)), then press **Start bot**.
5. **Optional, close the tab:** run in the background. With no open trades, open **Settings & history → Set up background bot → Finish background setup**. The account moves to its own runner, paused, and you press Start again.

### Layout

| Area | What it shows |
| --- | --- |
| Search box | Live and upcoming college games; the chosen game is the bot's game. |
| Bot card | Game, Steady/Bold/Auto, the Octopus (red Experimental label), balance, Reset balance, the run controls, the status box, **Both sides**, and **Open orders & shares**. |
| Status box | One plain-English state and reason, e.g. "Buy offers posted: Offering to buy Liberty at 70¢ or Delaware at 29.5¢. It fills only if someone sells at that price." Chips show the ages of the last bot check, accepted quote and game report. |
| Both sides | One line per team from that team's own state: what is held, its posted offer, or the engine's verdict. |
| Open orders & shares | Every resting offer (team, price, shares, cash held) and every holding (shares, average price, cost, value if sold now), across the main game and Octopus arms. Holdings also show their plan: "paired", "waiting for a pair, sells at <time>", or Bold's state. |
| Game tracker | Score, clock and a field drawing from Polymarket game reports, with the report and check ages; a failed check shows its reason. |
| Trades & balance | Every fill with price, quantity, fees and result, and the balance chart. |
| Settings & history | Rules, Ask Claude (owner), the Decision engine card, background setup, your own Polymarket key ("Live prices"), diagnostics, saved-history download and Octopus log download. |

### Controls

| Control | Effect |
| --- | --- |
| Pick a game | Sets the bot's focus. Allowed while shares are held: they stay managed on their own game, and new offers go to the new game. |
| Steady / Bold / Auto | Switches the trading mode and resizes the order. Auto shows which mode it picked and why. The button lights up at once; the change is saved from the latest rules. The Octopus keeps running at the new size. |
| Start bot / Resume | Starts the selected idle or ordinarily stopped bot, or resumes a paused one. Keeps the shared wallet and history. Needs a chosen game. |
| Pause | No new entries; held shares stay managed. |
| Sell everything now | Big button while anything is held: green when the holdings are up, red when down (neutral until priced). Pauses entries, pulls offers, and sells every held share at the best bid on the next fresh book (`exit-now`). Resume continues the run. |
| End run | Cancels the selected bot's offers, sells its holdings, and ends that bot's run. The other bot can continue. |
| Acknowledge loss and resume | After a completed loss-limit stop, resumes the same account and run without resetting cash, trades, history or rules. Each acknowledgement grants the original run's dollar loss allowance again. Needs remaining cash and a chosen game; exits must finish first. |
| Reset balance | Any time, $5–$10,000. Explicitly resets the whole shared paper wallet and both bots, including open paper trades. |
| Octopus | Either mode: the same offers on up to 6 extra games ("arms") at the mode's size and with its one-sided rules. **Auto-pick** fills free arms with open college games that are live or start within 6 h, with a listed spread of 2¢ or less. It picks the narrowest spread first, keeps current picks while they stay eligible, and re-checks every 5 minutes. **Pin** a game with the search. × removes a pinned game or skips an auto one. All resting offers together use at most 50% of the balance, and room for the main game's two offers is always kept. Removing an arm pulls its offers; shares stay managed. |
| Download Octopus log / saved history | JSONL of Octopus events built in the browser / the full account journal export. |

### Trading modes

The bot mostly makes markets: it rests a buy offer at each team's best bid. Both filling is a **pair**, which pays exactly $1 at settlement whoever wins; the pair cost less than $1. Fills are conservative: an offer fills only when the price trades through it.

| | Steady | Bold |
| --- | --- | --- |
| Offer size | about 5% of the balance (max $5) | 12% of the balance (max $50), so both offers fit the 25% exposure cap |
| Hold-to-final bets the evidence allows | no | yes |
| One side fills alone | Stops buying that side and raises its offer on the other side to complete the pair (pair cost ≤ 99.5¢). Sells the unpaired shares at the best bid after **10 minutes** if no pair forms. | Keeps the shares. **Take-profit:** its pairing offer only completes the pair at a 5¢ profit on the average (a resting offer, so it earns the rebate), and if the best bid jumps 5¢ above the average before that offer can fill, it sells the unpaired shares directly. **Dip buy:** once, if the price falls 5¢ below what it paid, it buys as many again at the ask (that side's cost capped at 2× the order size). **Loss limit:** after a dip buy, it sells the unpaired shares if the best bid falls 10¢ below their average. Otherwise it holds to the final. |

**Comeback re-entry (Bold and Auto, on paper):** both turn on `comeback-drive@1` as a paper test (`config.explore`). When the team with the ball trails by 3–24, is inside the opponent's 30 on 1st–3rd down with **more than** 5 minutes left, the bot buys it and sells when the drive ends. It doesn't fire late in a game, when the trailing team is a longshot with nothing left to gain. The research leans against it (follow-through about 0.4–0.8¢ against a round trip of about 4¢), so it is measured, not trusted. Steady turns it off.

**Auto** (`config.autoMode`) picks Steady or Bold on every check (`decideAuto` in `lib/tennis/engine.ts`):
- **Steady** while the run is down 10% or more of its starting balance (held shares at their sale value, or at cost while unpriced).
- **Bold** when this check's plan for the main game allows a hold-to-final or drive bet.
- **Back to Steady** after 5 minutes with no such bet, once nothing is held. Otherwise the last pick stands; Steady until the first plan.
- **Sizes:** offers are Steady-sized in Steady and Bold-sized in Bold. Each switch is a decision row ("AUTO_MODE").

**When offers come down:**
- for 30 s after each live play;
- whenever the required game report expires: 45 s for Polymarket, or 90 s for a verified ESPN drive with a fresh matching Polymarket scoreboard. The separate halftime policy does not make missing drive evidence fresh;
- when the book is wider than 5¢;
- on stale data, pause, End run, or a rule change.

The engine only posts where the evidence permits resting orders ([DECISION-ENGINE.md](DECISION-ENGINE.md)).

### Session states and runtimes

- `idle`: account exists but has not started.
- `running`: posts offers, stages entries, manages holdings.
- `paused`: no new entries; holdings still managed.
- `stopping`: selling held quantity before stopping.
- `stopped`: this bot's run ended. Start bot keeps the existing wallet; a loss stop requires acknowledgement first.

**Browser mode:** the page must stay open and visible.

**Background mode (runner):**
- **Check cadence:** every **10 s before kickoff** with nothing held or pending, and every **2.5 s** once a watched game is live or anything is held or pending.
- **Page updates:** the page polls the runner's state every 2.5 s. A small difference between the phone's clock and Cloudflare's clock is treated as "just now", not as stale.
- **"Bot is behind":** shows only if the last check is older than 45 s (background) or 30 s (browser).

## Prices, charts, and game reports

### Price and spread

60¢ means a contract price, not a game score. The buy quote is the best ask; the sell quote is the best bid. Their difference is the spread. Buying then immediately selling ordinarily loses spread plus fees. The midpoint is for charting/signals; fills use executable levels.

The NO book complements YES: NO bids are `1 − YES asks`, and NO asks are `1 − YES bids`, retaining their quantities. Explicit outcome mapping determines which player/team YES and NO represent; title order is not a safe substitute.

### Chart conventions

The chart shows buy/sell lines, shaded spread, midpoint, and automatic IN/OUT fill markers. Only applied automatic ledger fills produce those markers; a pending intent or imported manual record is not relabeled as an automatic fill. Time ranges are 15 minutes, one hour, and available saved history. The scale can be zoomed or full 0–100¢. Hover details show the recorded quote, spread, midpoint, and any score saved with it.

An interval over 30 seconds without quotes is marked as missing. Dashed bridges connect observations on either side for readability; **prices inside the gap are unknown**. This chart view merges at most the latest 1,200 points. Engine working history and full journal storage are separate.

### Distinct clocks

| Evidence | Meaning | Does not prove |
| --- | --- | --- |
| Book checked / quote receipt | Actual accepted authoritative book observation; REST additionally stores request-start and response-receipt evidence. | Fresh football play/score facts. |
| Report age | Age of provider `eventState.updatedAt` for the game facts. | When the browser last polled. |
| Last checked | Last successful accepted uncached football response recorded by the priority loader. Cache hits/failures do not advance it. | That the provider changed its report. |

The last book transaction timestamp is an ordering watermark too. A quiet market can have an old last-change timestamp and a fresh authoritative receipt. That alone is not stale. A backward, invalid, or implausibly future source timestamp is rejected.

A fresh selected chart and an old **last bot quote** can coexist: they can concern different games, or a paused flat runner may deliberately have no active ticks. Inspect state and focus before treating the difference as a broken chart.

### Football field

The field uses explicit team identities, possession, down, distance, field-position team/yard, score, quarter, and clock. It does not invent plays or interpolate ball movement. Polymarket supplies scoreboard and clock; a reviewed ESPN mapping can fill missing drive details. Polymarket reports must be at most **45 seconds** old, ESPN drive reports at most **90 seconds**, and both receipt ages at most **45 seconds**. ESPN may lag a matching Polymarket scoreboard by up to 90 seconds, or lead it by at most 15 seconds. Missing mappings/facts, future times, regressing reports, score/quarter disagreement and conflicting facts at the same timestamp block entry. Down zero during an incomplete kickoff report is not valid first-down context. Last-known details and verified scoring summaries remain visible with their own ages while entries wait.

The display can retain the last consistent facts while marking them stale/unknown/conflicting. Quotes are independent. A three-second poll cannot force a new upstream play report. Fresh compact transport can remove cache delay, but never replaces the provider timestamp or promises a play-by-play SLA.

## The decision engine

[engine.ts](../lib/tennis/engine.ts) is a deterministic reducer over session, inputs, and time. Network collection, storage, scheduling, and AI calls are outside it. The active engine supports ATP/WTA singles winner markets and NFL/CFB full-game team winner markets. Normalization verifies market type, league, identities, and execution metadata; doubles/mixed tennis are excluded. Older MLB/NFL experiments remain code, not the current home-page engine.

### Entry gates

Before proposing a buy, and again before its delayed fill, the engine requires:

- Supported/allowed/focused market, active/live/not ended, with live/status observation no older than 45 seconds.
- Authoritative REST/WebSocket book within the quote-age limit and accepted provider ordering.
- Valid fee coefficient, price increment, minimum quantity, and quantity increment; no guessed execution metadata.
- Two-sided uncrossed book and permitted spread. Native limits cannot exceed **2¢** and **5 seconds**.
- Available cash for the budget, no conflicting open position, and no active entry rest.
- Full proposed entry depth at the quoted ask and hypothetical full immediate exit depth at the quoted bid.
- Immediate estimated spread/fee loss strictly below the loss-exit threshold.
- Independent history and a qualifying versioned analysis. Reusing a receipt does not progress warm-up or evidence.
- For football under `football-context-v1`, fresh complete consistent context. This checks data quality, not who will win.

Rejected checks produce reasons. A fresh price alone never forces a trade.

An explicit provider `driveState.down = 0` is recorded as a **between-plays transition**, with its score, period, clock, team identity and original timestamps. It is not a malformed normal down or proof of a specific kick/touchdown. The transition advances the report-ordering watermark, hides scrimmage/first-down markers, and blocks/cancels new entry attempts until a newer complete drive arrives. Ordinary position exits continue. Old or conflicting reports cannot reverse that transition; its evidence still expires after 45 seconds. A missing down without explicit zero remains unknown.

### Current policy: local move analysis

The optional `config.decisionEngine: 'local-move-v1'` field selects [opportunity.ts](../lib/tennis/opportunity.ts). It evaluates both YES and NO using only evidence available at the current receipt. The `strategy: auto` field remains for schema compatibility; this branch does **not** run the old recovery-versus-momentum chooser. No model, remote inference, broadcast listening or paid AI call occurs.

The output is `enter`, `wait` or `reject`, with one leading reason, all other reasons, fixed/versioned thresholds and serializable measurements. Missing values are `null`, not zero or a fabricated estimate. It is a conservative local recovery scenario, **not a calibrated probability, expected profit, fair-value estimate or promise that price returns to an earlier level**.

1. **Collect causal evidence.** Defaults use a 60-second window with at least 30 seconds and ten independent quotes. The model requires at least six pre-drop baseline samples, at least two recovery intervals and two positive buyer-price changes. It rejects conflicting same-time quotes and gaps over 15 seconds; future observations cannot train the current calculation. History and independent time must both qualify.
2. **Measure the drop against prior noise.** A causal peak-to-trough scan identifies the observed drop. Midpoint/bid changes before the drop are scaled by the square root of elapsed seconds. The noise estimate bounds outliers using baseline median absolute deviation and includes a market-tick quantization floor. The drop must reach twice its duration-adjusted noise scale. Drop speed is recorded; the drop itself does not inflate its pre-drop noise baseline.
3. **Require measurable buyer recovery.** Recovery drift is the bid change per elapsed second from the trough. A two-standard-error allowance uses the larger baseline/recovery residual noise. The resulting lower drift must be positive, with independent positive bid changes. A rising midpoint without supporting buyers is insufficient.
4. **Check liquidity and book pressure.** The depth band is the larger of two ticks and the spread. Buyer/seller quantities produce imbalance and a depth-weighted price. Adverse pressure reduces the scenario; positive imbalance is not treated as a win prediction. The normal simulator must price a complete buy and immediate full exit, including fees, and there must also be enough quantity at the current best bid.
5. **Subtract costs and delay risk.** The lower move is capped by both the remaining distance to the observed pre-drop bid and the lower measured recovery drift over the scenario horizon. The horizon uses observed drop/recovery duration, bounded by maximum hold. Spread, executable depth costs, rounded fees, adverse book pressure and a two-sigma execution-delay allowance reduce it. Modeled exit-price fee changes are included. The remaining net headroom must exceed one tick and have at least a 1:1 ratio to the measured structural-risk allowance.
6. **Stage, then verify again.** Candidates rank by higher net-headroom/risk ratio, then greater total net headroom, then stable market/outcome order. The winner becomes a pending buy. It still requires the normal delay and a later fresh book. The analysis is repeated; a later setup cannot require a higher reference price or lower invalidation price than the staged scenario. Failed gates cancel rather than force a fill.

Threshold constants such as two-sigma, six baseline observations, a 1:1 minimum ratio and one-tick minimum headroom are disclosed modeling choices in the versioned module. They are not trained probabilities or user-adjustable guarantees. Prices in its calculations are dollars per contract, drift is dollars per second, and volatility is dollars per square-root second. Decision details converts suitable quantities to cents and labels unavailable measurements.

Repeated warm-up can follow rule/focus edits, source failure, football-boundary resets or too few usable observations. “4/10” is not enough merely because 30 seconds passed. Lowering protections to obtain fills would not establish whether the model works.

### Legacy policies and replay

A saved configuration with **no** `decisionEngine` field follows the retained legacy path. Its recovery pattern uses midpoint/bid decline from prior median baselines and independent rebound confirmations; momentum requires a sustained midpoint/bid rise. Legacy Auto evaluates both patterns for each side and adapts cent thresholds to quote noise/spread. Those paths and their historical fixed profit target remain for old state and replay. They are not the current local model.

Opening an old account does not silently rewrite that version field. The dashboard Start/Resume upgrade is an explicit journaled rules command. Existing held positions continue their entry-time policy. Retaining old factories, version absence, deterministic ordering and optional new fields avoids reinterpreting historical records as if the new analysis had made them.

### Football boundaries and shadow exits

A pending football buy records context at its signal. A **newer** report changing score, possession, or quarter cancels it and requires new confirmations. Missing/stale/conflicting context cancels it too. Third-and-long alone is not a programmed real paper sell signal.

The validation phase records separate **shadow exit** experiments for fresh context showing the held team's possession loss or its fourth down. [shadow-exits.ts](../lib/tennis/shadow-exits.ts) uses the same delayed matching/book checks with separate hypothetical quantity/proceeds/fees. It does not mutate actual paper cash, ledger, or position. Actual paper exits use the position's entry-time local or legacy policy, loss/time/Stop controls, and explicit settlement logic. Football quality screening does not turn a down-and-distance observation into an independent actual sell command.

## Execution, fees, exits, and accounting

### Signals and fills

A signal creates a pending intent at the current ask/bid limit. Default delay is one second, then execution needs a **later authoritative book**, after both the delay and original receipt. Cached observations cannot fill. Entry conditions and signal strength are rechecked; weakening context/price or failed gates cancel. The engine does not chase a worse price beyond the saved limit. Intents expire after the greater of 30 seconds or three times the configured delay.

The [paper matcher](../lib/trading/execution.ts) is immediate-or-cancel (IOC). It walks executable levels inside the limit, respecting market increments/minimums, and can report filled, partial, unfilled, or rejected. The unfilled remainder of an IOC attempt is canceled; exit management can retry remaining held quantity using later books. There is no exchange order, queue-priority model, reservation of public liquidity, or real counterparty confirmation.

### Money and fees

[money.ts](../lib/trading/money.ts) uses six-decimal fixed-point integers internally. Buy size includes estimated fees inside the budget. Fee computation uses supplied coefficient × quantity × price × (1 − price), with implemented half-even cent rounding. Depth aggregation is labeled `AGGREGATED_DEPTH_ESTIMATE`, not a guarantee of real exchange fill/rounding behavior.

Cash equals starting cash plus ledger cash deltas. Buys subtract gross cost and fees; exits add proceeds minus fees. Partial exits allocate cost basis proportionally. UI dollars round to two decimals; exports retain account precision.

### Frozen limits and adaptive exits

A filled local entry saves its analysis and an immutable [adaptive exit plan](../lib/tennis/exit-analysis.ts): actual all-in unit cost, observed reference bid, structural invalidation price, measured volatility, scenario horizon, delay, tick size and original loss/time limits. Later rules cannot widen that position's stop or extend its maximum hold. `targetReturn` is retained in the snapshot for compatibility; it is **not** a fixed local profit-taking trigger.

Exit checks use available executable net liquidation after fees, not midpoint. Entry fees already belong to cost basis and exit fees to the liquidation mark; they are not subtracted twice. Held-market movement is measured independently of the entry detector over a bounded 30-second-to-five-minute lookback, using at least three unique intervals, a newest quote no older than five seconds and gaps no longer than 15 seconds. This measures current bid drift and residual bid/midpoint volatility. Missing evidence remains unavailable; original loss/time exits still operate.

- A complete-position net mark can raise the saved peak. Once gain exceeds the noise buffer, the profit floor becomes the larger of its old value, zero and peak gain minus that buffer. The buffer uses the larger of one tick, half-spread and two-sigma movement over the frozen reaction delay. The floor only ratchets upward; increased volatility cannot widen an already raised floor.
- Falling through that floor proposes a delayed exit. A partial quote can support reducing risk, but cannot raise a full-position profit peak or prove total profit-taking headroom.
- A bid below the saved structural invalidation level beyond the noise buffer can invalidate the entry thesis. A profitable complete mark can also qualify when remaining fee-adjusted reference headroom is no larger than the measured risk of waiting, or the original scenario horizon has elapsed with nonpositive recovery and buyer pressure. These conditions require two distinct fresh books spanning at least the frozen reaction delay. Repeated receipts or long observation gaps cannot manufacture confirmations.
- The original loss threshold, maximum hold, Stop and an already requested exit retain priority. A requested exit stays active rather than disappearing when later marks improve.

A legacy position without an adaptive plan keeps its fixed net profit/loss/time policy. Positions missing legacy `exitRules` receive a one-time snapshot from their existing configuration on load; that normalization does not invent adaptive entry evidence. A legacy profit target needs complete executable depth, while risk exits can reduce available partial quantity.

Execution still requires a fresh later usable book. “Try to exit at 8% loss” does **not** guarantee an 8% realized loss ceiling. Missing buyers, data failure, movement during delay, and partial fills can postpone or worsen execution.

Explicit authoritative settlement data can settle residual quantity using a reported 0–1 value and its NO complement. The engine does not infer settlement from score or assume an ended game already has a settled book.

### Equity, session risk, and rest

Equity is cash plus conservative net liquidation. Unpriced residual quantity is not valued at midpoint; it can contribute zero to the conservative estimate. The UI marks incomplete/stale valuation. Inspect liquidity and freshness before interpreting the graph as fully realizable value.

Default session loss threshold is 20% of starting cash. A realized breach stops entries; a qualifying complete-valued equity breach while held moves toward stopping and attempts exit. This also is not a guaranteed loss ceiling.

After a loss stop finishes exiting, **Acknowledge loss and resume** records an explicit acknowledgement and resumes the same run. It uses the original starting cash times the configured loss fraction for each acknowledged period, rather than shrinking the allowance with the remaining balance. With a $100 start and a 20% limit, acknowledging at $79.94 allows another $20 and puts the next balance threshold at $59.94. Cash, cumulative profit/loss, trades, chart and rules stay intact. Prior acknowledged losses no longer block the engine's session/day loss checks; other entry checks and the runner's storage budget still apply. Normal Resume cannot bypass a loss stop, and no acknowledgement happens automatically.

An explicit change to the loss fraction in Rules still changes the allowance, calculated against the run's original starting balance. Each acknowledgement identifies the loss period it was shown for, so a delayed request from an older period cannot resume a later stop.

Completed trades invoke the configured per-game rest for both outcomes/tracks, default 60 seconds. Auto failed/unfilled entry retry delay is capped at the lesser of the rest and ten seconds. Zero rest is supported; it removes no other gate. Subsequent movement can be missed during a saved cooldown because the account's rule explicitly requests it.

## Rules and defaults

[rules.ts](../lib/tennis/rules.ts) defines these source defaults. **This is not the current saved account configuration.** Inspect loaded Bot rules or exported `session.config`. Migration preserves saved strategy settings.

`defaultTennisConfig()` deliberately remains the legacy factory with `strategy: recovery`. `defaultLiveTennisConfig()` adds `decisionEngine: local-move-v1` and `strategy: auto` for fresh server accounts and Restore defaults. Reset keeps a previously local account local and a legacy account on its legacy family; dashboard Start explicitly upgrades an older policy before running. An absent engine version remains legacy, and an absent football decision-policy field normalizes to `price-v1`. New live defaults use `football-context-v1`. None of these defaults replaces a saved account on read.

| Setting | Default | Meaning / validation |
| --- | --- | --- |
| Starting cash | $100 for a new account | Reset range $5–$1,000; up to six decimal places. |
| Entry budget | min($5, 20% of starting cash) | Maximum including fees; positive, ≤$100 and ≤20% of starting cash. |
| Leagues | ATP, WTA | At least one unique member of ATP/WTA/NFL/CFB. |
| Focus | None | Native Start/Resume requires one game. |
| Baseline window | 60 seconds | Up to an hour; local policy requires at least 30 seconds. |
| Minimum history | 30 seconds | No greater than baseline window; local requires at least 30 seconds. |
| Minimum quotes | 10 | Local requires 10–200 independent observations; legacy schema permits 3–200. |
| Recovery decline | 3¢ | Legacy only, positive, ≤40¢; hidden and unused by local analysis. |
| Recovery amount | 1¢ | Legacy only, positive, less than decline, ≤40¢. |
| Recovery confirmations | 2 | Legacy only, 2–20; local has its own versioned evidence requirements. |
| Momentum rise | 3¢ | Legacy only, positive, ≤40¢. |
| Momentum confirmations | 2 | Legacy only, 2–20. |
| Maximum spread | 2¢ | Local and native reject >2¢; legacy shared schema allows up to 10¢. |
| Net target return | 3% | Legacy fixed profit trigger; retained but not used as a local profit trigger or shown as a local input. |
| Loss-exit threshold | 8% | Positive, ≤50%; frozen per position, not guaranteed execution price. |
| Maximum hold | 2 minutes | Positive, up to an hour; frozen per position. |
| Rest after trade | 60 seconds | 0–3,600 seconds, per game. |
| Execution delay | 1 second | 1–30 seconds plus a later usable book. |
| Maximum book age | 5 seconds | Local and native reject >5 seconds; legacy shared schema permits up to 30 seconds. |
| Session loss threshold | 20% | Positive, ≤50% of starting cash. |
| Football report age | Polymarket 45 seconds; ESPN 90 seconds | Separate provider report ages; both receipts stay within 45 seconds. A new clock or fetch never resets the drive's age. |

The local rules dialog hides fixed strategy/drop/rise/target inputs. Main controls are budget, loss threshold, maximum hold and spread; additional history, delay, freshness, rest and session-risk controls remain expandable. A legacy draft has an explicit Use local decision engine option; Apply is still required. Legacy dialog/schema ranges can be broader than native limits, but a rejected save does not mean the wider value was accepted.

Changing leagues clears focus. A rule update cancels pending buy, increments `rulesRevision`, and clears baseline/signal history, while preserving unexpired cooldowns and held exit snapshots. Expected revision and session identity prevent an old dialog from silently overwriting a newer update. A source-default edit does not retroactively rewrite persisted accounts.

## Claude adviser and memory

Claude is optional advice-only chat. The paper engine does not require it, and the native runner has no paid-model client. Opening chat, reading messages, saving notes, polling, and engine ticks do not invoke Anthropic. **Send** makes a token-count request and, if accepted, a message request. Uncertain failures are not automatically retried.

### Context

Each question includes a fresh snapshot of saved rules/revision, paper status/balance, open positions and available game facts with their times, evaluation/rejection counts, the last six decisions, and last four fills. It adds notes up to 1,200 characters and the last six chat messages truncated to 1,600 characters each. Questions are limited to 1,200 characters. Serialized request size is capped at 12 KiB and the server's count-tokens check limits input to 18,000 tokens.

This is bounded recent context plus a current snapshot, not unlimited memory, a vector database, full-journal upload, web browsing, broadcast listening, or an autonomous summarizer. The fresh snapshot takes precedence over old chat. Saved notes are preferences, not authority to trade.

The adviser has no tool to trade, change rules, or apply suggestions. A suggestion must be separately applied through Bot rules. It only has the snapshot and bounded conversation supplied to that request.

### Model and cost truth

The configured literal ID is `claude-sonnet-5` in [advisor.ts](../lib/tennis/advisor.ts). **This audit did not verify current provider availability or pricing for that ID.** A present secret or “connected” label is configuration status, not proof of a successful inference. No paid model call was made during the documented rollout.

The local allowance is **$1**, reserving **$0.05 per Send**, up to 20 reservations. Its allowance key is site-wide; notes/messages are owner-scoped. It does not reset automatically each day. Uncertain requests retain their reservation. Repeated request IDs are handled idempotently; changed instructions cannot reuse the same ID.

Output is capped at 512 tokens, thinking is disabled, and the prompt requests under 120 words. Estimated cost is `inputTokens × 2 + outputTokens × 10` microdollars: assumed $2/$10 per million tokens. These are **code assumptions, not verified current provider rates**. The local allowance is not a provider billing cap. Dugout does not read the user's Anthropic balance, including a previously mentioned $10 balance.

Store `ANTHROPIC_API_KEY` only in private server secrets. Never paste it into the adviser, source, a browser variable, screenshots, or exported documentation. Send shares the bounded snapshot, notes, and recent chat with Anthropic. Without the key, the paper bot works and adviser sends fail without a call. Account-specific access restrictions are described under Authentication; they are independent of whether a key exists.

## Architecture and interfaces

```text
Browser (signed in through Cloudflare Access with Google)
  └─ React dashboard → same-origin /api/tennis/*
          ↓
Site Worker "dugout" (worker/cloudflare-entry.ts)
  ├─ verifies the Access token on every request; account id = u_ + hash(email)
  ├─ D1 "dugout": caches, adviser data, browser accounts, journals, runner fences
  ├─ read-only quote/game-report fetches for visible charts (separate report lane)
  └─ signed server-to-server proxy to the account's runner (state passed through as text)
          ↓ HMAC + owner + epoch + timestamp + nonce
Runner Worker "dugout-paper-runner" → one SQLite Durable Object per account
  ├─ authoritative paper session, commands, journal, inputs
  ├─ shared deterministic engine and execution simulator
  ├─ read-only WebSocket (with the account's own key) + bounded REST
  └─ persistent alarms: 10 s before kickoff, 2.5 s live or while holding
```

[app/page.tsx](../app/page.tsx) renders the active `TennisDashboard`. Shared `tennis` folder/type/route names now also carry NFL/CFB behavior. They are not evidence that football lacks support, and renaming/removing them is not needed to enable football.

### Dashboard routes

| Route | Purpose |
| --- | --- |
| GET `/api/tennis` | Verified catalog or selected market/history, with partial-discovery/errors. |
| GET `/api/tennis/session` | Session/runtime; native proxy after migration. |
| POST `/api/tennis/session` | Validated controls; old browser ticks become native reads after cutover. |
| GET `/api/tennis/session?export=1` | Saved-history download; native results streamed through authenticated backend. |
| GET `/api/tennis/book?slug=...` | Selected-game display book; no engine tick or trade. |
| GET `/api/tennis/context?slug=...` | Verified football report, assessment/error, successful-check time; no ledger mutation. |
| GET `/api/tennis/stream` | Visible dashboard stream, separate from native engine lifecycle. |
| GET/POST `/api/tennis/runner` | Migration status/prepare/advance/activate. |
| GET/POST `/api/tennis/advisor` | Read chat/status, save notes, explicit Send. |

Book/context requests resolve verified cached metadata or a held/pending market instead of waiting on full discovery. They have 6.5-second whole-route budgets and bounded suboperations; the priority report source check is at most two seconds. The catalog route has a ten-second bound, with a smaller collection deadline and saved-list fallback. Stale saved rows retain original ages and explicit incomplete/error status.

Visible selected book/context polling aims for about three seconds **after the previous request finishes**. Catalog refresh follows completion/cursor state. These are targets, not guaranteed rates. Source request budgets and persisted 429 backoff can slow them down.

### Retained legacy code

Older MLB/NFL scanners, autopilot experiments, replay fixtures, manual-order types, former dashboards, and a standalone stream service remain in this repository. Some old API routes remain executable. Their presence does not make them the current home-page architecture or mean they are automatically running.

`POST /api/trading/orders` returns **410**, “Order entry has been retired. Use the bot controls.” The matcher still recognizes historical `MANUAL` records, and the current engine cancels an old non-automatic pending buy. Historical manual records remain, sometimes labeled “Earlier activity.” It would be false to claim all manual code/history was deleted.

`pnpm trading:stream` starts the older standalone stream service; it is not needed for native DO operation. [.env.example](../.env.example) lists configuration names for Sites, the native runner, the adviser, and this optional older service; it contains no production values. Do not start legacy automation as a workaround for a paused native account.

## Authentication and secrets

The site Worker (`worker/cloudflare-entry.ts`, `lib/server/cloudflare-access.ts`) verifies the Cloudflare Access JWT on every request:
- **Checks:** the RS256 signature against the team's published keys, the audience, the issuer and the expiry.
- **Identity:** it derives the account id from the verified email and sets the internal identity header itself. A client-supplied identity header is refused.
- **Fails closed:** without `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, everyone is refused. On Cloudflare Workers Builds the build refuses to produce an unprotected site.
- **Runner checks:** the runner proxy requires a valid account id and never guesses one. The runner accepts signed requests only for accounts on its allow-list, and the Durable Object checks owner and epoch again.

Local portable sign-in is simulated, not production login.

Native mutations require exact same-origin requests and reject cross-site/same-site fetch metadata. The older generic `sameOrigin()` only rejects a present mismatched Origin. Do not claim all legacy routes have identical protections.

### Account scope

Every invited identity gets its own D1 paper account. Background runners are separate Durable Object instances keyed by account (`idFromName(owner)`), so no account can see or change another's.
- **Who may set one up:** accounts on the site's `DUGOUT_RUNNER_USERS` list, and the runner's `RUNNER_OWNERS` list, may set up a runner. `*` means every invited account.
- **Owner-only extras:** the owner (`DUGOUT_OWNER_ID` = `RUNNER_OWNER_ID`) additionally gets the Claude adviser, the owner's Polymarket stream keys, and the all-games research sweep.
- **Personal key:** anyone may add their own read-only Polymarket key ("Live prices"). It is checked with a balance read, sent once to their own runner, stored encrypted (AES-GCM), and never returned.

### Configuration names

| Name | Location / purpose |
| --- | --- |
| `DB` | Site D1 binding (`dugout` database; id via `DUGOUT_D1_DATABASE_ID` at build time). |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Build variables: the Cloudflare Access team domain and application audience. Without them the site refuses everyone. |
| `DUGOUT_RUNNER_URL` | Site secret: HTTPS runner origin. |
| `DUGOUT_RUNNER_SECRET` | Site secret: signs runner requests; equals the runner's `RUNNER_HMAC_SECRET`. |
| `DUGOUT_OWNER_ID` | Site secret: the owner's account id (`u_` + hash of the sign-in email); owner extras. |
| `DUGOUT_RUNNER_USERS` | Site secret: `*` or a comma list of account ids allowed a background runner. |
| `RUNNER_HMAC_SECRET` | Runner secret: signature verification and credential-key derivation. |
| `RUNNER_OWNER_ID`, `RUNNER_OWNERS` | Runner variables: the owner, and `*` or a comma list of other allowed accounts. |
| `RUNNER_ENGINE_VERSION` | Runner variable: the build's commit, for replay provenance. |
| `LAKE`, `LAKE_PREFIX` | Optional runner R2 binding for research recording and Octopus logs. |
| `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY` | Owner's server-only feed credentials. |
| `ANTHROPIC_API_KEY` | Optional site secret for the owner's adviser. |

Never put signing/provider secrets in browser/public environment variables. The native runner has no real-order route or model client. Feed credential verification is a read-only account call; `liveEnabled` remains false.

The signed canonical input contains method, path/query, exact UTF-8 body hash, owner, millisecond timestamp, nonce, and epoch with `DUGOUT-RUNNER-V1` prefix. HMAC-SHA256 produces a base64url signature. Allowed skew is 30 seconds; used nonces persist 65 seconds. Command IDs separately prevent duplicate accounting. A retry uses a fresh nonce and the same logical command ID; changed instructions under that ID fail. Redirects are rejected without forwarding credentials.

Native provider credentials use AES-256-GCM with a random nonce. HKDF derives a separate-purpose encryption key from the signing secret, bound to owner and epoch. SQL stores ciphertext; ordinary exports/responses/logs exclude credentials. Coordinated HMAC rotation requires retransferring feed credentials.

Sources: [owner-access.ts](../lib/server/owner-access.ts), [sites-proxy.ts](../lib/runner/sites-proxy.ts), [protocol.ts](../lib/runner/protocol.ts), [feed-credentials.ts](../services/runner/src/feed-credentials.ts), and [account access tests](../tests/invited-paper-access.test.ts).

## Background migration and operation

### One-writer cutover

Migration requires inactive entries, no open position, and no pending order. Sites first persists an owner fence, source revision, snapshot, and epoch. While frozen, a failed runner connection cannot restore browser trading as fallback.

Transfer hashes the exact snapshot/chunk bytes. Activation verifies counts/hashes, referenced observations, six-decimal cash, closed positions, and exact agreement of snapshot ledger and execution journal. It preserves source history and records a checkpoint. Identical chunk retries are safe; changed content under the same identity fails.

Chunk limits: 250,000 UTF-8 bytes/2,000 rows. Manifest limits: 2,000 chunks, 64 MB total, 250,000 journal and observation rows each. Missing required evidence blocks activation; none is invented.

Activation leaves idle/paused sources paused and stopped sources stopped. It schedules no automatic Start. Sites switches authority only after verification. Re-enabling browser writes for an active migrated owner is not a safe rollback method.

### Runtime

Alarms target 10 seconds before kickoff with nothing held or pending, and 2.5 seconds once a watched game is live or anything is held or pending. A recovery alarm is persisted before external I/O. Network/platform latency can extend actual cadence. Revision/session/epoch comparison prevents stale asynchronous work overwriting a control or reset.

Held markets and pending intents have input priority. Football reports run alongside books; ordinary held-position exits do not wait for a slow report. New/pending buys await a bounded context check. Detached reports/socket setup use `waitUntil`. Verified focused metadata survives object reconstruction. Tennis context has a separate 15-second cache; fee/tick/size metadata has a 60-second refresh clock.

A fresh confirmed end of the focused game pauses new entries and records why. Held exits continue. A paused/stopped flat account closes its provider socket and deletes its alarm. Stop with held quantity still needs future usable book/settlement data.

The API supports optional observation durations from one minute to six hours. Expiry pauses entries. `watchedMs` counts bounded intervals with valid live inputs, not every wall-clock millisecond. Native Start/Resume without a duration clears an old browser observation window, records that transition, and runs until another stop condition.

### Cost/source controls

**Runner write budget:** the runner counts the rows its SQLite storage reports as written, per UTC day. At **1,000,000** rows (raised from 90,000 after the move to Workers Paid, which includes 50 million rows a month) new entries pause; held positions are still managed.
- **Normal use:** about 6 rows per check.
- **Saved only on change, or once a minute:** health status, saved game copies, and the counter itself.
- **Pregame cadence:** the 10-second pregame cadence also halves usage before kickoff.

**Site budget:**
- **Writes:** D1 allows 100,000 rows written a day on the Free plan. A game's cached row is rewritten only when the game changes, or once per 10 minutes.
- **CPU:** each site request has 10 ms of CPU on the Free plan. The site passes runner state through as text rather than re-parsing it. The page shows a connection banner only after two failed checks in a row.

**Provider pauses (429):**
- **Two lanes:** game reports have their own lane and pause, separate from prices and the game list. A rate limit on one never silences the other.
- **Pause lengths:** a report 429 pauses reports for 15 s by default; other requests honour Retry-After (at least 60 s on the site).
- **Report checks:** may take 3 s. A check counts as fresh only if Cloudflare says it was fetched or revalidated from the origin on that request.

## Journal exports and replay

Use **More details → History → Download complete saved history**. Native exports use schema version 3 and a fixed account snapshot/journal boundary, held by export ID for 24 hours during pagination.

Inspect separately:

- `session`: exact snapshot with saved config/balance.
- `records`: decisions, executions, controls, shadow exits, replay frames, checkpoints, archives, migration records.
- `observations`: referenced source inputs.
- `recordCount`, `observationCount`: totals included.
- `truncated`: do not call a truncated audit complete.
- `missingObservationIds`, `pageEvidenceComplete`: supporting evidence completeness.
- `exactReplayStartsAt`: migration checkpoint for native exact replay.

Pagination `complete` means all pages were read, not that every source reference exists or every old tick was captured.

Every committed native action/tick, including no-input ticks, records input content hashes, time, engine/build identity, source failures, and before/after hashes in the same transaction as session/journal changes. Reset identity is captured as replay entropy. New rows reference exact evidence using `runnerFrameId`/`runnerInputIds`.

Local entry evaluations carry optional `analysis` objects with enter/wait/reject, reasons, thresholds and finite-or-null measurements. Pending entry analysis is revalidated on the later book; the filled position saves `entryAnalysis` and `exitPlan`. Optional `exitAnalysis` records the later adaptive assessment, while `exitState` holds its persistent peak/floor/evidence. These fields do not backfill nonexistent analysis into old journal rows. A saved entry scenario is historical evidence, not a newly recomputed current price opinion.

[replay.ts](../lib/runner/replay.ts) exposes `replayFrame`: validate checkpoint/input hashes, run the same reducer, compare output hash. There is no complete general replay/profit-proof UI. Use the matching engine source and recorded checkpoint for offline verification; changed engine code can intentionally produce a different result.

Legacy imported records are valuable history but do not capture every historical tick. Exact whole-strategy replay is **not** claimed before migration. Never backfill unknown quotes or relabel manual activity as automatic strategy success.

## Local development

### Requirements and install

The application uses React/TypeScript, Vinext and Vite for a Sites Worker, plus a separately configured native Worker. [package.json](../package.json) declares Node **>=22.13.0** and **pnpm 11.25.0**. Recorded verification used Node 24.20.0. Preserve the pinned manager and checked-in lockfile.

With pnpm 11.25.0 available, from the checkout:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

These are intended repository commands. A fresh clean-machine installation was **not tested for this documentation audit**. `install:ci` invokes Bash and is not a universally portable Windows installer. Diagnose installation errors without casually replacing dependency/lockfile versions.

Default portable development uses port 5173. Ignored `.sites-runtime/execution-profile.json` can choose `portable` or `managed-linux`; a clean clone defaults to portable. The latter is checkout-local tooling, not production configuration.

Portable development offers `/signin-with-chatgpt?return_to=/` using a simulated local identity. It does not sign into the real hosted account or validate production authentication. Use synthetic local paper data rather than attaching a scratch preview to the production runner to bypass sign-in.

### Build and local Worker preview

```powershell
pnpm build
pnpm start
```

Build produces `dist/server/wrangler.json`. Start launches local Wrangler on loopback with `.wrangler/state` persistence; it does not publish. That local production preview does not supply the portable-dev auth mock. Use the printed address rather than assuming a port from an old browser tab.

[.openai/hosting.json](../.openai/hosting.json) is the older Sites build's binding file; the Cloudflare build uses `vite.config.ts` (self-hosted config, `DUGOUT_D1_DATABASE_ID`). Generated Sites configuration is separate from [services/runner/wrangler.jsonc](../services/runner/wrangler.jsonc). Do not overwrite the Sites setup with a new root Wrangler configuration when editing the runner.

Schema is in [db/schema.ts](../db/schema.ts), with six numbered SQL migrations under [drizzle](../drizzle) at the audited revision. Apply only pending migrations in order to the intended database. Example for a known pending **local** migration after build:

```powershell
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/<pending-migration>.sql
```

Replace the placeholder with the actual pending file. Do not replay all migrations blindly or switch to `--remote` as a troubleshooting shortcut. Production schema changes need a deliberate migration plan.

`.env*`, `.sites-runtime`, `.wrangler`, `node_modules`, `dist`, and `outputs` are ignored. A source package does not include dependencies, runtime secrets, production SQLite data, or private exports. Use hosting secret management instead of putting credentials in documentation.

### Native setup

Native configuration names Worker `dugout-paper-runner`, binding `PAPER_RUNNERS`, class `OwnerPaperRunner`, SQLite migration `v1`, and compatibility date `2026-09-26`. Checked-in owner/engine values are placeholders. Deployment needs the exact existing owner and correct shared-engine version.

A new setup provisions the Worker, its HMAC secret, corresponding Sites URL/secret, and applicable account-access pin, then uses authenticated migration. The matching secrets have different variable names on Sites and native Worker. Missing/mismatched owner, secret, or epoch should fail closed. An update to the current account must retain its owner and Durable Object namespace.

The actual release used authenticated Cloudflare and Sites tooling. No one repository script recreates all hosting accounts, binding IDs, secrets, private permissions, and saved migration checkpoints on a fresh machine. Those are operational inputs, not values to infer from source.

## Editing, testing, and publishing

### Where to edit

| Change | Main sources |
| --- | --- |
| Dashboard appearance/controls | [tennis-dashboard.tsx](../components/tennis/tennis-dashboard.tsx), [tennis.css](../components/tennis/tennis.css) |
| Chart/side selection/gaps | [match-chart.tsx](../components/tennis/match-chart.tsx), [chart-data.ts](../lib/tennis/chart-data.ts) |
| Field and report/check ages | [football-field.tsx](../components/tennis/football-field.tsx), [context-check.ts](../lib/tennis/context-check.ts) |
| Polling/control requests | [use-tennis.ts](../components/tennis/use-tennis.ts) |
| Config/defaults/validation | [rules.ts](../lib/tennis/rules.ts), [rules-dialog.tsx](../components/tennis/rules-dialog.tsx), [types.ts](../lib/tennis/types.ts) |
| Signals/entry/exit reducer | [engine.ts](../lib/tennis/engine.ts) |
| Local quantitative entry scenario | [opportunity.ts](../lib/tennis/opportunity.ts) |
| Adaptive exit plan, measurements and assessment | [exit-analysis.ts](../lib/tennis/exit-analysis.ts) |
| Explicit Start policy upgrade | [start-control.ts](../lib/tennis/start-control.ts) |
| Optional recorded decision metrics | [decision-evidence.ts](../lib/tennis/decision-evidence.ts), [decision-metrics.tsx](../components/tennis/decision-metrics.tsx) |
| Context quality/boundaries | [football-context.ts](../lib/tennis/football-context.ts), [priority-context.ts](../lib/tennis/priority-context.ts) |
| Isolated exit experiments | [shadow-exits.ts](../lib/tennis/shadow-exits.ts) |
| Paper execution/fees/money | [execution.ts](../lib/trading/execution.ts), [money.ts](../lib/trading/money.ts) |
| Provider identities/status | [normalize.ts](../lib/tennis/normalize.ts) |
| Discovery/data collection | [data.ts](../lib/tennis/data.ts), [catalog-loader.ts](../lib/tennis/catalog-loader.ts), [native input-adapter.ts](../services/runner/src/input-adapter.ts) |
| Fresh REST provenance | [fresh-book.ts](../lib/trading/fresh-book.ts), [fresh-event.ts](../lib/trading/fresh-event.ts) |
| Native scheduling/atomicity | [worker.ts](../services/runner/src/worker.ts), [store.ts](../services/runner/src/store.ts) |
| Migration/proxy | [sites-migration.ts](../lib/runner/sites-migration.ts), [sites-proxy.ts](../lib/runner/sites-proxy.ts) |
| Adviser context/model/cost assumptions | [advisor.ts](../lib/tennis/advisor.ts), [adviser route](../app/api/tennis/advisor/route.ts) |

Changing a source default does not update persisted config. Ordinary settings use explicit rule updates. New policies must preserve old record meaning, carry version information, and test existing saved state. Do not widen a held exit limit through incidental normalization.

Keep the reducer pure and transport-free. Retries must not duplicate cash changes. Preserve source times, explicit identity, delayed execution, fees, single-writer authority, and replay evidence. Test demonstrated failure and genuine pass cases rather than only mirroring the new implementation's formula.

### Verification commands

With dependencies installed, from repository root:

```powershell
pnpm test
pnpm exec tsc --noEmit
pnpm runner:check
pnpm lint
pnpm build
pnpm runner:build
```

`test` includes main tests, legacy trading service tests, and native runner tests. Native TypeScript has its own project. `runner:build` is a **Wrangler dry run**, not deployment. `db:generate` generates migrations but does not apply them to production.

Focused checks include:

```powershell
node --experimental-strip-types --test tests/tennis-engine.test.ts tests/tennis-auto.test.ts tests/football-context-engine.test.ts
node --experimental-strip-types --test tests/priority-context.test.ts tests/fresh-event.test.ts tests/tennis-selected-route-deadline.test.ts
node --experimental-strip-types --test services/runner/tests/*.test.ts
```

Coverage includes synthetic signals, warm-up independence, rejection gates, delayed fills/fees, football conflicts/boundaries, shadow isolation, migration, encryption, command races, source ordering, deadlines, backoff, and replay. It is not proof of every production failure mode or live profitability.

The rollout noted two pre-existing explicit-`any` lint findings in `lib/server/polymarket.ts`. Changed-file scoped lint was verified; do not claim repository-wide lint was entirely clean from that evidence. Report actual current results for each later revision.

### Publishing

1. Preserve a source checkpoint and authenticated history export before stateful migration. Keep private exports/secrets outside Git.
2. Run relevant tests, both TypeScript checks when shared code changes, and required builds.
3. Push to `main`. Cloudflare Workers Builds redeploys both the site and the runner ([CLOUDFLARE-HOSTING.md](CLOUDFLARE-HOSTING.md)), keeping the Durable Object namespace, owner and secrets, and setting `RUNNER_ENGINE_VERSION` to the commit.
4. Verify actual success and source identity. A build, dry run, pushed commit, or queued request is not deployment success.
5. Reload the authenticated site and verify unchanged account/ledger/positions, runtime, controls, book/context refresh, and relevant errors.
6. Starting paper trading is a separate operational action. Do not force a fill or weaken a gate to make a deployment look successful.

Normal updates do not require re-importing the active account. Retain the ownership fence if the runner is unreachable. Recreating objects, dropping tables, changing owner identity, or restoring browser writes can fork history and are not routine repair steps.

For a maintainer-oriented handoff, see [MAINTAINER-HANDOFF.md](MAINTAINER-HANDOFF.md). The user-facing [chad.md](../chad.md) has a shorter onboarding path; neither document grants hosting access by itself.

## Troubleshooting

| Symptom | Meaning / check |
| --- | --- |
| Not trading | Read the status box. Normal reasons: paused/idle, the 30-second pull after a play, an old game report, a book wider than 5¢, or no qualifying evidence. Offers only fill when someone sells at that price. |
| "Bot is behind" | No bot check for 45 s (background) or 30 s (browser). Reload if it lasts more than a minute. |
| Game report stale | The tracker shows why the last check failed (timeout, provider pause, cached reply). Offers stay down until a fresh report arrives. |
| "Server returned an unreadable response (503)" | Usually the Free plan's 10 ms CPU limit on a request; it passes. Persistent 503s: consider the Workers Paid plan. |
| Shares held on one team only | Steady pairs or sells within 10 minutes. Bold takes its profit at 5¢ up, may buy once on a dip, and has a loss limit after that. Open orders & shares shows the plan. |
| Writes counter high | See Cost/source controls. Entries pause at 1,000,000 rows a day; held positions continue. |
| Can't set up background bot | Finish or end open trades first; the account must be on the runner allow-lists. |
| Switching games | Allowed any time; holdings stay managed on their own game. |
| Provider asks to slow down | Honour the pause; refreshing cannot shorten it. |
| Claude unavailable | Owner-only; needs `ANTHROPIC_API_KEY`. |

A useful report includes the time, game, status-box text, the ages in its chips, and any error text.

## Limitations and outstanding validation

- **Unproven strategies:** no strategy is proven profitable. Resting-order evidence is still being collected; paper fills are conservative and do not model queue position.
- **Bold's extra rules:** the dip buy and loss limit were chosen by the owner on October 3, 2026 for bigger swings, not derived from evidence. Their ledger rows ("Bold dip buy", "Bold loss limit") exist so their results can be measured.
- **Game reports:** Polymarket and ESPN can lag or pause independently. Source-specific age limits and matching scoreboard facts keep new entries waiting when the drive cannot be used. Increasing an allowance does not make delayed data live.
- **Provider and quotas:** provider outages, payload changes and Cloudflare quotas are external; the guards above reduce but do not remove them.
- **Real money:** not connected (`lib/live/README.md`).

For the next live validation, retain paper-only operation and current spread/freshness limits, choose a verified current focus, explicitly start when the daily budget permits, record browser-closed time, export afterward, and reconcile every fill/cash delta. If no qualifying automatic round trip occurs, report the actual reasons and retain the unverified milestone. Do not change rules merely because time passed or a trade would make the test appear successful.

Additional operational source: [native runner README](../services/runner/README.md), [session API](../app/api/tennis/session/route.ts), [request/profile storage](../lib/server/storage.ts), and [release evidence](RELEASE-STATUS.md).

Documentation work itself made no paid calls, changed no production controls, copied no secrets, and inferred no live-trading success.
