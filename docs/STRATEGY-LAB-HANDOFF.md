# Strategy lab handoff

Started September 27, 2026. **Read this first** if you are picking the project up cold (a new Claude session, Astra, or a human engineer). It records the goal, what the audit found, the decisions already made, the verified data sources, and a live checklist. Update the checklist and the "Last updated" line whenever a step changes status.

Last updated: 2026-09-27 (evening). Steps 1–2 are done. Step 3 (data lake) is in progress. The NFL win-probability model v1 is trained. Study scripts are written in `research/studies/`.

---

## 1. Goal and scope

**The product goal is real money.** The owner funds the bot, presses Go, and it makes *meaningfully profitable* trades on **Polymarket US** game-winner markets for **NFL, MLB, college football and tennis**. Paper trading is a gate on the way there, not the product.

**The target architecture is a dynamic decision engine.** It reads game context (sport, phase, score, leverage, volatility, spread) and chooses among several strategies. Only strategies that have each shown a positive, fee-adjusted edge on **held-out** historical data may be enabled, and only in the regimes where they proved it.

**People:**
- **Owner:** GitHub `rowdybard`.
- **Chad:** the owner's friend and business partner, a traveling poker player and businessman who loves sports. See [`chad.md`](../chad.md). Explain results to him in expected-value terms: fees and spread are the rake, and the backtest is the hand history. The repo is **public on purpose** so Chad's AI can read it.

**Priority order:** MLB and NFL first (deep play-by-play analysis), then CFB (needs a free API key), then tennis.

---

## 2. What the audit found (Sep 27, 2026)

**Verdict:** the infrastructure is solid, but there is no proven strategy and no real-money path.

### Assets worth keeping
- **Dashboard:** on ChatGPT Sites (`https://dugout-signals.rowdybard.chatgpt.site/`), in `components/tennis/`.
- **Private background paper runner:** a Cloudflare Worker plus a SQLite Durable Object (`services/runner/`, deployed as `dugout-paper-runner`).
- **Exact BigInt money and fee maths:** `lib/trading/money.ts` and `lib/trading/execution.ts`.
- **Pure, replayable engine:** `stepTennisSession` at `lib/tennis/engine.ts:552` and `reduceRunnerAction` in `lib/runner/reducer.ts`. The word "tennis" in paths also covers football.
- **577 tests.** `npx tsc --noEmit` passes. Git history has no leaked secrets (checked).

### P0 blockers
1. **There is no real-money order path.**
   - `lib/trading/live-adapter.ts` builds an immediate-or-cancel order, but only `tests/live-adapter.test.ts` imports it.
   - It has no transport, durable journal, lock, cancel or fill reconciliation.
   - `app/api/trading/orders/route.ts` returns 410. `lib/trading/us-signature.ts` only signs the market websocket handshake.
   - `liveEnabled: false` is hardcoded.
2. **There is no evidence of an edge.**
   - The only real sample: $100 → $93.94 over 19 paper fills (about 9 round trips), with $4.11 in fees (68% of the loss). Most of those fills came from the older engine.
   - The current engine `local-move-v1` has **zero** live fills.
3. **Costs are high.**
   - Taker fee = `0.0695 · qty · p · (1−p)` per side (`lib/trading/money.ts:39`). The coefficient comes from market metadata; the fallback is 0.0695.
   - That's about 1.7¢ per side at 50¢. Add a spread of up to 2¢, and a 50¢ contract must move about 5.5¢ (about 11%) just to break even.
4. **The strategy thesis is unproven.**
   - `analyzeOpportunity` (`lib/tennis/opportunity.ts:69-230`) buys after a drop of 2σ or more followed by two bid upticks, targeting a return to the pre-drop bid.
   - Every threshold is hand-picked (the code comment at `opportunity.ts:64` admits it).
   - The score is never used as a signal. Football game state is only a freshness gate (`engine.ts:94-119`).
5. **The data is late.** Football reports arrive 18–82 seconds old (`docs/RELEASE-STATUS.md`), so the bot mostly gets filled on the trades that go against it.
6. **MLB is dead code.**
   - Team-only Elo (`research/mlb-elo/`); holdout Brier 0.2449 vs 0.2485 for the constant home-win guess, with the 2025 interval including zero.
   - Never compared with market prices.
   - Ratings are frozen at 2026-09-22, and anything older than 3 days is blocked (`lib/bot/mlb-forecast.ts:51,65`), so every MLB entry is blocked today.
   - Not wired to the runner or the UI.
