# MLB team-strength forecast baseline — experimental paper use

This is a frozen historical research artifact built September 23, 2026 from actual MLB Stats API regular-season schedule results through September 22. It adds an interpretable outcome estimate for the older MLB research engine; it does not model players or establish profitable Polymarket trading. The active ATP/WTA/NFL/CFB dashboard and Cloudflare runner use `lib/tennis` and do not use this MLB model. Keep the research and its original provenance when packaging the project.

## Data and provenance

Official response fields were inspected directly from `statsapi.mlb.com`: `dates[].date`, `games[].gamePk`, `officialDate`, `gameType`, `status.abstractGameState`, `teams.home/away.team.id`, `team.name`, and `teams.home/away.score`. No external schema is invented. Public official documentation entry points redirect to login, so the captured actual official API responses are the contract evidence for the fields used.

Sources (fetched September 23, 2026, approximately 18:24 UTC):

- https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2024&gameType=R
- https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2025&gameType=R
- https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2026&gameType=R&startDate=2026-01-01&endDate=2026-09-22

Raw compressed responses and exact uncompressed SHA-256 hashes are retained in `sources/manifest.json`. Training verifies those hashes. No September 23 outcome is used. Rescheduled/resumed records are conservatively excluded because a final result attached to an earlier original date can leak later information into a chronological evaluation.

| Season | Source rows | Accepted final games | Last accepted date |
|---|---:|---:|---|
| 2024 warmup | 2,469 | 2,392 | 2024-09-29 |
| 2025 selection + holdout | 2,464 | 2,396 | 2025-09-28 |
| 2026 later evaluation + current ratings | 2,386 | 2,329 | 2026-09-22 |

Accepted normalized games, exclusions by reason, source URLs, receipt times and hashes are available in the artifact. Historical schedule results were fetched retrospectively; this is not a collection of archived historical publication-time snapshots.

## Model and split

Initialize every observed MLB team at 1,500. Pregame home-win probability is:

`1 / (1 + 10 ** (-(home_rating - away_rating + home_advantage) / 400))`

After all predictions for a source calendar date are recorded, sum each game's `K × (result − probability)` update into its teams' ratings. Both games of a doubleheader use the same ratings before that date. Before each new season, carry 67% of the prior rating difference from 1,500. The model has no margin-of-victory or current-day inputs.

The predeclared nine-candidate grid was K in `[4, 8, 16]` and home advantage in `[15, 30, 45]`. 2024 is warmup. Only the 1,246 accepted games before July 1, 2025 select the configuration by Brier score; ties use log-loss, K and home advantage. Selected: **K 4; home advantage 30; season carry 0.67**. Configuration stays fixed through the subsequent chronological holdout and all of the 2026 evaluation. Team ratings continue updating after earlier completed dates, as an online model would; parameters are not retuned on those outcomes.

## Measured results

Lower Brier and log-loss are better. These compare outcome forecasts, not returns or executable market prices.

| Period / forecast | Games | Brier | Log-loss |
|---|---:|---:|---:|
| July–September 2025 model | 1,150 | 0.244925 | 0.682738 |
| Same games, 50/50 | 1,150 | 0.250000 | 0.693147 |
| Same games, constant home-win baseline | 1,150 | 0.248534 | 0.690212 |
| 2026 through September 22 model | 2,329 | 0.245674 | 0.684405 |
| Same games, 50/50 | 2,329 | 0.250000 | 0.693147 |
| Same games, constant home-win baseline | 2,329 | 0.249091 | 0.691328 |

Each constant-home baseline is calculated only from games before its evaluation period. Calibration tables and measured expected calibration error are in `model.json`. A paired calendar-day bootstrap of the Brier difference versus constant home win gives:

- 2025 holdout: −0.003609; 95% percentile interval **[−0.007355, +0.000495]**. This interval includes zero.
- 2026 later evaluation: −0.003417; interval **[−0.005771, −0.001111]**.

