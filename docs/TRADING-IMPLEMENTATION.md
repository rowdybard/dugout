# Trading workspace implementation

September 23, 2026. This release implements the compact Advanced workspace and a price-protected paper execution loop. It does not enable real-money orders or claim a profitable strategy.

## Shipped in the web app

- Beginner OFF switches to a dedicated chart-centered workspace with current bid/ask, editable server-persisted entry/exit presets, explicit Paper mode, and position/order feedback.
- The selected market refreshes through public REST every five seconds while visible. It is labeled REST. Feed discovery remains cached; five-second selected quotes are not a realtime guarantee.
- If an authenticated external stream service is configured, the app proxies its selected-market SSE and uses quote updates directly. Keys and internal tokens never enter browser code.
- Paper entry and exit use a fixed-point, limit-protected IOC simulator. Fractional sizing uses documented minimumTradeQty and orderPriceMinTickSize; the simulator conservatively uses minimumTradeQty as its size grid. Aggregated depth fees are estimates, not exchange fill confirmations.
- An immutable D1 command journal and profile-version transaction make repeat command IDs idempotent. Cash/positions and the order result commit together. A concurrent account change rejects the uncommitted calculation.
- Partial exits allocate entry basis and entry fees proportionally. Manual exit pauses strategy re-entry before obtaining a quote, including failed/no-fill exits.
- One configurable pregame dip/recovery paper test runs while the workspace remains open. It collects fresh observations, requires later recovery, checks spread/depth/exposure, and evaluates fee-inclusive target/stop/time exits. Budget limits cap cumulative test spending. Browser interruption pauses on the next check. This is not a 24/7 bot.
- Existing September 23 $10 real-price paper experiment remains unchanged and separate.

## Runnable foundations, not enabled live trading

The standalone Node streaming service uses the official polymarket-us SDK for authenticated market/private sockets, validated envelopes, account reconciliation, owner subscription leases and redacted health. It is read-only and explicitly reports not_configured without credentials. See services/trading/README.md.

lib/trading/live-adapter.ts has tested order request construction and injected durable-journal/account-serialization interfaces. NO limits are complemented into YES-denominated API price.value. LIMIT + IOC only, explicit manual/automatic classification, no unrestricted market fallback. Unknown submission results block repeat sends; acknowledgments remain pending until official fills reconcile.

The live adapter is not wired to a web order endpoint. Real execution requires a durable account coordinator/journal, official fill/cancel reconciliation, authenticated contract verification, server credentials, a persistent deployment and user-set risk limits. No credential was configured and no real order was submitted in this release.

## Honest testing boundaries

Production uses real public US endpoints. Local development uses the existing clearly labeled recorded official response capture. The new execution engine refuses to treat replay prices as current orders. Synthetic tests are isolated from production and do not manufacture game results or paper profits.

Execution and stream scenarios test double commands, partial quantities, complement prices, stale/uncertain data, fees, data gaps, future-data exclusion, reconciliation races and manual takeover. This proves program behavior under defined assumptions, not strategy profitability. Live authenticated latency and fill quality remain unmeasured.

## Operations

- npm test — behavior and protocol tests.
- npm run trading:stream — starts the read-only Node connection service.
- npm run db:generate — append-only database migrations.
- Sites publishes the UI/API/D1 application. Deploy the persistent Node service separately and set TRADING_SERVICE_URL/TRADING_SERVICE_TOKEN on the web app. Configure POLYMARKET_KEY_ID/POLYMARKET_SECRET_KEY only on that service.
- Do not store secrets in the repository or send them in chat.

Official contracts rechecked September 23, 2026:
https://docs.polymarket.us/api-reference/markets/get-market-by-slug
https://docs.polymarket.us/api-reference/websocket/markets
https://docs.polymarket.us/api-reference/websocket/private
https://docs.polymarket.us/api-reference/orders/create-order
https://docs.polymarket.us/api-reference/rate-limits
https://docs.polymarket.us/fees
