# Dugout: user and developer manual

This manual describes the paper bot source, including the versioned `local-move-v1` decision engine, adaptive exits, interface and invited-account access guards. The original infrastructure audit used commit `5ac6e98f89755381d9164980ab8556b18efd7ede` on September 26, 2026. Publication and test status of later changes is recorded separately in [RELEASE-STATUS.md](RELEASE-STATUS.md). Implemented behavior and dated production observations are distinct. A saved account can have different settings from the defaults listed here. Its loaded configuration and exported journal are authoritative for current balance, rules, focus, and status.

Dugout's home page is a tennis and American football **paper-trading dashboard**. Its local decision engine uses deterministic market calculations, not Claude. It evaluates quotes and simulates purchases and exits. The private dashboard and its API are hosted on ChatGPT Sites. The migrated owner's background engine and journal live in a separate Cloudflare Worker with a SQLite Durable Object. Closing the dashboard does not stop an already-running native runner; a paused flat account does not start itself.

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

The hosted dashboard is [Dugout](https://dugout-signals.rowdybard.chatgpt.site/), using the site's existing authentication. There is no implemented independent Gmail or Cloudflare Access login flow for this dashboard.

[RELEASE-STATUS.md](RELEASE-STATUS.md) summarizes these **dated observations** from the local `outputs/background-runner-rollout.md` record. Private exports and the ignored `outputs/` folder are not included in the source package.

- The native Worker and private Sites application were published from `5ac6e98` on September 26, 2026, at approximately 23:26 and 23:30 UTC respectively.
- The existing account was migrated **paused**. No production Start command was issued during that rollout or the subsequent feed verification.
- Reconciled cash was exactly **$93.93805**, displayed as **$93.94**, from $100 starting cash. There were 19 ledger fills and $4.11 in recorded execution fees. These are historical account totals, not a current balance guarantee or evidence of new-runner profit.
- All 13,103 records and 4,373 observations in the pre-migration export were preserved with matching canonical hashes. Later decisions, a pause, and the checkpoint brought the export to 13,130 records. Ledger and positions agreed; no missing observations or truncation were reported.
- Visible verification showed fresh selected-game books and independently updating football reports. Selecting Wisconsin–Penn State changed the chart, not the saved bot focus, and did not start trading.
- A read-only native adapter smoke check obtained a football input in 191 ms, with an 18.161-second-old provider report and an 80 ms REST receipt. It used a synthetic in-memory account and did not advance the engine or write the production account.
- The recorded full suite passed 495 tests before the final backoff patch. That patch added three regressions; 23 relevant adapter/transport tests passed afterward. Both TypeScript projects and builds passed. These counts describe that verification, not an assertion that every later edit has been tested.

**A continuous 60-minute run with the browser closed, followed by a genuine native bot-initiated entry and exit, is still unverified in that record.** A feed check, synthetic test, imported historical fill, or run containing only valid rejections does not establish that milestone. None establishes profitability.

The subsequent interface/account-access source release passed 503 full tests, both TypeScript checks, scoped changed-file lint, the Sites build, and runner dry build. See [RELEASE-STATUS.md](RELEASE-STATUS.md) for its publication status and any later results; these checks do not replace the outstanding live validation.

## Using the dashboard

### Start with the saved account

1. Open the site and load the saved account. Check cash, session state, any open position, and any pending order.
2. Choose Tennis, Football, or Both. This changes allowed leagues and clears the saved focus through a rules update. Tennis infrastructure remains available when football is selected.
3. Choose a game to inspect. Read its buy/sell quotes, game status, and report age. Selecting a chart does **not** authorize that game as the bot focus.
4. Use the explicit focus control to save that game as the bot focus. Native Start/Resume requires one focus. It never silently switches to another game when the focused game ends or becomes unavailable.
5. Inspect Bot rules: dollars per trade, loss-exit threshold, maximum hold, spread and rest. Saved values can differ from factory defaults. The local model evaluates setups and adjusts profit exits; it does not choose your stake or widen your saved risk limits.
6. Press Start when you want paper checks to begin/resume. For an older account, the UI first records a rules update selecting the local engine and football quality policy. It preserves money, stake, rest and loss/time settings, while requiring at least 30 seconds/10 quotes and at most 2¢ spread/5-second book age. A failed policy save prevents Start. A waiting reason, rejected setup, pending intent, and completed fill are different states.
7. Use **More details → History → Download complete saved history** to review results. The chart/recent activity are useful views, but the export is the accounting record.

An already-migrated account does not need migration again. Do not create a new run to refresh a feed: that creates a new simulated bankroll and changes which session is being measured.

### Layout

The primary view keeps Start/Pause/Stop, Bot rules, sport selection, decision/freshness, runtime status, balance/cash, entry amount, reset, focus, game picker, field, quotes/chart, team/player selection, pending/open positions, and the paper-balance chart available. Ask Claude appears only for the configured site owner. **More details**, closed initially, contains diagnostics, observation progress, History, additional market cards/filters, and the full rules summary. **Chart details** contains extra football facts/timeouts, history bounds, detailed signals/triggers, fill metadata, and explanatory text.

**Decision details** is an optional closed panel below the plain decision reason. It shows the evidence time, warm-up, measured drop/noise, recovery drift, depth, spread, costs, scenario headroom and risk ratio. While held, it distinguishes the saved entry scenario from the latest exit assessment and frozen risk limits. Chart details uses that chart's exact game and outcome. Missing measurements say Not available; an older receipt is not relabeled as a current calculation.

Errors, stale-data indicators, chart legend, and missing-quote warnings remain visible. The old Beginner mode state, toggle, and localStorage preference were removed in the reviewed interface change. A previously saved `true` value no longer controls the interface. Plain wording does not mean the engine has fewer checks.

### Controls

| Control | Actual effect |
| --- | --- |
| Choose chart/game | Changes inspection and priority display refresh. Does not change saved focus or trade. |
| Switch chart team/player | Displays YES or NO quotes. Does not limit which outcome the engine may buy. |
| Set focus | Saves one market slug through a rules update. A held position still receives exit checks. |
| Start | Saves the current local policy when required, then starts an idle account or resumes a paused one. Native operation requires focus and available daily write budget. |
| Pause | Blocks entries and cancels a pending buy. Held positions continue ordinary exit management while their runtime operates. |
| Stop | Blocks entries; with a position it enters `stopping` and tries a normal delayed liquidation. Flat accounts become `stopped`. |
| New paper run | Only available without an open position/pending order. Archives the previous run and creates a simulated bankroll; it is not a deposit or recovery of losses. |
| Apply rules | Validates/saves a rules revision, cancels pending buy, and rebuilds entry history. Retains cash, journal, and held exit snapshots. |
| Restore defaults | Changes the dialog draft; Apply is still needed. Keeps the draft leagues/focus. |
| Reconnect/refresh | Retries account/data loading. Does not start a paused bot or create newer provider facts. |
| Ask Claude | Opens saved chat/status. Only Send invokes Anthropic. |
| Download complete saved history | Exports account, journal, and available evidence. This is private account history. |

The account has **one open strategy position globally**, not one per side or per game. It can buy either explicitly mapped outcome if that side passes all checks. Showing California on the chart does not prevent it from considering Clemson, and vice versa.

### Session states and runtimes

- `idle`: account exists but has not started.
- `running`: can build setups, stage buys, and manage positions.
- `paused`: no new entries; held positions still need managed exits.
- `stopping`: trying to close held quantity before stopping.
- `stopped`: terminal for this run; create a new run when flat to begin another.

Browser mode requires the page to stay open and visible. Service mode uses native alarms; browser visibility affects its display polling, not runner authority. Old browser ticks after migration only read native state and cannot become a second engine writer. A runtime label saying background is connected is not proof that a paused bot is actively checking or has completed a live trade.

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

The field uses explicit team identities, possession, down, distance, field-position team/yard, score, quarter, and clock. It does not invent plays or interpolate ball movement. Under `football-context-v1`, both provider-report and receipt age must be at most **45 seconds** for entry screening. Missing mappings/facts, future times, regressing reports, and conflicting facts at the same timestamp block entry. Down zero during an incomplete kickoff report is not valid first-down context.

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
| Football report age | 45 seconds | Fixed quality-policy constant, independently for report and receipt; not a normal UI rule. |

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
Authenticated browser
  └─ React dashboard → same-origin /api/tennis/*
          ↓
ChatGPT Sites backend
  ├─ owner identity from Sites authentication
  ├─ D1: caches, adviser data, browser accounts, old journal, migration fence
  ├─ read-only quote/context fetches for visible charts
  └─ signed server-to-server proxy for a migrated owner
          ↓ HMAC + owner + epoch + timestamp + nonce
Cloudflare Worker → owner-named SQLite Durable Object
  ├─ authoritative native paper session, commands, journal, inputs
  ├─ shared deterministic engine and execution simulator
  ├─ native read-only WebSocket + bounded REST
  └─ persistent alarms for checks without the dashboard
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

Sites supplies `oai-authenticated-user-id` at the private hosting boundary. The runner proxy requires a valid owner ID and never guesses one. The Worker accepts signed requests only for its configured owner; the Durable Object checks owner and epoch again. An email address is not a replacement for that owner ID.

This depends on trustworthy headers supplied by the Sites outer boundary; it is not standalone public-site authentication. Local portable sign-in is simulated, not production login. The lower-level legacy `profile()` helper retains a `private-owner` fallback; exposing old routes directly on an unprotected host would not preserve the intended boundary. Active migrated session paths deliberately validate owner before that helper.

Native mutations require exact same-origin requests and reject cross-site/same-site fetch metadata. The older generic `sameOrigin()` only rejects a present mismatched Origin. Do not claim all legacy routes have identical protections.

### Account scope

An authenticated different Sites identity without a runner fence receives its own D1 paper account and browser runtime, starting with the new-account defaults. It does not gain the native owner's balance or journal. Each identity's session controls, archived runs, and history export are scoped separately. Access to the private site still requires the hosting invitation/authentication flow; possessing source files grants none.

The included account-access patch uses server-only `DUGOUT_OWNER_ID` to restrict background setup and paid adviser access to the pinned owner. It must exactly match native `RUNNER_OWNER_ID`. For another identity, migration status is ineligible and prepare/advance/activate return 403 **before any pause, account freeze, migration write, or native request**. The guest retains browser paper mode with the page open and visible. No separate native object/account is automatically provisioned for that customer.

Guest adviser GET returns only disabled/unconfigured status, without reading private chat or allowance. Guest Send and Save notes return 403 before reading/reserving allowance, changing notes, or making provider requests. The UI hides Ask Claude and background setup for ineligible accounts. A missing/invalid owner pin disables new background setup and adviser access for everyone without destroying sessions or migration fences; it does not disable management of an already-migrated runner account through its existing signed owner/session path.

Synthetic actual-route/SQLite tests verify isolation and denied side effects. A real invited customer's login and complete paper run remain **unverified** until performed through the deployed private site. The documented native background validation applies only to the pinned owner's migrated account. This is not a shared-bankroll multiuser trading service.

### Configuration names

| Name | Location / purpose |
| --- | --- |
| `DB` | Sites D1 binding. |
| `DUGOUT_RUNNER_URL` | Sites server: HTTPS runner origin. |
| `DUGOUT_RUNNER_SECRET` | Sites secret: signs requests; matches native HMAC secret. |
| `DUGOUT_OWNER_ID` | Sites server: identity permitted background setup and paid adviser access; must match `RUNNER_OWNER_ID`. Missing/invalid pin disables extras. |
| `RUNNER_HMAC_SECRET` | Native Worker secret: signature verification and credential-key derivation. |
| `RUNNER_OWNER_ID` | Native Worker: exact existing Sites owner identity. |
| `RUNNER_ENGINE_VERSION` | Native Worker: exact shared engine commit/build identity for replay. |
| `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY` | Server-only feed/credential verification. Strict REST paper fallback can operate without stream credentials. |
| `POLYNARKET_KEY_ID` | Retained misspelled compatibility alias; prefer correct spelling. |
| `ANTHROPIC_API_KEY` | Optional Sites server secret for adviser Send only. |
| `TRADING_SERVICE_URL`, `TRADING_SERVICE_TOKEN` | Optional older stream service, not DO authority. |

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

Alarms target 2.5 seconds after a completed check. A recovery alarm is persisted before external I/O. Network/platform latency can extend actual cadence. Revision/session/epoch comparison prevents stale asynchronous work overwriting a control or reset.

Held markets and pending intents have input priority. Football reports run alongside books; ordinary held-position exits do not wait for a slow report. New/pending buys await a bounded context check. Detached reports/socket setup use `waitUntil`. Verified focused metadata survives object reconstruction. Tennis context has a separate 15-second cache; fee/tick/size metadata has a 60-second refresh clock.

A fresh confirmed end of the focused game pauses new entries and records why. Held exits continue. A paused/stopped flat account closes its provider socket and deletes its alarm. Stop with held quantity still needs future usable book/settlement data.

The API supports optional observation durations from one minute to six hours. Expiry pauses entries. `watchedMs` counts bounded intervals with valid live inputs, not every wall-clock millisecond. Native Start/Resume without a duration clears an old browser observation window, records that transition, and runs until another stop condition.

### Cost/source controls

The native service estimates its own UTC-day SQL row writes and alarm writes. At **75,000 estimated writes**, entries pause while held exits continue. Start/Resume cannot bypass it; a paper reset does not reset the daily counter. Approximately 71,721 writes immediately after migration was a dated reading, not a current value.

This estimate is not an exact Cloudflare bill, free-tier calculator, or guarantee against account-wide limits. State reads, nonces, exports, journals, and migrations also consume resources. Other Workers, reads, duration, and platform limits are outside this guard. No automatic billing upgrade exists. Current external prices and remaining quota are not established by this manual.

429 backoff persists. Concurrent failures keep the **maximum** deadline so a shorter Retry-After cannot erase a longer pause. Source responses are bounded: normally 1 MB for books/metadata/compact football, 4 MB for event detail, and 16 MB for a discovery page capped at 20 events. Oversized responses fail rather than allowing unbounded allocation.

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

[.openai/hosting.json](../.openai/hosting.json) declares Sites D1 binding `DB` and no R2 binding. Generated Sites configuration is separate from [services/runner/wrangler.jsonc](../services/runner/wrangler.jsonc). Do not overwrite the Sites setup with a new root Wrangler configuration when editing the runner.

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
3. Publish native code with existing namespace/owner/secret and correct `RUNNER_ENGINE_VERSION`; publish the Sites application privately from matching source where needed.
4. Verify actual success and source identity. A build, dry run, pushed commit, or queued request is not deployment success.
5. Reload the authenticated site and verify unchanged account/ledger/positions, runtime, controls, book/context refresh, and relevant errors.
6. Starting paper trading is a separate operational action. Do not force a fill or weaken a gate to make a deployment look successful.

Normal updates do not require re-importing the active account. Retain the ownership fence if the runner is unreachable. Recreating objects, dropping tables, changing owner identity, or restoring browser writes can fork history and are not routine repair steps.

For a maintainer-oriented handoff, see [MAINTAINER-HANDOFF.md](MAINTAINER-HANDOFF.md). The user-facing [chad.md](../chad.md) has a shorter onboarding path; neither document grants hosting access by itself.

## Troubleshooting

| Symptom | Meaning / check |
| --- | --- |
| Never buys | Read the recorded reason. Check running state, focus/leagues, fresh live status/context, spread/depth/cost, history, confirmations, cash, rest, and daily budget. No qualifying candidate is a valid result. |
| Fresh chart, old bot quote | Chart game may differ or account may be paused/flat. Display refresh is not an engine tick. |
| Old report, recent Last checked | A successful response contained unchanged old provider facts. Do not replace report time with check time. |
| Book stale | Check actual receipt/provenance and errors, not listing price. Regressive/cached/unverified responses are correctly rejected. |
| Warm-up does not finish | Check independent receipts and elapsed baseline time. Failures, edits, focus changes, or context resets can interrupt progress. |
| Pending entry disappeared | Later book failed delay/signal/context/cost/depth/limit checks. Pending is not a fill. |
| Rest after trade | Inspect saved per-game cooldown; factory defaults may not match. |
| Stop remains stopping | Quantity remains and needs a later executable book or settlement; Stop creates no buyers. |
| Wider spread/age rejected | Native hard limits remain 2¢/5 seconds despite broader legacy dialog ranges. |
| Rule update lost revision race | Reload/reopen; expected session/revision protects newer changes. |
| Provider asks to slow down | Honor 429 backoff. Refreshing cannot erase a longer persisted deadline. |
| Missing game/partial list | Read discovery error/completion state. Saved ages remain old. Held exits have separate priority. |
| Sign-in / failed-to-fetch banner | Check authenticated session and actual request response. Bootstrap may transiently fail; persistent failures need logs, not owner changes or auth bypasses. |
| Background setup stalled | Resume saved migration; frozen state remains paused instead of browser fallback. |
| Daily write guard reached | Entries wait until next UTC day; held exits continue. Paper reset does not reset usage. |
| Claude unavailable | Missing key makes no call; present key does not verify model availability. Check access, allowance, timeout, and provider error before another deliberate Send. |
| Missing chart middle | No observations may have been captured. Dashed bridges are not reconstructed prices/trades. |

A useful report includes time/timezone, game, state, focus versus chart, reason, book/report/check ages, and redacted error. Share a private export only through an appropriate private channel. Exclude keys, signing secrets, cookies, and credential-bearing request headers.

## Limitations and outstanding validation

- Strategies are unproven. The local model uses observed price movement, depth and explicit noise/cost assumptions; its scenario headroom is not a win probability or validated expected profit. It does not hear broadcasts or guarantee fills.
- The local policy and adaptive exits need their own genuine live validation. Dated feed smoke checks and older fills do not establish a live round trip under this version.
- Football currently screens entry quality and produces isolated shadow experiments. Fourth down/possession loss does not independently authorize a real paper early exit.
- The 45-second gate can correctly prevent entry during provider pauses, kickoff, breaks, or incomplete reports. Fresh quotes cannot cure missing game context.
- Native scheduling/data integration are implemented with synthetic tests and a read-only live input smoke check. The recorded 60-minute browser-closed experiment and genuine native automatic round trip remain unverified.
- Paper depth/fees do not establish real exchange execution, queue position, order acceptance, or guaranteed stop losses.
- Chart history is bounded. Legacy exact replay is limited by evidence actually saved.
- Provider outages/payload changes and Cloudflare account-wide quotas are external facts. Guards do not promise zero cost or uninterrupted uptime.
- Claude model availability/pricing, a successful paid response, and user balance were not verified in the rollout. It is optional advice, not the decision engine.
- Legacy modules/routes remain. Removing controls is not deleting types, historical records, or all old code.
- Sites authentication is an architectural dependency. Copying the app to another host does not implement Google login.
- A different identity's browser paper account must not be confused with the pinned native owner's account. Verify deployed sharing/access configuration before inviting another person.

For the next live validation, retain paper-only operation and current spread/freshness limits, choose a verified current focus, explicitly start when the daily budget permits, record browser-closed time, export afterward, and reconcile every fill/cash delta. If no qualifying automatic round trip occurs, report the actual reasons and retain the unverified milestone. Do not change rules merely because time passed or a trade would make the test appear successful.

Additional operational source: [native runner README](../services/runner/README.md), [session API](../app/api/tennis/session/route.ts), [request/profile storage](../lib/server/storage.ts), and [release evidence](RELEASE-STATUS.md).

Documentation work itself made no paid calls, changed no production controls, copied no secrets, and inferred no live-trading success.
