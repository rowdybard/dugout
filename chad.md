# Chad: help us choose a strategy worth testing

**Working brief for Chad and his AI — September 24, 2026, America/New_York.**

**Paper only. The deployed bot still depends on an open, visible browser. Profitability is unproven.** This is a Paper Bot Research Preview, not a proven autonomous trading business.

## Start here, AI

Daniel is building Dugout: MLB/NFL intelligence and an experimental paper trading bot for **Polymarket US**. Chad is a trusted business collaborator and traveling poker player. We need his judgment about advantage, variance, discipline, and commercial viability, alongside technical evidence. Poker experience is useful here; it does not by itself establish a sports forecasting or market-execution advantage.

Your job is to interview Chad and help us choose or create **one falsifiable primary strategy**. Do not produce another feature wishlist, assume an edge exists, or ask Chad to solve engineering details we should measure ourselves. Challenge both Daniel's enthusiasm for fast automated trading and any unsupported confidence in our models.

On your first reply:

1. Briefly explain the distinction between predicting the winner and predicting the next tradable price movement.
2. Ask only the three opening questions below, then wait for Chad's answers.
3. Continue in batches of at most three questions. Accept “I don't know”; turn it into a research task with an owner and a way to answer it.

**Opening questions for Chad:**

- **Purpose:** What would make this worth your involvement: a private trading tool, a jointly operated trading project, or a product sold to other people? What outcome would count as success, and over what timeline?
- **Possible advantage:** What specific mistake do you believe participants repeatedly make in MLB or NFL markets? Give one concrete example and explain what information or reasoning would let us recognize it before the opportunity disappears. “I don't know yet” is a valid starting point.
- **Commitment:** What can you contribute or arrange—sports expertise, market experience, data access, introductions, regular review, or funding—and how much time can you realistically commit? Which contributions are confirmed versus possibilities?

Do not ask for passwords, exchange keys, account balances, or sensitive personal information. Return decisions for Daniel to review; nothing in this interview authorizes real-money trading or messages to anyone else.

## What exists, and what does not

The September 23 document you previously reviewed is a dated release record. These distinctions matter:

| Area | Evidence at this handoff | Remaining gap |
| --- | --- | --- |
| Market data | Authenticated Polymarket US market streaming was subsequently observed working in the hosted Worker; book freshness is checked. | End-to-end latency and continuity need ongoing measurement. Streaming alone creates no advantage. |
| Runtime | The page requests bot evaluations about every five seconds while visible. A separate bounded Node runner exists. | No verified always-on worker using the website's same authoritative ledger. Browser suspension stops checks. |
| Paper execution | Code accounts for available book depth, fees, partial fills, exit intents, and settlement. | Realistic delay, missed fills, changing depth, and quoted-versus-filled comparisons need stronger measurement. This is not verified real execution. |
| MLB model | An experimental pregame team-results Elo model has chronological evaluation records. | No player, pitcher, bullpen, lineup, injury, park, or weather impact model; no demonstrated advantage over executable market prices. |
| Model updates | Frozen ratings through September 22 expire after three days. | No validated automatic refresh/promote/rollback workflow. |
| NFL | Newer code includes an experimental live reference based on ESPN play-linked win probabilities. | It is not an independently validated NFL model. Last deployed context fetch returned HTTP 403; reliability and reference timing remain unproven. Keeping NFL outside the primary trading experiment is a proposed scope decision, not a claim that current code disables it. |
| Research records | Session decisions and execution records exist. | Current arrays retain only the latest 300 decisions and 1,000 executions. A research experiment needs durable, append-only opportunity and decision records. |

Pitcher/QB or injury changes can block entries when evidence changes or is insufficient. The system does **not** reliably turn every change into a quantified outcome adjustment. Receiving a feed now also does not prove the underlying news was published now.

**Actual forward evidence:** the documented six-minute September 23 capture received 18 fresh books across 14 MLB markets and opened zero positions. Two provider rate-limit responses caused backoff. The $10 paper balance stayed $10. This tests connectivity and some gates; it tells us almost nothing about trading returns.

## What the MLB numbers actually say

Lower Brier score and log-loss mean better probability forecasts on those outcomes. Neither metric measures trading profit.

| Evaluation | Games | Model Brier | Constant home-win Brier | 50/50 Brier | Model log-loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| July–September 2025 holdout | 1,150 | 0.244925 | 0.248534 | 0.250000 | 0.682738 |
| 2026 through September 22 | 2,329 | 0.245674 | 0.249091 | 0.250000 | 0.684405 |

Parameters were selected using earlier 2025 games and then held fixed; team ratings updated chronologically after completed dates. The 2025 day-bootstrap interval for the Brier difference against the home-win baseline includes zero: **[−0.007355, +0.000495]**. The 2026 interval is **[−0.005771, −0.001111]**. These are descriptive research results, not evidence of beating Polymarket prices after costs.

