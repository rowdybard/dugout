# Strategy architecture

Added September 27, 2026. This is how Dugout turns a trading idea into something that can be measured, trusted or killed. It covers what the system knows that the market might not, the candidate strategies and the mechanism behind each, and the machinery that measures them without trading them. Code: [`lib/decision/`](../lib/decision). The engine itself: [DECISION-ENGINE.md](DECISION-ENGINE.md). Research results: [`research/studies/report.md`](../research/studies/report.md).

The core question: **what information does Dugout have that the market has not fully priced yet, and can the bot trade it systematically after costs?** The honest answer today is "very little, and nothing proven". This layer exists so that the answer can change on evidence, and so that bad ideas die quickly instead of being tuned until they look good.

## 1. Assessment: what was missing

The flow from raw data to a decision, before this work and now:

| Stage | Before | Now | Still missing |
|---|---|---|---|
| Raw → sports state | Verified football report (possession, down, field, score, quarter), no events | The same, plus an **event tape**: score, possession, period and dead-ball events, each with the price before the market could have known (`events.ts`). A touchdown and its try count as one scoring play. | Play type (the feed does not say punt, interception or field goal) |
| Market state | Best bid/ask, sizes, short history | Full ladders for both sides, pregame price kept, quote age | Trade prints; order-book events between polls; other venues |
| Features | Price, role, spread, depth, time, score, period | Plus freshness, book imbalance, depth within 2¢, 30-s velocity, move since pregame, last scoring play (seconds since, scorer's pre-event price, move against each side, how much moved before our feed), drive number, game phase | Expected points, drive success models, injury and weather signals |
| Hypothesis | A comment in the code | A **machine-readable spec** per `strategy@version` with mechanism, evidence for and against, invalidation and minimum sample (`spec.ts`, `catalog.ts`) | |
| Expected edge | Model point estimate minus price | Lower bound of a calibrated interval minus the break-even after book-walked fill, fee and latency (`edge.ts`) | A model that beats the market (none does yet) |
| Evidence gate | Rows named strategies without versions; untested ideas could only be explored with paper money | Rows can name one version (`id@version`); untested ideas are **shadowed**, not traded; exploring is opt-in | |
| Sizing, risk, execution | ¼ Kelly on the lower bound, loss caps, delayed paper fills | Unchanged | Real fills, queue position, liquidity rewards |
| Exit | One hard-coded exit per strategy | Primary exit plus pre-registered alternatives, measured side by side | |
| Outcome → evidence | Closed paper trades, no counterfactuals, no scorecard | Every executed and every shadowed entry carries **counterfactual legs and exits** (`shadow.ts`); a **scorecard** per version and sample (`scorecard.ts`) | |
| "Why no trade?" | A free-text summary | A fixed vocabulary, one primary reason per book, counts per session, on the dashboard (`why.ts`) | |
| Discovery over time | Tuning constants by hand | A lifecycle with a lock: a changed rule is a new version with its own evidence (`prereg.lock.json`) | |

The gap was not a missing strategy. It was that nothing forced an idea to state why it should make money, nothing measured ideas without spending the forward test on them, and nothing stopped thresholds from drifting after results were seen.

## 2. Thesis: where an edge could come from

Evidence levels (as in `spec.ts`): **documented** (a published empirical finding in comparable markets, or Dugout's own measurement), **plausible** (a mechanism with indirect or single-study support), **speculative** (neither).

What Dugout has measured (`report.md`):
- **Takers with public information lose in NFL and MLB on every axis tested.** Scalping loses about 10% per trade, as random entries do. Live prices are calibrated (NFL slope 1.03). The market beats nflfastR-style and LightGBM models. 88% of a big NFL play's move is priced 30 s after the snap, with only 0.4–0.8¢ of follow-through.
- **Longshots lose.** NFL live sides under 10¢ lost 72% held to the final; MLB live under 10¢ lost 48%; CFB pregame underdogs lost 33%.
- **Resting orders earn small positive markouts only where flow is uninformed**: CFB live and pregame and MLB pregame under optimistic fills; NFL live is toxic (−0.40¢).

What the literature says:

| Finding | Source | Level | For Dugout |
|---|---|---|---|
| Favourite-longshot bias from misperceived small probabilities | Snowberg & Wolfers 2010, *JPE* | documented | Supports fading longshots in general |
| The bias grows with time to expiry; markets are well calibrated near expiry | Page & Clemen 2013, *Economic Journal* | documented | **Weakens** any live (near-expiry) longshot fade |
| Kalshi: low-price contracts win far less than break-even; takers lose ~32%, makers ~10% | Bürgi, Deng & Whelan 2025 (SSRN 5502658) | documented | Supports resting orders over taking, and fading longshots |
| Polymarket: the two-sided bias is "surprisingly absent in Sports" | Cardozo & Rivero-Wildemauwe (arXiv 2609.12878) | documented | **Against** fading longshots in sports on Polymarket |
| In-play soccer: underreaction to expected goals, overreaction to surprising ones; 2.79% betting 2 minutes after | Choi & Hui 2014, *JEBO* | plausible (one market, one paper) | The mechanism behind `surprise-fade@1` |
| Goal news is priced "swiftly and fully" | Croxson & Reade 2014, *Economic Journal* | documented | **Against** `surprise-fade@1` |
| Live betting stakes "might overreact to recent news" | Ötting, Michels, Langrock & Deutscher (arXiv 2108.00821) | plausible (volume, not prices) | Weak support for `surprise-fade@1` |
| Momentum in betting lines, reversed by the outcome, too small to beat costs | Moskowitz 2021, *Journal of Finance* | documented | Anomalies exist and are usually smaller than costs; expect the same here |
| Spreads compensate informed flow; spreads widen and depth falls before information events | Glosten & Milgrom 1985, *JFE*; Lee, Mucklow & Ready 1993, *RFS* | documented | The mechanism behind `quiet-window-maker@1` |

Where an edge could come from, in order of credibility:
1. **Liquidity provision timed to when information is absent.** Makers earn the spread and the rebate; they lose to informed flow, which in football arrives with each snap. Quoting only while the ball is dead is a direct test. Liquidity rewards come on top and are not modelled.
2. **Behavioural pricing around salient events.** Surprising scores and longshot drives are the moments when a crowd is most likely to misprice. The published evidence is mixed, and Dugout's own NFL reaction study leans against it, so these are tests, not beliefs.
3. **Thin markets.** College football is less efficient than NFL (the CFB underdog result), so most candidates are measured on CFB separately.

What Dugout does **not** have: faster data (free feeds arrive after the move), a better model, or cross-venue prices. Strategies that need those are specified but cannot pass until the data exists.

## 3. Lifecycle

```
idea → specified → historical-test → holdout → forward-paper → promoted
                                          ↘ rejected       ↘ rejected
                     any stage → superseded (by a new version)
```

- **specified:** the spec is written and locked. The bot measures it in **shadow** (every candidate entry is recorded with counterfactuals; nothing is traded).
- **historical-test / holdout:** a pre-registered study runs on the PC. Games are split by start time into discovery and holdout halves before either is looked at (`research/studies/lifecycle.py`).
- **Verdict:** `lead` only when both halves are positive after costs with the spec's minimum sample; `dropped` when either half is not; no row with too few trades. The row names the exact version.
- **forward-paper:** a `lead` row lets the engine paper-trade that version. The scorecard compares forward results with the study.
- **promoted:** only a forward paper result that agrees, in a pack whose SHA-256 the owner pins, can make a row `proven`. Real money additionally needs the live order path the owner has not connected.
- **rejected / superseded:** retired versions never propose. A new version starts at `specified` and inherits no evidence.

## 4. Specs and pre-registration

Each strategy version is a spec (`lib/decision/spec.ts`, validated with zod) in `lib/decision/catalog.ts`:
- **Identity:** id, version, title, family, sports, phases.
- **The claim:** hypothesis, economic mechanism, edge source (winner identification, temporary mispricing, liquidity provision, speed), basis (kind, support and evidence against, with citations).
- **The rule:** required features, entry rule and its parameters, primary exit, alternative exits, style, maximum spread, assumed latency, expected hold, sizing.
- **The kill:** invalidation conditions and the minimum sample (trades and games).
- **Status:** research and forward status, study path, result, what it supersedes.

Strategy code reads its thresholds from the spec (`paramsOf`), so the code cannot drift from what was registered. `lib/decision/prereg.lock.json` stores a SHA-256 of each version's registered rules (sports, phases, features, parameters, exits, style, spread, latency, sizing).

```sh
node --experimental-strip-types scripts/strategy-specs.ts check   # fails if any registered rule changed
node --experimental-strip-types scripts/strategy-specs.ts lock    # records NEW versions only; never rewrites
```

A test runs `check`, so changing a locked version's rule fails CI. The fix is always a new version. Text fields (mechanism, citations, status) can be corrected without a new version, because they do not change what is traded.

## 5. Expected edge after costs

`lib/decision/edge.ts` defines the only edge the engine accepts for a hold to settlement:

```
fill      = average price walking the ask ladder for the stake
breakEven = fill + taker fee (0.0695·p·(1−p) per contract) + latency allowance
edge      = p̂ − breakEven            lowerEdge = p̂_lo − breakEven
tradable  = lowerEdge > minLowerEdge
```

- `p̂` and its interval come from a model in the pack. `calibration-v1` models give an empirical rate with a 95% interval per price bin inside a game state; logistic and table models give an interval only if they declare their uncertainty. The market-implied baseline gives no estimate, so nothing trades on it.
- `roundTripHurdle` is the same for in-and-out trades: two fees, the spread and slippage. At 50¢ the two fees alone are about 3.5¢.
- `model-edge-hold@2` uses this; `@1` (a fixed 3¢ margin on a point estimate) is superseded.

## 6. Events and features

The feed reports states. `lib/decision/events.ts` turns successive verified football states into events with two prices: the midpoint on the last book at least 30 s before the provider's report (`preYesMid`), and the midpoint just before the report reached Dugout (`atReportYesMid`). The gap between them is how much the market moved before our feed; in NFL, most of it. Score corrections are not events. Same-side scores within 150 s are one scoring play (`latestScore`), so a touchdown's try does not restart the clock.

The bot keeps the last 24 events per market and the pregame price (`lib/tennis/research-tracking.ts`), and only for accounts on the evidence gate.

## 7. The candidates

Three candidates are built to test a mechanism, not a threshold. Each has a control that would reveal a mechanism that is not what it claims.

| Version | Claim | Mechanism | Data it uses | Basis | Study and control | Killed if |
|---|---|---|---|---|---|---|
| **`surprise-fade@1`** | After a surprising score (scorer ≤ 35¢ before it) with a move of 8¢+, the team scored on is too cheap 45–180 s later | Overreaction to surprise (Choi & Hui 2014) | Score events, pre-event price, current book | plausible; against: Croxson & Reade 2014, Dugout's NFL follow-through | `event_reaction.py`; controls: follow the scorer, the same fade after **expected** scores, random | Held-out return not positive after 80 trades, or no better than the expected-score fade |
| **`drive-fade@1`** | When a trailing longshot (≤ 30¢) drives inside the 30, the leader is too cheap | Favourite-longshot bias at its most salient moment | Possession, field, down, score, book | plausible; against: Page & Clemen (bias small near expiry), arXiv 2609.12878 (absent in Polymarket sports) | `drive_entry.py` `fade`; control `leader-any`: leaders at random moments outside drives | Held-out return not positive after 60 trades; `leader-any` as good (the drive adds nothing) |
| **`quiet-window-maker@1`** | Resting orders placed only in the first 20 s of a dead ball, with a calm price and a spread ≤ 3¢, avoid informed flow | Adverse selection is concentrated at snaps (Glosten & Milgrom; Lee, Mucklow & Ready) | Dead-ball reports, 30-s velocity, book | plausible; against: fills may be rare; feed latency | `maker_windows.py`, paired by game against `maker-quote@1` and always-on quoting | 60-s markout not positive in both halves, or no better than `maker-quote@1` under conservative fills |

Reclassified and kept for measurement:
- **`comeback-drive@1`** (buy the trailing team in scoring position, sell at the drive's end): **speculative**. It needs the market to underprice an imminent score, which conflicts with the longshot bias and with the NFL reaction study, and it pays two fees. It is `drive-fade@1`'s opposite claim on the same setups, so one of them should lose.
- **`comeback-drive-hold@1`** (same setup, hold to the final): a separate calibration claim, measured on its own.
- **`model-edge-hold@2`**: waits for a calibrated model with intervals. None beats the market today.
- **`favourite-hold@1`** (CFB pregame favourites) and **`maker-quote@1`**: the existing leads, in forward paper tests.
- **`random-side-control@1`**: the control.

The drive candidates are proposed together on the same setups, so the shadow scorecard compares them directly.

## 8. Shadow measurement and counterfactuals

`lib/decision/shadow.ts` and `lib/tennis/research-tracking.ts`.

- **What is shadowed:** every proposal from a version at `specified` through `holdout` that the gate refuses for lack of evidence (untested, a blanket loser, paper-only, no stake). It is recorded at the book the bot saw and **never traded**. Executed paper trades get the same record.
- **Legs** (taker entries): `base` at the signal's ask; `delay-15s` and `delay-30s` at the first book after the delay (latency sensitivity); `opposite` (the other side, same moment); `maker` (a resting bid at the signal's bid for 60 s, filled only when the price trades through).
- **Exits per leg:** the spec's primary and alternatives, plus a standard set: hold, targets +5/+10/+20%, stops −10/−20%, time 2/5/12 min, a 10% trailing stop, and in football drive-end and possession-change. Price exits are capped at 30 minutes so in-game counterfactuals finish in the game.
- **Maker candidates:** fill conservatively, mark out at 60 s, plus the rebate `0.0125·p·(1−p)`.
- **Bookkeeping:** at most 30 open shadows; once only the final is pending, a shadow is compacted and settled later, so long holds are not dropped (a survivorship bias). Up to 120 finished results are kept per session.
- **The rule:** exit comparisons are hypothesis data for a **future** version. They never change the running version.

## 9. Scorecard

`lib/decision/scorecard.ts`, on the dashboard (Engine → Scorecard) and in the terminal:

```sh
node --experimental-strip-types scripts/scorecard.ts history.json [research/studies/results/*.json]
```

- One row per `strategy@version` and sample: `discovery`, `holdout` (studies), `forward-paper` (executed), `forward-shadow` (measured, never traded).
- Columns: trades, games, mean and median return per dollar after fees and the spread, a 95% interval from a bootstrap that resamples whole games (seeded, deterministic), total P&L, maximum drawdown, win rate, average spread, slippage, hold, maximum adverse and favourable excursion, and breakdowns by price bucket, liquidity and game state.
- Verdicts: **edge** (the whole interval above zero), **no edge** (the whole interval below zero), **inconclusive**, **too few trades** (under the spec's minimum).
- The exit comparison lists each policy's mean return on the same entries.

## 10. Why no trade?

`lib/decision/why.ts`. Every book the bot evaluates gets one primary reason from a fixed list, in priority order: bot not running, game closed, stale book, stale game state, wrong phase, risk limit, position already open, spread too wide, book too thin, evidence says it loses, edge too small, no probability estimate, not enough evidence, market already moved, duplicate setup, waiting for a condition, no setup. Strategies attach notes when they decline, so "no setup" is specific ("Expected score: the scorer was priced 62¢ before it"). The dashboard shows the current reason and the session's top counts; the history export carries them.

## 11. Safety (unchanged)

- Proposing and permitting stay separate; strategies cannot bypass the gate.
- Losers win ties; unknown never permits; blanket averages give way only to a row measured for that strategy.
- Shadowing and exploring are paper-only. Exploring is opt-in (`config.explore`), and the default for untested ideas is shadow.
- Real money needs a `proven` row in an owner-pinned pack, and the live order path is not connected.
- No language-model judgement places or sizes trades.
- Research bookkeeping runs only for evidence-gate accounts, so legacy replays are unchanged.

## 12. Feature and data gaps

| Gap | Blocks | How to close it |
|---|---|---|
| Play type (score kind, turnover, punt) | Separating touchdowns from field goals in `surprise-fade`; better dead-ball windows | A feed with play descriptions (ESPN's free play-by-play) joined by time |
| Feed latency per play | Knowing how late the bot's events are | `research/market-history/live_lag_probe.py` on live games |
| Trade prints and queue position | Real maker fill rates | A small real-money pilot (owner's decision) |
| Liquidity rewards | Maker economics | Reward-program data per market |
| Cross-venue prices (sportsbooks, Kalshi) | Cross-venue and stale-quote strategies | A licensed odds feed; not free |
| Within-Polymarket consistency (moneyline vs spread vs total) | Arbitrage-style consistency checks | Record the related markets for the same game |
| Calibrated live models with intervals | `model-edge-hold@2` | Fit `calibration-v1` tables from `calibration.py` output; they must beat the market on held-out games |
| CFB play-by-play history | CFB history studies (only live recordings exist) | The runner's recordings accumulate; `live` sources in each study |

## 13. How an idea becomes a strategy

1. Write the spec in `catalog.ts`: hypothesis, mechanism, evidence for and against, entry, exits, invalidation, minimum sample. Status `specified`.
2. Implement `propose()` reading the spec's params; add notes for each reason it declines. Add tests.
3. Run `strategy-specs.ts lock`, then commit. The bot now shadows it.
4. Write the study with a control that would expose a different mechanism. Run it on the PC. It writes a row naming the version, or nothing.
5. Add the row to a pack (`scripts/evidence-pack.ts add`), validate, publish. A `lead` paper-trades it.
6. Watch the scorecard. If forward paper agrees after the minimum sample, promote in a pinned pack. If not, drop the row and retire the version.
7. To change a rule, write a new version. The old one keeps its evidence; the new one starts at step 3.

## 14. What to test next

In order:
1. **Verified live on Sep 27:** the football clock counts down; scores read away–home in NFL and MLB; MLB live state (inning, half, count, outs, runners) matches the official MLB Stats API on all 14 games in progress. `lib/decision/sports/baseball.ts` exposes it as features (base-out state and so on). No MLB strategy is registered: the MLB studies found the market ahead of the model and the free feed.
2. **On the PC, NFL history** (no new data needed):
   ```sh
   python research/studies/event_reaction.py nfl      # surprise-fade@1 against expected-fade, follow and random
   python research/studies/drive_entry.py nfl         # comeback-drive@1, comeback-drive-hold@1, drive-fade@1, leader-any
   python research/studies/maker_windows.py nfl       # quiet-window-maker@1 against maker-quote@1 and always-on
   ```
   Each prints discovery and holdout results and writes at most one row per version. Read the controls before the headline: a fade that matches its control is not the claimed mechanism.
3. **On the PC, CFB live** once the runner has recorded a few weekends (`live --league cfb` for each study). CFB is where the markets are thinnest.
4. **Forward shadow:** leave the paper bot on the evidence gate during games. The scorecard's `forward-shadow` rows fill in without risking the forward test.
5. **Merge rows** with `scripts/evidence-pack.ts add`, validate and publish. Only then does anything paper-trade.
