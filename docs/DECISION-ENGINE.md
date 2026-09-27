# Decision engine

Added September 27, 2026. It turns the strategy lab's research into rules that every bot and person consults before a trade. Code: [`lib/decision/`](../lib/decision). Evidence: [`research/studies/report.md`](../research/studies/report.md).

## The idea in one paragraph (for Chad)

We measured roughly 2,800 games of Polymarket US prices. Most ways of betting lose once you pay the rake (the fee and the spread). The decision engine is the hand chart built from that history. Before any bet, the bot or a person asks the engine, and it answers **GO**, **PAPER ONLY** or **NO**, with the measured expected value and its range. It never guesses. If we haven't measured a situation, the answer is NO.

## How it decides

1. **Is the price real?** A spread wider than 5¢ is a placeholder quote, not a price, so the answer is NO.
2. **Find every study that covers the bet.** The engine matches on sport, pregame or live, style and price band, and on favourite or underdog status.
   - **Styles:**
     - *taker scalp* (buy and sell within minutes)
     - *taker hold* (buy and hold to the final)
     - *maker* (resting orders)
   - **Favourite or underdog:** the midpoint is 50¢ or more, or it isn't.
3. **Losers win ties.** If any matching study says the bet loses, the answer is NO. The most specific study is quoted: a price band beats favourite/underdog, which beats the general result.
4. **Proven means GO.** A result must be positive on held-out history **and** in a forward test. **None qualify yet.**
5. **A lead means PAPER ONLY.** A lead has a positive estimate but its confidence interval still crosses zero. Real money waits for the forward test.
6. **Otherwise NO.** Nothing has been measured, so the engine doesn't trade.

`decide()` also reports the break-even win rate and the market's implied probability. If you pass an outside probability estimate, it reports the gap, as context only. Our models have not beaten the market price.

## What it says today

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

The full table with sources is [`lib/decision/evidence.ts`](../lib/decision/evidence.ts).

## Who asks it

- **The live paper bot.** Accounts with `evidenceGate: 'evidence-v1'` must get a permitted verdict at the entry gate (`entryIssue` in `lib/tennis/engine.ts`) before any entry.
  - This covers new accounts and any account after Start/Resume.
  - The bot's strategies are all live scalps, so today it watches and records `EVIDENCE_*` refusals instead of trading.
  - Historical configurations without the field replay unchanged.
- **The bet checker (for people).** It reads the live book, and the default mode is `real`:

  ```sh
  node --experimental-strip-types scripts/check-bet.ts --slug aec-cfb-pennst-nw-2026-10-02
  node --experimental-strip-types scripts/check-bet.ts --sport MLB --phase pregame --ask 0.62 --bid 0.61
  ```

  Add `--mode paper`, `--style maker`, `--model 0.66` or `--json` as needed.
- **The forward test.** It takes the engine's paper-mode picks, as described in the next section.
- **Resting-order pilots.** `quotePolicy(sport, phase, mode)` decides where to quote, and how long to pull quotes after a play or pitch. That's 30 s for NFL, and CFB assumes the same until it's measured. MLB is 10 s after the official end time.

## Forward test: CFB pregame favourites

This test settles the only taker lead, using games that started after it was found.

- **Rule (fixed):** buy the side the engine permits in paper mode (the favourite) at its ask, from the last quote taken 5 minutes to 3 hours before kickoff, and hold to settlement. The rule matches `research/studies/pregame.py`.
- **Controls:** the underdog, a random side fixed by the market slug, and never trading.
- **Kill rule:** after 300 settled picks, the lead is **passed** only if the 95% confidence interval is above zero. Otherwise it's **dropped**. There's no tuning in between.
- **Pace:** about 60 games a week, so roughly 5 weeks of CFB.
- **Schedule:** the GitHub Actions workflow [`forward-test.yml`](../.github/workflows/forward-test.yml) runs every 15 minutes once this is on `main`. It commits the ledger and `summary.md` to the `forward-test-data` branch.
- **Run it by hand:** `node --experimental-strip-types scripts/forward-test.ts run`. Use `report` to print the summary only.

If it passes, change the row's `status` to `proven` in `evidence.ts`, citing the ledger. Real money then also needs Step 9 of the [handoff](STRATEGY-LAB-HANDOFF.md): the live order path, kill switches and the security fixes.

## Adding or changing a strategy

1. Measure it in `research/studies/`, with controls and a held-out period.
2. Add one row to `EVIDENCE`, with its source file and sample. Never edit a result to change a verdict.
3. If it is a lead, run a forward or paper test before marking it `proven`.
4. Give the bot a strategy for that regime. The engine already gates it. For example, a pregame hold strategy would need the runner to support pregame entries and hold-to-settlement exits (Step 8).