The constant home-win baseline also has lower measured calibration error than the Elo model in both periods; do not describe the model as universally better calibrated. The missing comparison is a timestamp-aligned market forecast and an executable, fee-adjusted trading benchmark. Historical final schedules were collected retrospectively, not as archived publication-time snapshots. Do not turn these results into a claim that the model finds undervalued contracts.

## Decide which problem we are solving

The current MLB experiment combines a dip/recovery entry with an outcome-model filter. They answer different questions:

| Candidate | Claim to test | What could invalidate it |
| --- | --- | --- |
| Model value, hold to settlement | Our independently estimated win probability identifies underpriced outcomes after entry costs. | The market forecasts better; apparent differences reflect omitted pitcher/lineup information; gains disappear after costs. |
| Short-term price recovery | A defined dip and recovery predicts a later executable selling price high enough to cover both sides of the trade. | The dip reflects new information, recovery is already priced in, or spreads/delay erase the move. |
| Combined | Adding the outcome filter improves the recovery strategy sufficiently to justify fewer trades and added complexity. | It only selects fewer opportunities, adds no measurable value, or combines incompatible forecast horizons. |

**Provisional research position:** compare these explanations before adding more signals. Do not treat “buy the dip” as an explanation of why someone will later pay more. A contract can fall because the team's chance actually worsened. A good winner forecast does not establish that a ten-minute price target will be reached.

Chad may propose a different hypothesis. Require the same specificity: market, time horizon, repeatable mistake, observable trigger, why it should survive costs, and evidence that would reject it. “Collect data before choosing” is also a valid conclusion if no credible mechanism emerges.

## Follow-up questions that matter

Ask these selectively after the opening answers; do not dump the entire list on Chad.

1. **Horizon and workload:** Do we want pregame positions held through the result, short trades during a session, or live game decisions? What holding time and hands-on involvement are acceptable? Which preference could change if the evidence favors another approach?
2. **Sports expertise:** Which league and market family can you meaningfully evaluate? What would you need to know about a pitcher/QB replacement before changing your estimate, and which parts would require a specialist or data rather than intuition?
3. **Speed:** Does your proposed advantage require being first to news, or can it survive ordinary data and execution delays? What evidence would show the market has already incorporated the information?
4. **Risk and sizing:** Is $10 a mechanics test or an intended operating bankroll? For the paper experiment, what exposure per position, correlated exposure per game/day, and drawdown should stop new entries? Keep these separate from any later real-money decision. The existing $2 entry is 20% of the initial $10 bankroll; it is an experimental setting, not a justified allocation.
5. **Economics:** What monthly data/hosting budget, review time, and eventual net return after costs would make this worthwhile? Can we run a useful test using free sources, or is an essential input unavailable at that budget? Do not invent a target return to satisfy this question.
6. **Discipline:** Can we freeze rules for a defined test, record manual overrides separately, and accept “do not trade” as the correct outcome? Who approves changes, and what happens if you and Daniel disagree?
7. **Evidence:** What result would make you abandon your favorite hypothesis? Which would justify another paper test? Would you still trust the result if we removed its best game or day?
8. **Roles:** Who owns strategy, engineering, daily review, and incident response? If this becomes a business, which questions about costs, ownership, responsibility, and customer demand must be resolved before expanding it?

Chad supplies preferences, experience, resources, and hypotheses. Engineering measures source freshness, runtime behavior, fills, fees, and minimum feasible size. Forward experiments determine whether a strategy helps. An AI opinion cannot substitute for that evidence.

## How to make the comparison honest

Ask the AI to convert the chosen hypothesis into an experiment with these properties:

