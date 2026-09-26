> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Tennis integration: verified Polymarket US contracts

Verified September 25, 2026, against official US documentation and unauthenticated responses from `https://gateway.polymarket.us`. This integration does not use the international Gamma/CLOB APIs. No orders were submitted during verification.

## Sources and response contracts

| Purpose | Official source | Implemented contract |
| --- | --- | --- |
| ATP/WTA discovery | [Sports overview](https://docs.polymarket.us/api-reference/sports/overview) and [league events](https://docs.polymarket.us/api-reference/sports/get-events-by-league-slug) | `GET /v2/leagues/{atp\|wta}/events?type=sport&limit=4&offset=0`; response `events[]` |
| Market metadata | [Market by slug](https://docs.polymarket.us/api-reference/markets/get-market-by-slug) | `GET /v1/market/slug/{slug}`; response `market` |
| Executable depth | [Market book](https://docs.polymarket.us/api-reference/markets/get-market-book) | `GET /v1/markets/{slug}/book`; response `marketData` with `marketSlug`, `bids`, `offers`, `state`, `transactTime` |
| Final outcome | [Market settlement](https://docs.polymarket.us/api-reference/markets/get-market-settlement) | `GET /v1/markets/{slug}/settlement`; response `{slug, settlement}` |
| Fees | [US fee schedule](https://docs.polymarket.us/fees) | Standard taker fee uses coefficient × quantity × price × (1 − price), with the documented cent rounding; coefficient is read from market metadata |
| Limits | [US rate limits](https://docs.polymarket.us/api-reference/rate-limits) | Public requests limited to 20 per second per IP; shared backoff and bounded discovery reused |

Only `sportsMarketType: "tennis_match_winner"` qualifies. Doubles/mixed events, paired player names, sets, spreads and totals are excluded. Exactly two market sides with opposite boolean `long` values must supply nonempty player descriptions. `long: true` maps to YES; `long: false` maps to NO. Player identity is never derived from title order, quoted prices, or an MLB fallback.

`orderPriceMinTickSize`, `minimumTradeQty`, `feeCoefficient`, and `status` are checked before execution. Missing or invalid values block paper fills. The documented minimum quantity also defines the permitted contract increment. Actual ATP and WTA match-winner responses returned a 0.01 price increment, 0.01 minimum quantity and 0.0695 fee coefficient during this verification; these observations are not hardcoded defaults.

## Live response observations

- ATP returned live Juan Carlos Prado–Alex Barrena and Tristan Boyer–Timo Legout matches. Their explicit event `live`, `ended`, `score`, `period`, and `eventState.updatedAt` fields are usable without ESPN.
- WTA returned Katie Volynets–Kimberly Birrell with `period: "Sus."`, `live: false`, and an earlier start time. This is displayed as interrupted, with new entries blocked. A scheduled start time is never treated as proof of live play.
- `eventState.tennisState` supplied tournament and round. One WTA response also included `servingTeamId`, but that field was absent from the official endpoint schema reviewed. It is not used to invent a server-aware strategy. Injury, point-completeness, medical-timeout, and live win-probability coverage are not assumed.
- A current book response carried 41 bid levels and 35 offer levels. Levels use `px.value` decimal strings and `qty` decimal strings. Any malformed or crossed depth rejects the snapshot.
- Book `transactTime` can be older than the HTTP read. The system preserves it separately from actual snapshot receipt. Cached snapshots retain their original receipt time; reading a cache does not manufacture a fresh observation.
- An **open** book included `stats.settlementPx.value: "0.0000"`. This is not settlement evidence. Its official settlement endpoint returned HTTP 404. Only a matching-slug, successful settlement response with a value in `[0,1]` can resolve a position. Fractional fair-price settlements are allowed by this parser; walkover/cancellation rules can require them.

## Request and storage policy

Discovery uses at most two four-event pages per tour, a 12-second deadline and a shared 30-second cache. It retains matches beginning within the next 48 hours or the previous 30 hours, sorts live matches first, and labels incomplete discovery. This is a deliberately bounded scan, not a claim of all tennis inventory.

Execution first reads the existing authenticated WebSocket book cache. REST fallback has a one-second cache. Callers can disable REST per candidate, allowing held positions and a rotating subset of candidates to receive the request budget. Cached and streamed reads require an actual receipt within five seconds, matching the paper engine; an older connected stream triggers REST fallback when permitted. The shared Polymarket public-source backoff survives Worker restarts and honors both seconds and HTTP-date forms of Retry-After.

The shared session service records full observations in `tennis_observations`. Charts read up to 100 captured observations from the last six hours. These midpoint charts describe observed quotes; they are not executable prices or a backfilled market history. Historical chart data is never sufficient to create a fresh fill.

`tests/tennis-data.test.ts` exercises reversed YES/NO ordering, separate WTA routing, unsupported markets, missing execution rules, suspended/unconfirmed matches, provider-ended status, invalid/crossed books and fractional settlement. Fixtures are explicitly synthetic and are not used in the live interface.
