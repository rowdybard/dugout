# Strategy-lab findings

Plain-English results from `research/studies/`. Numbers are per trade and after Polymarket US taker fees (`0.0695·p·(1−p)` per contract per fill) and the bid/ask spread, unless stated otherwise. Brackets are 95% confidence intervals, resampled by whole game. Raw outputs are in `research/studies/results/*.json`.

## Data quality notes (read first)
- **Placeholder quotes.** Empty books show a 99.9¢ ask and 0.1¢ bid (spread ≈ 100¢), common in thin late-2025 markets. Every study ignores quotes with a spread over 5¢. Exits wait for a real quote, or settle if none appears.
- **Sampling density.** 2025 Polymarket US history is **1-minute sampled**; 2026 history is about **1-second**. Anything about reaction *timing* must use 2026 games only.
- **NFL pre-snap state** is taken from the latest snap, so the model never sees a result before the market could.

## NFL: first results (Sep 27, 2026; 180 games, Oct 2025 – Sep 2026 week 1)

### 1. Astra's strategy (buying in-game dips) loses about 10% per trade
Drops were tested at data resolution (15 s grid, entry one step later at the ask, exit at the bid 1–10 minutes later):

| Signal | 2-min hold, net | 10-min hold, net |
|---|---|---|
| Dip then recovery (Astra-like) | −10.1% [−12.6, −7.4] | −8.9% [−13.7, −4.1] |
| Any dip | −10.3% | −9.5% |
| Momentum (buy rises) | −9.8% | −9.5% |
| **Random entry (control)** | −11.0% | −10.4% |

Dip signals are barely better than random. Every version loses after costs; even before fees, the spread alone makes them −2% to −5%. **Short-hold in-game scalping as a taker is not viable on Polymarket US NFL.** The live paper account ($100 → $93.94, fees 68% of the loss) was consistent with this.

### 2. The market price is well calibrated
- Live checkpoints: logistic slope 1.03 (1.0 = perfect), Brier 0.156.
- With real (executable) quotes, contracts priced 90¢ or more won 96.5%.
- No price band shows a significant hold-to-settlement profit.
- Pregame, the home side may be slightly overpriced (intercept −0.16, n=165), but that is too few games to act on.

### 3. A public-quality win-probability model does not beat the market
- Sampled once per live minute: **market Brier 0.163**, ours 0.170, ours averaged with nflfastR 0.167.
- Buying when the model disagreed with the price by more than fees (2–10¢ thresholds, hold to settlement, about 130–170 trades each) lost −7% to −15% on average. The confidence intervals are wide but centered below zero.
- The market already knows what nflfastR-style models know.

### 4. Reaction to plays: an under-reaction signature, but timing is not yet measured
- The price moves about **half as much as the nflfastR-implied change** by the next snap, and about two-thirds by a minute later.
- After big plays (≥5 win-probability points), the price **keeps drifting the same way**: about 4.6¢ first move, then +1.3 to +1.8¢ more over the next 1–5 minutes. That is continuation, not reversal. It is the opposite of what Astra's dip-buying assumes.
- The apparent 15–30 s lag came from the 1-minute sampling of 2025 data. **Now rerunning on dense 2026 games** to measure the real lag.
- **Why it matters:** if the market really takes 20–60 s to absorb a play, a bot with a play feed faster than that could enter before the move. That is the one edge the data hints at, and it depends on data speed, not on a smarter model. The drift after the first move (about 1.5¢) is below the cost of holding to settlement (about 2.7¢ at 50¢), so trading it late doesn't pay.

## What this means (so far)
1. Stop tuning in-game scalping. The data says it cannot beat taker costs.
2. The plausible edges are:
   - **(a) speed:** a fast play-by-play feed plus an immediate order after big plays; the reaction lag on dense 2026 data decides this
   - **(b) specialised information** the public models lack: pitchers, bullpens and lineups in MLB; injuries and QB changes in the NFL
   - **(c) resting (maker) orders**, which avoid taker fees and earn the spread. This cannot be backtested on price history and needs live recording.
3. MLB (2026 season, dense data) and the pitcher- and bullpen-aware model are next.
