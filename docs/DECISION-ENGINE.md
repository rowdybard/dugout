# Decision engine

Added September 27, 2026. It turns the strategy lab's research into rules that every bot and person consults before a trade, with plugs where future research slots in. Code: [`lib/decision/`](../lib/decision). Evidence: [`research/studies/report.md`](../research/studies/report.md). Data and pack streaming: [DATA-PLATFORM.md](DATA-PLATFORM.md).

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
- **Exploring (paper only):** a strategy with a written, pre-registered `hypothesis` may trade on paper where no study covers it yet, or where only a blanket average for other rules exists. The verdict is `EXPLORE_PAPER`.
  - It is never pilot or real money.
  - It ranks below any measured result.
  - It stops as soon as a pack carries a row naming the strategy; that result then decides.
  - Accounts opt in with `config.explore`.
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
| `features.ts` | Named features: price, role, spread, depth, minutes to start, score difference, period, volatility, price changes, time of day, and `signal.*` / `game.*` pass-throughs |
| `evidence.ts` | The compiled-in evidence rows and the condition language |
| `pack.ts` | Evidence-pack schema and validation, the bundled pack, and the untrusted-pack restriction |
| `models.ts` | Win-probability models as JSON (`logistic-v1`, `table-v1`) and the market-implied baseline |
| `strategies.ts` | Built-in strategies: `favourite-hold`, `model-edge-hold`, `maker-quote`, plus the `random-side-control` control |
| `sports/` | Sport modules: features and strategies for one sport, plugged into the same engine. `football.ts` holds the live football features and `comeback-drive`. |
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
| A trained model | a **model spec** in the pack's `models` | `{"kind":"logistic-v1","id":"mlb-wp","sports":["MLB"],"phases":["live"],"intercept":…,"weights":{"scoreDiff":…}}`. `model-edge-hold` proposes when it beats break-even, and evidence still decides. |
| A new way to trade | a **strategy** (`strategies.ts`, or a sport module in `sports/`) | propose-only; the gate, sizing and risk apply automatically. With a `hypothesis` it can be explored on paper before it is measured. |
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
| **Comeback drives, NFL and CFB live** | **PAPER TEST** (exploring) | not measured yet; `research/studies/drive_entry.py` measures it on the PC |

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

## Live football: comeback drives

This is the owner's idea: when a team is down 0-17 but about to score, buy it, hold for the drive, then take the profit or the loss.

- **Rule** (`comeback-drive`, fixed before any test; `COMEBACK_DRIVE` in `lib/decision/sports/football.ts`):
  - **Entry:** the team with the ball trails by 3 to 24, is inside the opponent's 30, and is on 1st to 3rd down, with at least 5 minutes left.
  - **Exit:** sell when the drive ends: a score, a change of possession, or the end of the half.
  - **Backstops:** a 35% net-loss stop and a 12-minute limit.
  - **Other rules:** one entry per drive. If the game feed goes silent for 2 minutes, sell rather than hold blind.
- **Game facts:**
  - They come only from a **fresh, verified** game report: possession, down, distance, field position, score and quarter (`lib/tennis/football-context.ts`). Anything stale, between plays or conflicting means no entry.
  - Scores map to YES and NO through the teams' away/home ordering.
  - The game clock's direction is being verified on a live game. Until then the rule counts whole quarters left, so it doesn't enter in the 4th quarter.
- **"Unless holding longer is ideal":** at each drive's end the bot asks the engine whether to hold that side to the final instead of selling.
  - It checks the drive study's own hold result first (`comeback-drive-hold`), then any other measured live hold.
  - `drive_entry.py` publishes that row as `lead` only when holding the same entries made money **and** beat selling at the drive's end, and as `dropped` when holding lost money.
  - It holds only on a measured `lead` or `proven` result, never on an explored idea. A hold result for this rule replaces the blanket "NFL live holds lose" average.
  - Each setup is also proposed as a hold-to-final entry (`comeback-drive-hold`). So if the study finds that holding wins and selling at the drive's end doesn't, the bot enters to hold. If both win, it takes the better one. The hold version is never explored on paper; it needs its own result.
  - Until the study runs, nothing is published, so the bot sells.
- **Why paper only:** NFL in-game scalping (dip and momentum entries, and random entries) lost about 10% a trade after fees and spread. That's the bar this rule has to clear. CFB in-game trading hasn't been studied.
- **Settling it:**
  - Run `python research/studies/drive_entry.py nfl` on the PC. It uses NFL price history joined to play-by-play, with random and opposite-side controls and a hold-to-final comparison. It writes an evidence row, `dropped` or `lead`.
  - Once the runner has recorded games with the drive state, run `drive_entry.py live --league cfb` (or `nfl`).
  - Merge the rows (the drive trade and, when there is one, the hold) with `scripts/evidence-pack.ts add pack.json research/studies/results/drive-entry-nfl.json <new-version>`, then validate and publish. The rows' own results then replace exploring.

## Forward test: CFB pregame favourites

This test settles the only taker lead, using games that started after it was found.

- **Rule (fixed):** buy the side the engine plans in paper mode (the favourite) at its ask, from the last quote taken 5 minutes to 3 hours before kickoff, and hold to settlement. The rule matches `research/studies/pregame.py`.
- **Controls:** the underdog, a random side fixed by the market slug, and never trading.
- **Kill rule:** after 300 settled picks, the lead is **passed** only if the 95% confidence interval is above zero. Otherwise it's **dropped**. There's no tuning in between.
- **Pace:** about 60 games a week, so roughly 5 weeks of CFB.
- **Schedule:** the GitHub Actions workflow [`forward-test.yml`](../.github/workflows/forward-test.yml) runs every 15 minutes once this is on `main`. It commits the ledger and `summary.md` to the `forward-test-data` branch.
- **Run it by hand:** `node --experimental-strip-types scripts/forward-test.ts run`. Use `report` to print the summary only.

If it passes, change the row's `status` to `proven` in a pinned pack, citing the ledger. Real money then also needs Step 9 of the [handoff](STRATEGY-LAB-HANDOFF.md): the live order path, kill switches wired to a real account, and the security fixes.