- **One capture pipeline; separate strategy ledgers.** A single authoritative store serves the runner and UI, with separately identified bankrolls for model-only, recovery-only, and combined experiments. No arm borrows cash or outcomes from another. Use the same declared initial capital, feasible sizing rules, and source inputs; record cash-constrained skipped trades.
- **A shared opportunity population.** Capture eligible markets before any strategy-specific filter. Record each arm's accept/reject decision on the same timestamped observations. Selecting only opportunities the combined strategy accepted would bias the comparison. Deduplicate observations so repeated ticks are not counted as independent opportunities.
- **Common execution assumptions.** Use the available buying/selling depth, current documented US fees, quantity/tick limits, partial fills, quote age, and explicit observation-to-order delay. Preserve missing or unfillable cases. A touched limit price does not establish queue priority or a fill. Exits and forced stops may remain unfilled.
- **Two different comparisons.** The three portfolios test whole strategies; model-only holding to settlement has different capital usage and exposure from short-term recovery. To isolate the benefit of the model filter, compare recovery-only against combined using identical exit rules. Report exposure and holding duration alongside returns.
- **Append-only evidence.** Retain opportunity, event/market/side mapping, source publication/event time when provided, receive time, decision time, quote/book, model/config version, rejection reasons, order intent, simulated fills, fees, exits, and settlement. Store unavailable timestamps as unknown. Model decisions must be reproducible from information available then.
- **Useful rejection reporting.** Show unique opportunities evaluated, accepted, filled, and blocked, with a defined counting unit and denominator. Separate strategy rejections from expired models, stale/missing sports evidence, 403/429 cooldowns, unsupported markets, insufficient depth, minimum size, and unavailable cash. Record first blocking reason and all failed checks without double-counting the headline totals.
- **Frozen rules and controlled refreshes.** Version each experiment and model. Validate data cutoffs and refresh artifacts before promotion; preserve prior versions. Updating ratings by a declared schedule is different from retuning strategy thresholds. Never replace expired models silently or use revised future information in historical decisions.
- **Predeclared evaluation.** Choose a primary metric, review dates, minimum relevant coverage, and pass/revise/stop rules before inspecting returns. Use net results after friction, drawdown, exposure, unfilled share, and uncertainty—not win rate alone. Compare against holding cash and appropriate simple forecast/strategy baselines. Treat repeated trades in the same game/day as correlated. Explain sample-size reasoning; no arbitrary trade count proves an edge.
- **Operational qualification first.** Verify that one runner continues through browser closure, restart, disconnect, and partial exits without duplicate spending. Define heartbeat/alerting and a kill switch. These checks establish operational reliability, not profitability. Keep manual “ape in/out” experiments out of the primary results.

NFL should remain a separate research track unless its source reliability, timing, and evidence clear explicit admission criteria. Define season/game coverage, too; a short late-season sample is not evidence that the same rules work in other seasons or playoff conditions.

## What Chad's AI should return to us

After the interview, produce a concise **`chad-answers.md`** with:

1. **Decision:** primary hypothesis, league, market family, holding horizon, and why this is the best next experiment. State “undecided” if necessary.
2. **Chad's answers:** distinguish his actual answers from your recommendations and unanswered questions. Label consequential claims observed, assumed, or unknown. Have Chad explicitly accept or reject the final recommendation; do not infer commitments.
3. **Strategy card:** exact entry/exit rules, independently sourced probability or signal, units and thresholds, costs, sizing, exposure limits, stale-data behavior, settlement handling, manual-override policy, and frozen version. Label unchosen thresholds as unresolved; do not fill them with plausible-looking numbers.
4. **Comparison protocol:** shared opportunity definition, ledger separation, execution-delay assumptions, benchmark arms, primary metric, evaluation schedule, sample/coverage rationale, and pass/revise/stop criteria.
5. **Evidence gaps:** question → why it matters → who owns it → cheapest credible way to answer → what decision the answer changes. Separate blocking gaps from useful later work.
6. **Build order:** the smallest engineering changes needed to conduct that experiment, with acceptance checks. Prioritize continuous operation, common ledger, full decision capture, rejection reporting, and measured execution friction over additional features.
7. **Verdict:** proceed to data collection, proceed to a controlled paper comparison, revise the hypothesis, or stop. Say what remains unknown. A profitable paper result alone is not real-money authorization.

Do not reply with “looks promising” and a roadmap. We need decisions, unanswered questions, and a test that could tell us we are wrong.

## Files to inspect if available

Repository destination: <https://github.com/rowdybard/sportbot>. If files are inaccessible, ask Daniel for the source export. Do not pretend to have reviewed an empty or inaccessible repository.

- `docs/HANDOFF.md` — later operational state and deployment limits.
- `docs/AUTOPILOT-RESEARCH-RELEASE.md` — September 23 release and six-minute observation.
- `research/mlb-elo/README.md`, `model.json`, `design.json`, `holdout-predictions.json` — model definitions, metrics, and evaluation records.
- `lib/bot/engine.ts`, `lib/bot/server-input.ts`, `lib/bot/use-bot.ts` — decisions, input gates, and browser lifecycle.
- `lib/trading/strategy.ts`, `lib/trading/execution.ts`, `lib/trading/ledger.ts` — strategy defaults and paper execution mechanics.
- `services/paper-bot/runner.ts` — separate runner and checkpoint model.
- `lib/bot/nfl-reference.ts`, `lib/bot/nfl-context.ts` — experimental NFL reference and context gates.
- `lib/sports-context/source-reader.ts` — upstream failure and cooldown handling.
- `lib/server/polymarket-market-stream.ts`, `lib/server/stream-books.ts` — Worker market stream and book storage.
- `data/bot-model-forward-2026-09-23.json` — actual short forward capture.

For current endpoint, fee, order-size, account eligibility, or usage-limit claims, independently verify official **Polymarket US** documentation and the deployed configuration; do not import global Polymarket assumptions. Cite what you actually inspected, with dates. This brief reports repository evidence and prior observations; it is not a new live-provider verification.