7. **Stakes are tiny.** Default $5 per trade, capped at 20% of balance; balance capped at $1,000 (`lib/tennis/rules.ts:25,46,52`).

### Correctness bugs (fix when the code is touched)
- **Risk/reward ratio overstated:** the denominator leaves out the spread already paid and the exit fees, while the numerator is net of both (`lib/tennis/opportunity.ts:217`).
- **Profit target biased upward:** `referenceBid` is the bid at the highest mid in the window (`opportunity.ts:154,159`).
- **Stop can overshoot 8%:** exits are immediate-or-cancel at the signal-time bid, retried one delay later (`engine.ts:146`).
- **Exit history shorter than intended:** the exit window asks for up to 300 s, but history is pruned to 60 s (`engine.ts:457` vs `:625`).
- **Pending entries use mismatched numbers:** the fill uses the old limit, but the recheck uses the new ask, so fills can be partial and the stored analysis no longer matches (`engine.ts:299,313,340`).
- **Invented market rules:** a missing tick, minimum or fee silently falls back to defaults (`lib/server/trading.ts:58-61`), and `stateCertain: true` is hardcoded (`:72`).
- **Optimistic simulator:** fills don't use up liquidity, there's no queue position, and fees are rounded once across all fills rather than per fill (the exchange's rule is unverified).
- **Float money outside execution:** the NO-price complement in `lib/market/paper.ts:15` and `lib/trading/ledger.ts:28-39` use floats.
- **MLB filter favours underdogs:** the shrunk Elo makes the "model > price + 3 points" check pick underdogs (`lib/bot/engine.ts:69,78`).
- **Duplicate wording:** the paused text repeats itself in `lib/tennis/decision-view.ts`.

### Security (fix before real money)
- **Polymarket key exposure:** `/api/trading/stream` opens a new signed upstream connection per request using the owner's Polymarket key. The secret also lives in the web worker (`lib/server/polymarket-market-stream.ts:10`).
- **Identity header fallback:** identity comes from `oai-authenticated-user-id` and falls back to a shared `'private-owner'` account (`lib/server/storage.ts:40`).
- **Weak Origin check:** `sameOrigin` passes requests with no Origin header (`storage.ts:58`).

### Claude integration
- A chat-only adviser (`lib/tennis/advisor.ts`, `app/api/tennis/advisor/route.ts`, model `claude-sonnet-5`, $1 cap). It cannot affect trades.
- **Parked:** no key is configured. It could return later for offline research, such as parsing injury and lineup news into models.

---

## 3. Decisions made
- **Freeze the infrastructure.** The Sites dashboard and Cloudflare runner stay as they are, with the runner paused. No UI or docs polish until a strategy passes.
- **The repo stays public** for Chad's AI. Revisit before real money: a public, *winning* strategy can be copied or traded against. Options are going private and adding Chad as a collaborator, or keeping trained models and strategy settings in a small private repo.
- **The Claude adviser is parked.**
- **Kalshi: public trades API only, no account.** It's optional and used only to study reaction speed.
- **Gates:**
  1. held-out backtest
  2. live paper trading on the Cloudflare runner that matches the backtest
  3. real money with a small bankroll and kill switches
- **Kill rule:** net expectancy ≤ 0, or a 95% confidence interval crossing 0, over 300 or more held-out trades means the strategy is dropped. No tuning on held-out data.

---

## 4. Verified data sources (checked Sep 27, 2026)

### Polymarket US (no auth)
- **Price history:** `GET https://gateway.polymarket.us/v1/price-history?symbol=<market slug>&timestamp.startTimestamp=<unix s>&timestamp.endTimestamp=<unix s>&fidelity=1`
  - Use either `fixedInterval` or the timestamp pair, not both. Custom windows are "intended for up to 24 hours".
  - Responses look **capped at about 1,000 points**, so request windows of 2 hours or less.
  - Points are `{timestamp (s), longPrice, shortPrice}`. `longPrice` is the ask-derived YES display price. Estimated YES bid = `1 − shortPrice`; estimated spread = `longPrice + shortPrice − 1`.
- **Samples that worked:**
  - `aec-nfl-car-gb-2025-11-02`, window 1762106400–1762120800: 161 one-minute points. Pre-game spread was about 10¢ in 2025, so liquidity was thin early on.
  - `aec-nfl-car-ari-2026-08-06`, 1786060800–1786075200: 1,000+ points, irregular spacing of 30–60 s or finer.
  - `aec-cfb-clmsn-cah-2026-09-25`, 1790380000–1790402000: 1,000+ points.
- **Closed events:** `GET https://gateway.polymarket.us/v1/events?closed=true&limit=N&orderBy=startTime&orderDirection=asc`
  - Optional filter: `&sportsMarketTypes=football_team_full_game_winner`.
  - The earliest game seen is NFL, 2025-10-30 (`aec-nfl-bal-mia-2025-10-30`).
- **Slug pattern:** event `nfl-car-ari-2026-08-06`; market `aec-nfl-car-ari-2026-08-06`.
- **Current book and event** (used by the runner): `https://gateway.polymarket.us/v1/markets/{slug}/book` and `/v1/events?id=...` (`lib/trading/fresh-book.ts`, `lib/trading/fresh-event.ts`).
- **Price-history docs:** https://docs.polymarket.us/api-reference/price-history/get-price-history

### Kalshi (public, no account)
- `GET https://api.elections.kalshi.com/trade-api/v2/markets/trades?ticker=&min_ts=&max_ts=&limit=1000&cursor=`
- The OpenAPI spec has `security: []`. Fields: `yes_price_dollars`, `count_fp`, `created_time`, `taker_outcome_side`.
- Docs: https://docs.kalshi.com/api-reference/market/get-trades. Confirm the base host at first use.

### Play-by-play
- **MLB:**
  - `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD` gives `gamePk`.
  - `https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live` has every pitch with `startTime`/`endTime`, plus lineups, weather and probable pitchers.
  - Retrosheet event files cover decades.
  - Baseball Savant Statcast CSV has pitch-level data.
  - 2024–2026 schedules are already in `research/mlb-elo/sources/`.
- **NFL:** nflverse data releases (https://github.com/nflverse/nflverse-data/releases):
  - `pbp`: 1999 onward, includes `time_of_day`, EPA and WP
  - `schedules`: includes `spread_line`, `total_line` and moneylines
  - `injuries`, `depth_charts`, `pbp_participation`
- **CFB:** https://api.collegefootballdata.com needs a **free key** (email only) from https://collegefootballdata.com/key. Store it as `CFBD_API_KEY=` in `research/.env`, which is gitignored.
- **Tennis:** Jeff Sackmann's GitHub repos (`tennis_atp`, `tennis_wta`, `tennis_slam_pointbypoint`).

### Known limits
- There is no historical order-book depth, so backtests assume small top-of-book taker fills.
- Resting-order (maker) strategies can't be backtested on Polymarket US history.
- Astra's local recordings of real Polymarket US books, depth included, for a few games (Clemson, California, others) are in the gitignored `outputs/`, for example `outputs/clemson-review-*.json` and `outputs/post-runner-export-20260926.json`. They only exist on the owner's machine. Use them to cross-check execution realism.

---

## 5. Architecture map

| What | Where |
|---|---|
| Live dashboard | `app/page.tsx` → `components/tennis/tennis-dashboard.tsx` |
| Pure engine step | `lib/tennis/engine.ts:552` `stepTennisSession` |
| Current entry signal | `lib/tennis/opportunity.ts:69` `analyzeOpportunity` |
| Adaptive exits | `lib/tennis/exit-analysis.ts` |
| Rules and defaults | `lib/tennis/rules.ts` (`defaultLiveTennisConfig`) |
| Football context gate | `lib/tennis/football-context.ts` |
| Paper execution and fees | `lib/trading/execution.ts`, `lib/trading/money.ts` (`feeUnits`) |
| Unfinished live-order adapter | `lib/trading/live-adapter.ts` |
| Runner (Cloudflare) | `services/runner/src/{worker,store,input-adapter}.ts`, `services/runner/wrangler.jsonc` |
| Runner reducer and replay | `lib/runner/reducer.ts`, `lib/runner/replay.ts` |
| Model-as-JSON pattern | `data/models/*.json` loaded by `lib/bot/mlb-forecast.ts` |
| Python research | `research/` (existing: `research/mlb-elo/train.py`) |
| New: data lake | `research/market-history/` → `research/data/` (gitignored) |
| New: studies | `research/studies/` → `research/studies/report.md` |
| New: models | `research/models/{mlb,nfl,cfb}/` → `data/models/*-wp-v1.json` |
| New: strategy plugins, regime, selector | `lib/strategy/` |
| New: backtester | `scripts/backtest.ts` → `backtests/` |

---

## 6. Checklist

- [x] **Step 1: This handoff doc**, linked from `README.md` and `docs/README.md`.
- [x] **Step 2: Cleanup** (Sep 27).
  - The runner write-budget and alarm changes are committed, with tests updated to the 90k limit and the 2.5 s safety alarm.
  - The duplicate paused wording is fixed.
  - `.gitignore` now has `research/data/`.
  - 577/577 tests pass, and the main and runner TypeScript checks pass.
  - The runner changes are **not deployed** to Cloudflare.
  - [ ] Owner still needs to get the CFBD key.
- [ ] **Step 3: Data lake**, in progress Sep 27. Environment: `python -m venv research/.venv`, then `research/.venv/Scripts/python -m pip install -r research/requirements.txt` (Python 3.14 works).
  - **Findings so far:**
    - The Polymarket US closed catalog is about 70k events (mostly props). Full-game winner markets are `aec-` slugs with type `moneyline`, `*_full_game_winner` or `tennis_match_winner`. `atc-`/`astatc-` slugs are sub-markets (first five innings, single innings, quarters, halves, sets).
    - Pages can be short mid-catalog (99 of 100), so only an empty page ends the crawl.
    - Custom 24-hour history windows are **not** capped at about 1,000 points (2,112 were returned). Duplicate timestamps occur, so the `seq` column keeps arrival order.
    - Coverage: NFL from 2025-10-31, CFB from 2025-12-06, **MLB from 2026-03-21 only** (no 2025 MLB markets), ATP/WTA from 2026-03-20.
    - Team codes: NFL and MLB markets put the away team on the long (YES) side; codes match nflverse and Stats API except NFL `lar` → `LA`. Tennis uses `home` ordering and player codes.
    - **Leak trap:** nflverse `home_score`/`away_score` are FINAL scores. Pre-play state is in `research/models/nfl/features.py`.
    - nflverse `time_of_day` is a UTC ISO timestamp per snap (about 3% null).
  - **Downloaded:**
    - nflverse: 1.285M plays (1999–2026), schedules with closing lines, injuries, depth charts, participation, snap counts
    - MLB Stats API feeds for 2025–2026 (about 125 KB gzipped per game)
  - **Still to do:** MLB 2021–2024 feeds for win-probability training; CFB after the key arrives; the `align_*` scripts run after history.
  - `fetch_polymarket_us.py`: all closed MLB/NFL/CFB/ATP/WTA winner markets, with price history in 2-hour windows and outcomes
  - `fetch_mlb.py`: Stats API feeds 2025–26, Retrosheet 2000–24, Statcast 2023–26, probable pitchers
  - `fetch_nfl.py`: nflverse play-by-play 1999–2026, schedules with closing lines, injuries, depth charts, participation
  - `fetch_cfb.py`: CFBD plays and lines 2014–2026 (key needed)
  - `fetch_kalshi.py` (optional): public trades
  - `align.py`: one timeline per sport with state, ask/bid/spread and outcome
  - `research/data/manifest.json`
- [ ] **Step 4: Decisive studies.** Mostly done Sep 27; see [`research/studies/report.md`](../research/studies/report.md).
  - **Headline:** taking the posted price (taker) loses everywhere tested. Scalping loses −9% to −11% per trade in NFL and MLB; markets are well calibrated; the NFL price reacts within about 15 s; NFL pregame closes match the sportsbooks.
  - **The one structural edge:** Polymarket US pays makers a 0.0125·p·(1−p) rebate plus liquidity-program rewards (target = aggregate book size; periods day-of and live).
  - Maker markouts before rewards are mildly positive in CFB and pregame, and negative in NFL live.
  - **Price-history density:** 1-minute until mid-May 2026 (MLB) or Aug 2026 (NFL/CFB), then ~1 s. Timing studies must use the dense games only.
  - Open leads: CFB favourite-longshot (favourites +2.5% [−1.4, +6.6] pregame), MLB live reaction timing, the live feed-latency probe (`research/market-history/live_lag_probe.py`, run on Sep 27).
  - Original sub-items:
  - `drop_reversion.py`: does Astra's dip strategy make money after fees?
  - `calibration.py`: is the market biased?
  - `reaction.py`: over- or under-reaction by play type, and lag in seconds
  - `report.md`: plain-English findings plus a summary Chad can read
- [ ] **Step 5: MLB models:**
  - win-expectancy base
  - Elo plus starting pitcher
  - live layer: pitch count, times through the order, bullpen fatigue, who's due up, platoon, park and weather
  - gradient boosting, calibrated; scored against both the outcome **and** the market price at the same moment
  - export `data/models/mlb-wp-v1.json`
- [ ] **Step 6: NFL (then CFB) models.** v1 trained Sep 27 (`research/models/nfl/train_wp.py`, artifacts in `research/models/nfl/artifacts/`).
  - Brier on held-out 2025–26 (52.6k plays): ours 0.162, nflfastR `home_wp` 0.170, nflfastR `vegas_home_wp` 0.158.
  - The added `total_line`/`spread_remaining` features were kept because *validation* improved (0.1439 → 0.1431). The test score was not used to choose.
  - Next: benchmark against the market price at the same moments.
  - Remaining plan items:
  - win probability plus EPA, team and QB strength
  - situation flags: QB change, weather, kicker range, fourth-down tendencies
  - train 1999–2023, validate 2024, test 2025–26 against the market
  - export `data/models/nfl-wp-v1.json`
- [ ] **Step 7: Strategy lab and backtests:**
  - `lib/strategy/` interface and plugins: `local-move-v1`, `never-trade`, `random-entry`, `fair-value-divergence`, `reaction-*`, `near-settlement`, `pregame-value`
  - `scripts/backtest.ts`: same decision code as the runner, taker fills with 1–2 observations of delay, `feeUnits` fees, walk-forward, held-out final block
  - `backtests/*.md`
- [ ] **Step 8: Dynamic engine:**
  - `lib/strategy/regime.ts` and `selector.ts`, with ¼-Kelly stakes and caps
  - replace the single `local-move-v1` call in `stepTennisSession`
  - add MLB and NFL live feeds to the runner input adapter
  - one explanatory dashboard card
  - live paper trading during the MLB postseason and NFL/CFB weekends
- [ ] **Step 9: Real money:**
  - finish `live-adapter.ts` (transport, journal, lock, cancel, reconciliation)
  - kill switches
  - fix the security items above
  - check Polymarket US terms for automated trading
  - revisit repo visibility
  - start with a small bankroll

---

## 7. Rules for whoever continues
1. **Never commit secrets.** Keys go in `research/.env` or runtime secret stores; `.env*` is already gitignored.
2. **Don't touch the live Cloudflare runner or the Sites deployment**, and don't restart the paused paper account, until Step 8.
3. **Hold-out discipline.** Choose features and settings on training and validation periods only. The held-out block is scored once per strategy version, and each score is recorded.
4. **Always include controls.** Every backtest report includes the never-trade and random-entry controls.
5. **Report honestly.** Failed strategies are useful results. Write them up in `research/studies/report.md` or `backtests/`, and don't quietly drop them.
6. **Reuse existing code.** Fees via `lib/trading/money.ts`; models as JSON read by the TypeScript engine; the pure engine for replay.
7. **Explain for Chad.** Write each result in terms of expected value per trade after fees, with a confidence interval.

---

## 8. How to resume
1. `git log --oneline -15` and `git status` show where the work stands; the checklist above shows the intended status.
2. Toolchain:
   - Node ≥ 22 and pnpm 11 (`pnpm install --frozen-lockfile`)
   - Python 3.11+ for `research/` (dependencies go in `research/market-history/requirements.txt` once created)
3. Checks: `pnpm test`, `npx tsc --noEmit`, `pnpm runner:check`.
4. Data: `research/data/manifest.json` records which data was pulled and when. Fetch scripts are resumable, so rerunning them continues where they stopped.
5. Results: `research/studies/report.md` and `backtests/*.md`.
6. Older context: [audit sources](MAINTAINER-HANDOFF.md), [release evidence](RELEASE-STATUS.md), [bot manual](BOT-MANUAL.md). These describe the paper product as of Sep 26, 2026.
