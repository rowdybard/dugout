# Decision engine

Added September 27, 2026. It turns the strategy lab's research into rules that every bot and person consults before a trade, with plugs where future research slots in. Code: [`lib/decision/`](../lib/decision). Evidence: [`research/studies/report.md`](../research/studies/report.md). Data and pack streaming: [DATA-PLATFORM.md](DATA-PLATFORM.md). How strategies are specified, measured in shadow, scored and killed: [STRATEGY-ARCHITECTURE.md](STRATEGY-ARCHITECTURE.md).

## The idea in one paragraph (for Chad)

We measured roughly 2,800 games of Polymarket US prices. Most simple ways of betting lose once you pay the rake (the fee and the spread). The decision engine is the hand chart built from that history. Before any bet, the bot or a person asks the engine, and it answers **GO**, **PAPER ONLY** or **NO**, with the measured expected value and its range. It never guesses. If we haven't measured a situation, the answer is NO. The research so far only tested a handful of simple strategies. The engine is built so that each new finding (a game situation, a news signal, a model) plugs in as data, not as a rewrite.

## Architecture

```
            context (market, quotes, game state, history, signals)
                                   │
   strategies ──► proposals ──► evidence gate ──► sizing ──► risk ──► plan (actions + every refusal, with reasons)
   (plugs)                      (evidence pack)   (¼ Kelly    (kill
                                 features, models  on lower    switches)
                                                   bound)
```

- **Proposing and permitting are separate.** A strategy only proposes. The engine gates every proposal against the evidence, so a new strategy can never bypass the research.
- **The evidence gate:**
  - Losers win ties, and a losing row that can't be ruled out still blocks.
  - An unknown condition never permits a trade.
  - Unmeasured regimes are refused.
  - `proven` means real money may be used; `lead` means paper only. Resting-order leads may also run as a capped real-money `pilot`.
  - Once a row measured for a strategy itself applies, it replaces **blanket** regime averages (rows with no price band, role or conditions, which measured other entry rules). Findings about a narrower slice, such as "CFB underdogs" or "MLB sides under 10¢", still bind every strategy.
  - A row can name every version of a strategy (`"comeback-drive"`) or one version (`"comeback-drive@1"`). Studies name the version, so a new version never inherits an old one's result.
