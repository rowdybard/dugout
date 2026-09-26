> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Polymarket US integration — verified September 23, 2026

This application targets **Polymarket US**, not Gamma, Polygon tokens, or the global CLOB.

## Verified official sources
- https://docs.polymarket.us/api-reference/introduction
- https://docs.polymarket.us/api-reference/authentication
- https://docs.polymarket.us/api-reference/sports/get-events-by-league-slug
- https://docs.polymarket.us/api-reference/markets/get-market-bbo
- https://docs.polymarket.us/api-reference/markets/get-market-book
- https://docs.polymarket.us/api-reference/markets/get-market-settlement
- https://docs.polymarket.us/api-reference/price-history/get-price-history
- https://docs.polymarket.us/api-reference/websocket/markets
- https://docs.polymarket.us/fees
- https://github.com/Polymarket/polymarket-us-typescript

## Contract decisions
Public origin: `https://gateway.polymarket.us`. Authenticated origin: `https://api.polymarket.us`.

| Capability | Verified contract | MVP use |
|---|---|---|
| League games | GET `/v2/leagues/{slug}/events`, `type=sport`, `limit`, `offset`; response `events`, `league` | Only `mlb` and `nfl`; 4-event pages, bounded 24 games each |
| Events | `id`, `title`, `slug`, `startTime`, `teams`, `markets`, `active`, `closed`, `ended` | Group games, associated markets, actual records when supplied |
| Markets | `id`, `slug`, `sportsMarketType`, `marketSides`, `bestBidQuote`, `bestAskQuote`, `feeCoefficient` | Slug identifies quote/history/settlement requests; `long:true` determines YES outcome label |
| Quotes | GET `/v1/markets/{slug}/bbo`, response `marketData` | Decimal `Amount.value`; `bestBid`, `bestAsk`, `sharesTraded`, `bidShares`, `askShares`, `state` |
| Order book | GET `/v1/markets/{slug}/book`, response `marketData` | `bids`, `offers`: each `px.value`, `qty`; `state`, `transactTime` |
| History | GET `/v1/price-history`, `symbol=slug`, `fixedInterval`, `fidelity` | `history[].timestamp` is Unix seconds; `longPrice` YES ask-derived display price; `shortPrice` NO display price |
| Settlement | GET `/v1/markets/{slug}/settlement` | `slug`, numeric `settlement`; 404 means unavailable or unsettled. Never infer results from price or score. Fractional official settlements supported. |
| SDK | Official `polymarket-us`, registry-resolved version 0.1.1 | Public BBO/book/metadata/settlement methods. New v2 league/history surface uses documented REST, because stable SDK does not expose it. Treat stale SDK response declarations as unknown at normalization boundary. |
| Sports/teams/series | v2 leagues/sports plus legacy sports teams and series | Current events already carry required teams and records. No invented pitchers/injuries/lineups. |

History profiles: 1h/1 minute; 6h/1 minute; 24h/5 minutes; ALL/180 minutes. 15m filters official 1h observations. Historical spread = longPrice + shortPrice − 1; historical prices are **not trades**. Do not derive trading volume from count of price updates. Historical chart data is never interpolated into fabricated samples.

Public limit: 20 requests/second/IP. Actual provider rate limits have also occurred below this advertised rate. Public reads are conservatively serialized with 750 ms spacing and persisted provider backoff. Cache detailed history 60 seconds, BBOs 20 seconds, and listing pages 120 seconds. Discovery has a 12-second deadline, up to six four-event pages per requested league, and returns explicitly partial coverage when necessary. The home feed uses listing quotes at their original receipt times and saved chart observations; opening a market fetches detailed history and current quotes. Bot cycles use independent discovery for their selected leagues and at most two entry candidates, under a shared 22-second source deadline. Trades still require a fresh executable order book; a cached listing cannot authorize a fill.

## WebSockets and future account capability
`wss://api.polymarket.us/v1/ws/markets` requires authenticated handshake. Requests use `subscribe: {requestId, subscriptionType, marketSlugs}`. Types: `SUBSCRIPTION_TYPE_MARKET_DATA`, `SUBSCRIPTION_TYPE_MARKET_DATA_LITE`, `SUBSCRIPTION_TYPE_TRADE`. Responses are enveloped in `marketData`, `marketDataLite`, or `trade`. The official SDK supports signed connections and event handlers. Do not expose private keys in a browser.

US authentication is **Ed25519**, not global HMAC: key ID plus base64 private key, X-PM-Access-Key / X-PM-Timestamp / X-PM-Signature. Order, portfolio, balance and private-stream functionality is separate. V1 instantiates an unauthenticated SDK only and exposes no real-order routes. An authenticated streaming service can later replace polling at the ingestion boundary.

## Fee and simulation assumptions
Official fees effective September 17, 2026: taker fee `theta × contracts × price × (1-price)`, theta 0.0695; prefer a supplied market fee coefficient. No volume-tier rebates assumed. Simulation walks asks on entry and bids on exit; estimates fees at each fill level. Whole contracts are a conservative V1 assumption: current market schema can expose fractional minimumTradeQty, despite an older whole-contract FAQ. Unspent budget remains cash; insufficient book depth never creates extra contracts. Cancellation can resolve at an official fractional settlement.

## Known limits
Polling runs while the app is open, not an always-running background collector. Official price history fills prior price coverage; volume/depth snapshots begin when observed. Signal evaluation describes self-selected paper trades, not randomized evidence of predictive power. No external game-context provider. No authenticated WebSocket until credentials and a durable ingestion runner are configured. Polling order-book snapshots cannot reliably identify individual orders, so large-order arrival/removal and smart-money claims are deliberately absent.