These intervals are descriptive resampling results with 1,000 replicates and a fixed seed. They are not evidence of profitable trading, player-impact modeling, or superiority to Polymarket's prices. Some high/low probability calibration bins have very small samples.

## Runtime integration

`forecastMlbPregame(model, context, request)` is pure TypeScript. Inject the parsed `model.json`; it does not import JSON, read files, fetch sources or write orders. The Site's `lib/bot/mlb-forecast.ts` uses a relative type import and runs in both Node and the Worker.

`request` requires `now`, a explicitly mapped **MLB team ID** for the YES outcome, and `marketFamily: 'FULL_GAME_WINNER'`. Use the official MLB IDs from the matched `SportsContext.game.home.id` / `.away.id`; Polymarket IDs are a separate namespace. Map the YES team explicitly and fail closed on ambiguity. Do not infer a team from prices, ordering, aliases or a market slug.

It refuses other leagues, in-play games, unknown teams, mismapped YES outcomes, non-MLB source namespaces, future or replay context, current-day training data, and stale team ratings. Default maximum ratings age is three days; context receipt age is 90 seconds. Both are configurable freshness gates, not source latency promises. Ratings end on September 22, 2026; they are not a current feed and expire under the configured age gate. This package has no scheduled ratings refresh.

An available output explicitly includes `playerImpactModeled: false`, `marketValueEstablished: false`, and the missing feature list. Existing injury/pitcher/QB-change gates remain separate. Comparing a selected-side forecast payout with fee-inclusive entry cost can filter a paper experiment. It does not validate the chance of hitting a short-horizon take-profit price; this model's horizon is game outcome/settlement.

## Observed matchup calculation examples

`observed-matchup-examples.json` uses actual team IDs already present in the existing recorded sports capture. With September 22 ratings:

- Washington Nationals (120) at Detroit Tigers (116): home estimate **56.46%**, away **43.54%**.
- Minnesota Twins (142) at San Francisco Giants (137): home **52.35%**, away **47.65%**.
- Toronto Blue Jays (141) at Baltimore Orioles (110): home **52.57%**, away **47.43%**.

These are arithmetic examples for observed matchup identities, not claims of fresh context, an entry recommendation or actual paper fills. Captured event IDs and times are retained; some games had already started when this model was built.

## Reproduction and tests

Run the offline reproduction from the repository's `research/mlb-elo` directory:

```sh
python train.py
python test_training.py
node --experimental-strip-types --test ../../tests/mlb-forecast.test.ts
```

Training reruns offline from the captured gzip files and verifies manifest hashes. It writes local research artifacts; `test_training.py` imports the training module and also regenerates them. Run in a copy if preserving the original artifact bytes matters. Python tests verify same-date predictions, future-result exclusion, selection/holdout date separation and the current-day cutoff. TypeScript tests verify strict mapping, opposite-team probabilities, freshness/phase blocks and parity with an actual Python holdout prediction. These check reproducibility and program behavior, not fresh performance.

`python fetch_sources.py` optionally fetches and overwrites the fixed-date captures and manifest. It is not required offline and is not an automatic update to the present date. Review provenance and training date boundaries before changing this historical experiment. Distribute `sources/*.json.gz`, `sources/manifest.json`, the Python scripts, design, normalized games, predictions, examples and model together.

There is no NFL model, player model, market-price backtest, execution-alpha claim or real-money permission in this proposal.

## Shipped integration

The older MLB engine's packaged artifact is `data/models/mlb-elo-2026-09-23.json`, imported by `lib/bot/server-input.ts`. Retraining emits `research/mlb-elo/model.json` for review; it does not silently replace that imported artifact or a running session's frozen model. Copy a reviewed artifact and update the relevant configuration explicitly if continuing the MLB experiment. There is no scheduled refresh; ratings beyond three days block this model's use in new entries. This does not change the current football report freshness policy or tennis strategy.
