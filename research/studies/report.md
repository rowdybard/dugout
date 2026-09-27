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

## Pregame, all sports (`pregame.py`, `cross_venue_nfl.py`)
Buying at the last executable quote at least 5 minutes before start and holding to settlement, taker fee included:
- **MLB (2,021 games): efficient.** Favourite, underdog, home and away all lose about 3.5–4%, which is the cost of fees and spread. Mid-priced favourites (55–70¢) look slightly overpriced: −7.9% [−12.2, −3.1]. Pregame calibration slope is 0.87, meaning prices are slightly overconfident.
- **NFL (231 games): Polymarket's close equals the sportsbook close.** The home-side gap versus the de-vigged nflverse closing moneyline is +0.2¢ [−0.5, +0.7]. Home teams lost money in both periods (−12.5%, −21%), but sportsbooks priced them the same way, and 2025–26 home teams simply underperformed (48% wins versus 55% priced). Treat it as season noise, **not a Polymarket edge**.
- **College football (632 games): strong favourite-longshot bias.** Underdogs lose −33% [−50, −13] in 2026 (sides priced under 15¢ lose 47%). Buying favourites is **+2.5% [−1.4, +6.6]** after fees (bands: 70–85¢ +3.1%, 85–100¢ +1.3%). This is the most promising lead so far, but not yet significant. About 60 new games a week will settle it.

## MLB in-game scalping (1,973 games, about 1M simulated trades)
Same result as the NFL:
- **Dip then recovery (Astra-like), 2-minute hold: −10.2% [−10.8, −9.5]** (n=7,591). Any dip: −11.4%.
- Momentum (buying rises) is the least bad: −7.1% at 2 min and −5.7% at 10 min. Before fees it is only −0.7% at 10 min, so MLB prices slightly *under*-react. Still negative after costs.
- Random control: −9.7%.

## Maker (resting orders) markout, before liquidity rewards (`maker_markout.py`)
Resting at the best price with the maker rebate (0.0125·p·(1−p)); markout in cents per contract, 60 s after the fill. Two fill models bracket reality: *optimistic* (we're filled whenever our price level is consumed) and *conservative* (filled only when the price moves through us).

| Market (dense games) | Optimistic | Conservative | Fills per game |
|---|---|---|---|
| MLB live (1,043) | −0.22¢ [−0.24, −0.21] | −1.11¢ | 215–336 |
| MLB pregame | +0.12¢ [+0.09, +0.15] | −0.00¢ | 4–6 |
| NFL live (72) | −0.40¢ [−0.47, −0.33] | −1.13¢ | 226–314 |
| NFL pregame | −0.14¢ | −0.17¢ | 3–4 |
| CFB live (383) | **+0.14¢ [+0.08, +0.19]** | −1.25¢ | 192–413 |
| CFB pregame | **+0.48¢ [+0.25, +0.68]** | −0.38¢ | 5–25 |

- NFL live order flow is the most toxic: informed takers hit resting orders just before moves.
- MLB live is mildly negative.
- College football is the only market that is positive under the optimistic fill model, both live and pregame. Pregame is the most benign everywhere.
- Real fills fall between the two models, so the net result is decided by queue position, how fast quotes are pulled after events, and reward share. **Only a small live test can measure those.**
- Polymarket US also pays **liquidity rewards** on top of this, per program, for resting size near the best price (docs.polymarket.us/incentives/liquidity; polymarket.us/rewards): NFL moneyline live $11,000, CFB $1,050–4,500, MLB live $600–1,000. Rewards are sampled every second, so they can outweigh small negative markouts, but our share depends on how much competing size is resting.

## MLB: model vs market, and reaction speed
- **Model:** the MLB win-probability model v1 (LightGBM, trained 2021–24, validated 2025, tested 2026; `research/models/mlb/`) scores Brier 0.159 on 2026. Team strength, starters, fatigue and batter layers add ~nothing over game state alone (0.1591 vs 0.1590).
- **Model vs market at the same moments** (147k plate-appearance starts, 1,973 games): **market 0.1560**, model 0.1576, the average of both 0.1560. The market is at least as good as the model.
- **Trading disagreements** (first signal per game, hold to settlement): −3.8% to +0.8% by threshold, every confidence interval spanning zero. No edge.
- **Speed** (1,190 densely priced games, 90k plate appearances). T is the official MLB Stats API end time of each plate appearance:
  - On big plate appearances (≥5 points of win probability), the market has made **50% of its move by T**, **82% by T+5 s** and **92% by T+10 s**.
  - It also moves in the right direction 10–30 s *before* T. Home runs are fully priced before T, because the scorer logs the play after the trot.
  - The free Stats API is published after T, so **a bot using free MLB data always arrives after the move.** No speed edge without a faster private feed.

## MLB live (1,973 games, 2026 to Aug 25)
- Live prices are well calibrated (slope 1.04, Brier 0.151).
- Longshots are overpriced: sides under 10¢ lose 48%, and 10–20¢ lose 13%.
- 90¢+ favourites break even after fees (+0.1%).
- No price band is profitable to hold.

## What this means (so far)
0. **Bottom line (Sep 27):** taking the posted price with public information loses on NFL and MLB on every axis tested: scalping, calibration, model disagreement, speed, pregame and cross-venue. The credible path is **market making**: rebates plus liquidity rewards, focused on college football and pregame windows. It must be proven with a small real-money pilot, because queue position and reward share can't be simulated.
1. **NFL as a taker is efficient on every axis tested:** scalping, calibration, model disagreement and speed. There is no retail edge from public data.
2. Stop tuning in-game scalping. The data says it cannot beat taker costs.
3. Remaining candidate edges:
   - **(a) MLB:** the 2026 season, about 2,000 densely priced games. MLB has an exact per-pitch operator timestamp and a free official live feed, so the speed test is sharper there, and pitcher, bullpen and lineup information is richer.
   - **(b) resting (maker) orders:** avoid taker fees and earn the spread instead of paying it. This cannot be backtested on price history and needs live order-book recording.
   - **(c) pregame mispricing:** a small sample hints at home overpricing. Needs the full catalog, all sports.
