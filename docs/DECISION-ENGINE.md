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
| A new way to trade | a **strategy** (`strategies.ts`) | propose-only; the gate, sizing and risk apply automatically |
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

"Favourites" here isn't the insight. Favourites win about as often as their price says everywhere except college, where **underdogs are overpriced** (people overpay for longshots). Even that lead isn't proven yet, and the forward test below will settle it.

## Who asks it

- **The live paper bot.** Accounts with `evidenceGate: 'evidence-v1'` must get a permitted verdict at the entry gate (`entryIssue` in `lib/tennis/engine.ts`) before any entry.
  - This covers new accounts and any account after Start/Resume.
  - The bot's strategies are all live scalps, so today it records `EVIDENCE_*` refusals instead of trading.
  - The bot uses the compiled-in pack, so its replays stay exact.
- **The bet checker (for people).** The default mode is `real`. With `--slug` it reads the live book, gives a verdict per side, and prints the full engine plan: every strategy's proposal and why it was taken or refused.

  ```sh
  node --experimental-strip-types scripts/check-bet.ts --slug aec-cfb-pennst-nw-2026-10-02
  node --experimental-strip-types scripts/check-bet.ts --sport MLB --phase pregame --ask 0.62 --bid 0.61
  ```

- **The forward test.** It uses the engine's paper plan from `favourite-hold`, as described in the next section.
- **Any future host** (the runner in Step 8, a dashboard card, a real-money executor) calls `engine.plan(context, {mode, risk})` and executes `plan.actions`.

## Forward test: CFB pregame favourites

This test settles the only taker lead, using games that started after it was found.

- **Rule (fixed):** buy the side the engine plans in paper mode (the favourite) at its ask, from the last quote taken 5 minutes to 3 hours before kickoff, and hold to settlement. The rule matches `research/studies/pregame.py`.
- **Controls:** the underdog, a random side fixed by the market slug, and never trading.
- **Kill rule:** after 300 settled picks, the lead is **passed** only if the 95% confidence interval is above zero. Otherwise it's **dropped**. There's no tuning in between.
- **Pace:** about 60 games a week, so roughly 5 weeks of CFB.
- **Schedule:** the GitHub Actions workflow [`forward-test.yml`](../.github/workflows/forward-test.yml) runs every 15 minutes once this is on `main`. It commits the ledger and `summary.md` to the `forward-test-data` branch.
- **Run it by hand:** `node --experimental-strip-types scripts/forward-test.ts run`. Use `report` to print the summary only.

If it passes, change the row's `status` to `proven` in a pinned pack, citing the ledger. Real money then also needs Step 9 of the [handoff](STRATEGY-LAB-HANDOFF.md): the live order path, kill switches wired to a real account, and the security fixes.
