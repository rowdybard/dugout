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

### 4. Reaction to plays: the NFL market is fast and complete
Measured on the 32 densely sampled 2026 regular-season games (5,317 plays, 518 big plays of ≥5 win-probability points):
- **Speed:** by **15 s after the snap** the market has made a median **75%** of its eventual move on big plays; by 30 s, **88%**. Plays last 5–8 s, so prices adjust within about 10 s of the play ending.
- **Almost no continuation:** after a 6.6¢ first move there is only 0.4–0.8¢ more over the next 1–5 minutes. An earlier "1.5¢ continuation" was an artifact of the 1-minute 2025 sampling.
- The market moves about 0.6–0.7× nflfastR's per-play change. Since the market is also more accurate (section 3), this is the model overreacting, not the market underreacting.
- **Conclusion:** trading on public NFL play information is too slow. Winning on speed would need a feed reaching us within a few seconds of the play *and* faster order entry than professional market makers. A live test on Sep 27 records how late ESPN's free feed publishes each play (`research/market-history/live_lag_probe.py`).

## What this means (so far)
1. **NFL as a taker is efficient on every axis tested:** scalping, calibration, model disagreement and speed. There is no retail edge from public data.
2. Stop tuning in-game scalping. The data says it cannot beat taker costs.
3. Remaining candidate edges:
   - **(a) MLB:** the 2026 season, about 2,000 densely priced games. MLB has an exact per-pitch operator timestamp and a free official live feed, so the speed test is sharper there, and pitcher, bullpen and lineup information is richer.
   - **(b) resting (maker) orders:** avoid taker fees and earn the spread instead of paying it. This cannot be backtested on price history and needs live order-book recording.
   - **(c) pregame mispricing:** a small sample hints at home overpricing. Needs the full catalog, all sports.