- **Shadowing (the default for untested ideas):** every strategy version has a locked spec (`catalog.ts`). While it is `specified` or in research, its refused proposals are recorded with counterfactual entries and exits and scored, but never traded. See [STRATEGY-ARCHITECTURE.md](STRATEGY-ARCHITECTURE.md#8-shadow-measurement-and-counterfactuals).
- **Exploring (paper only, opt-in):** with `config.explore`, a strategy with a written `hypothesis` may trade on paper where no study covers it yet, or where only a blanket average for other rules exists. The verdict is `EXPLORE_PAPER`.
  - It is never pilot or real money.
  - It ranks below any measured result.
  - It stops as soon as a pack carries a row naming the strategy; that result then decides.
  - New accounts do not explore; the forward test is spent only on measured leads.
- **Sizing:**
  - Real money stakes ¼ Kelly on the evidence's **lower** bound, so a result whose range touches zero stakes nothing.
  - Paper and pilot trades use a fixed small stake.
- **Risk:**
  - loss caps for the day and the session;
  - an open-exposure cap and a trades-per-day cap;
  - a stale-data halt and a manual halt.
- **Plan:** at most one taker entry per market, ranked by evidence. The plan lists every proposal considered and why each was taken or refused.
- **Determinism:** the same pack, context and options always give the same plan. The engine records its version and pack version on every verdict.

| File | Role |
|---|---|
| `engine.ts` | `createEngine()`, with `plan`, `gate`, `decide`, `quotePolicy` and `regime`, plus the compiled-in `defaultEngine` |
| `context.ts` | `DecisionContext`: market, quotes, game state, price history, external signals |
| `features.ts` | Named features: price, role, spread, depth, minutes to start, score difference, period, volatility, price changes, time of day, quote and report age, book imbalance and depth within 2¢, 30-s velocity, move since pregame, the last scoring play, and `signal.*` / `game.*` pass-throughs |
| `spec.ts`, `catalog.ts`, `prereg.lock.json` | Every strategy version's spec (hypothesis, mechanism, evidence for and against, rules, exits, kill conditions, minimum sample) and the SHA-256 lock on its rules |
| `edge.ts` | Edge after costs: the calibrated lower bound minus the book-walked fill, fee and latency allowance |
| `events.ts` | Score, possession, period and dead-ball events with pre-event prices |
| `shadow.ts`, `scorecard.ts`, `why.ts` | Counterfactual legs and exits, the per-version scorecard, and the "why no trade" vocabulary |
| `evidence.ts` | The compiled-in evidence rows and the condition language |
| `pack.ts` | Evidence-pack schema and validation, the bundled pack, and the untrusted-pack restriction |
| `models.ts` | Win-probability models as JSON (`logistic-v1`, `table-v1`, `calibration-v1` with intervals) and the market-implied baseline |
| `strategies.ts` | Built-in strategies: `favourite-hold@1`, `model-edge-hold@2`, `maker-quote@1`, plus the `random-side-control@1` control |
| `sports/` | Sport modules: features and strategies for one sport, plugged into the same engine. `football.ts` holds the live football features, `comeback-drive@1` and `comeback-drive-hold@1`, `drive-fade@1`, `surprise-fade@1` and `quiet-window-maker@1`. `baseball.ts` holds live MLB features (inning, half, count, outs, runners, base-out state, who is batting), from fresh reports only. |
| `sizing.ts`, `risk.ts`, `costs.ts` | Stakes, kill switches, fees and break-even |
| `sources.ts`, `host.ts` | Streaming packs in: from a URL or an R2 binding, with a SHA-256 pin and fallback to the last good pack |
| `forward.ts`, `polymarket.ts` | Forward test and read-only Polymarket US parsing |

## Plugs for research

Every research output has a place to plug in. None of them require engine code changes, except a brand-new feature or strategy.

| Research produces | Plug | Example |
|---|---|---|
| A measured result for a regime | an **evidence row** in a pack | `{"id":"cfb-live-late-favourite","status":"lead","sports":["CFB"],"phases":["live"],"styles":["taker-hold"],"price":{"min":0.9,"max":0.97},"conditions":[{"feature":"secondsRemaining","op":"lte","value":600},{"feature":"scoreDiff","op":"gte","value":14}],…}` |
| A situation variable | a **feature** (`features.ts`, or `createEngine({features})`) | `twoMinuteWarning`, `bullpenInnings`, `lineMove60m` |
| An outside fact (news, injuries, lineups, weather) | a **signal** in the context, read as `signal.<name>` | `signals: {starterScratched: true}` plus the row condition `{"feature":"signal.starterScratched","op":"eq","value":true}` |
| A trained model | a **model spec** in the pack's `models` | `{"kind":"calibration-v1","id":"cfb-live-cal","version":"1","sports":["CFB"],"phases":["live"],"bins":[{"min":0.8,"max":0.9,"n":412,"rate":0.874,"lo":0.84,"hi":0.905}]}`. `model-edge-hold@2` proposes only when the interval's lower bound clears the break-even after fill, fee and latency, and evidence still decides. |
| A new way to trade | a **strategy** with a **spec** (`catalog.ts`, then `strategies.ts` or a sport module in `sports/`) | propose-only; the gate, sizing and risk apply automatically. Until its study reports it is measured in shadow. See [how an idea becomes a strategy](STRATEGY-ARCHITECTURE.md#13-how-an-idea-becomes-a-strategy). |
| Where resting orders are safe | **maker** evidence rows | read by `quotePolicy` and `maker-quote` |

**Delivery:**
1. Export a pack.
2. Add rows.
3. Validate it.
4. Publish it to the lake.
5. Hosts stream it in. See [DATA-PLATFORM.md](DATA-PLATFORM.md#streaming-research-into-the-engine).

A pack marked `proven` enables real money only when its SHA-256 is pinned by the owner.

## What it says today (bundled pack `evidence-2026-09-27`)

| Situation | Answer | Measured |
|---|---|---|
| NFL or MLB in-game scalping | NO | about −10% per trade |
| CFB, tennis in-game scalping | NO | not studied |
| NFL/MLB live model-vs-price bets | NO | −4% to −15% |
| MLB live sides under 20¢ | NO | −13% to −48% |
| MLB, NFL pregame | NO | efficient (price = sportsbook close) |
| CFB pregame underdogs, longshots < 15¢ | NO | −33%, −46% |
| **CFB pregame favourites** | **PAPER ONLY** | **+2.5% [−1.4%, +6.6%]** |
| Resting orders: NFL/MLB live, NFL pregame | NO | negative markout |
| **Resting orders: CFB live/pregame, MLB pregame** | **paper or capped pilot** | +0.12¢ to +0.48¢ per contract, before rewards (optimistic fills) |
| Comeback drives, drive fade, surprise fade, dead-ball quotes (NFL and CFB live) | **SHADOW** (measured, never traded) | not measured yet; `drive_entry.py`, `event_reaction.py` and `maker_windows.py` measure them on the PC |

"Favourites" here isn't the insight. Favourites win about as often as their price says everywhere except college, where **underdogs are overpriced** (people overpay for longshots). Even that lead isn't proven yet, and the forward test below will settle it.

## Who asks it

- **The paper bot.** New accounts, and any account after Start/Resume, run on the engine (`evidenceGate: 'evidence-v1'`, `maker: 'paper-v1'`). The adapter is `lib/tennis/engine-plan.ts`.
  - **Every tick, it asks `engine.plan()` for the focused game,** whether pregame or live, in any supported league: ATP, WTA, NFL, CFB, MLB. Live football plans include the verified game state.
  - **Drive trades:** a `comeback-drive` action becomes a delayed paper entry. It is re-checked on the next report: still the same drive, still the setup, still permitted. The bot then sells when the drive ends (see [Live football](#live-football-comeback-drives)).
  - **Taker holds:** the best taker-hold action becomes a delayed paper entry, re-checked on a later book (phase, execution limits and evidence). It then **holds to settlement**, and only settlement, Stop or the account loss limit closes it.
  - **Paper market making:** where resting orders are permitted, the bot rests a buy at each side's best bid, a two-sided quote (`lib/tennis/maker.ts`).
    - **Fills are conservative:** a quote fills only when the price trades through it.
    - **Rebates:** the rebate is credited on every fill, rounded to the cent like the exchange's.
    - **Limits:** inventory is capped at twice the stake per side, and both quotes' cash is reserved.
    - **When quotes come down:** they're pulled for 30 s after each live play, and cancelled on stale data, pause or a rule change. Inventory settles, or is sold on Stop.
  - **Legacy scalps** still pass through the gate and are refused, as the evidence says.
  - **Pinned evidence:** a session can pin an evidence-pack version (`config.evidencePack`). A version this host hasn't loaded blocks entries, so replays stay exact.
- **The dashboard.** The Decision engine card shows the latest plan, every proposal with its result and reason, the maker quotes, fills and rebates, and any planned holds. The game picker lists upcoming games, so pregame strategies can be focused.
- **The bet checker (for people).** The default mode is `real`. With `--slug` it reads the live book, gives a verdict per side, and prints the full engine plan: every strategy's proposal and why it was taken or refused.

  ```sh
  node --experimental-strip-types scripts/check-bet.ts --slug aec-cfb-pennst-nw-2026-10-02
  node --experimental-strip-types scripts/check-bet.ts --sport MLB --phase pregame --ask 0.62 --bid 0.61
  ```

- **The forward test.** It uses the engine's paper plan from `favourite-hold`, as described in the next section.
- **Real money** ([`lib/live/`](../lib/live/README.md)) is built and tested against a simulated exchange, but **deliberately not connected**. Connecting the runner to real orders is the owner's decision. The coding agent's safety check stopped that step, and the README lists exactly what it needs.

## Live football: comeback drives and the candidates around them

Specs, mechanisms and controls: [STRATEGY-ARCHITECTURE.md](STRATEGY-ARCHITECTURE.md#7-the-candidates). All of them are shadowed until a study writes a row naming their version.

- **`comeback-drive@1`** (reclassified as speculative): when the team with the ball trails by 3 to 24, is inside the opponent's 30 on 1st to 3rd down, with at least 5 minutes left, buy it and sell when the drive ends (a score, a change of possession, or the end of the half), with a 35% net-loss stop and a 12-minute limit. One entry per drive. It needs the market to underprice an imminent score, which conflicts with the longshot bias and the NFL reaction study, and it pays two fees.
- **`comeback-drive-hold@1`:** the same setups held to the final. A separate claim with its own result.
- **`drive-fade@1`:** the opposite claim on the same moments: when a trailing longshot (≤ 30¢) drives, buy the leader and hold. Proposed alongside the comeback versions, so the scorecard compares them on identical setups.
- **`surprise-fade@1`:** after a surprising score (the scorer was ≤ 35¢ 30 s before the report) and a move of at least 8¢, buy the team scored on 45–180 s later and hold.
- **`quiet-window-maker@1`:** rest orders only in the first 20 s of a dead-ball report, with a calm price and a spread of at most 3¢. It can replace `maker-quote@1` with `config.maker: 'quiet-window-v1'`.
- **Game facts:**
  - They come only from a **fresh, verified** game report: possession, down, distance, field position, score and quarter (`lib/tennis/football-context.ts`). Anything stale or conflicting means no entry. Between-plays reports mark a dead ball.
  - Scores map to YES and NO through the teams' away/home ordering.
  - The provider's clock counts down (verified on live NFL games, Sep 27). The drive rules use it for time left, including in the 4th quarter; during quarter breaks ("End Q1") time left is unknown, so they wait.
- **"Unless holding longer is ideal":** at each drive trade's end the bot asks the engine whether to hold that side to the final instead of selling.
  - It checks the hold result for `comeback-drive-hold` (a row naming `comeback-drive-hold` or `comeback-drive-hold@1`) first, then any other measured live hold for that side.
  - `drive_entry.py` publishes that row as `lead` only when holding was positive in both the discovery and the holdout games **and** beat selling at the drive's end on the same trades, and as `dropped` when it was not positive.
  - It holds only on a measured `lead` or `proven` result, never on an explored idea. Until a study publishes one, the bot sells.
- **Why nothing trades yet:** NFL in-game scalping (dip and momentum entries, and random entries) lost about 10% a trade after fees and spread, and NFL live holds lose as a regime. CFB in-game trading hasn't been studied.
- **Settling it:**
  - On the PC: `python research/studies/drive_entry.py nfl`, `event_reaction.py nfl` and `maker_windows.py nfl` (NFL price history joined to play-by-play, with controls). Once the runner has recorded games with the drive state, run each with `live --league cfb` (or `nfl`).
  - Merge the rows with `scripts/evidence-pack.ts add pack.json research/studies/results/<study>.json <new-version>`, then validate and publish. A `lead` row lets that version paper-trade; a `dropped` row keeps it out.

## Forward test: CFB pregame favourites

This test settles the only taker lead, using games that started after it was found.

- **Rule (fixed):** buy the side the engine plans in paper mode (the favourite) at its ask, from the last quote taken 5 minutes to 3 hours before kickoff, and hold to settlement. The rule matches `research/studies/pregame.py`.
- **Controls:** the underdog, a random side fixed by the market slug, and never trading.
- **Kill rule:** after 300 settled picks, the lead is **passed** only if the 95% confidence interval is above zero. Otherwise it's **dropped**. There's no tuning in between.
- **Pace:** about 60 games a week, so roughly 5 weeks of CFB.
- **Schedule:** the GitHub Actions workflow [`forward-test.yml`](../.github/workflows/forward-test.yml) runs every 15 minutes once this is on `main`. It commits the ledger and `summary.md` to the `forward-test-data` branch.
- **Run it by hand:** `node --experimental-strip-types scripts/forward-test.ts run`. Use `report` to print the summary only.

If it passes, change the row's `status` to `proven` in a pinned pack, citing the ledger. Real money then also needs Step 9 of the [handoff](STRATEGY-LAB-HANDOFF.md): the live order path, kill switches wired to a real account, and the security fixes.
