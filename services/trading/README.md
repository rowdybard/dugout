# Dugout streaming service

A persistent, **read-only** Polymarket US connection service. This process cannot create, cancel, modify, or close a real-money order. The web application remains a separate deployable. It must proxy this service through its existing owner authentication; never put the service token or exchange credentials in a browser bundle.

## Run

Install the repository's dependencies with its existing package manager. From the repository root, using Node 22.13+ (Node 24 tested):

```sh
node --experimental-strip-types services/trading/server.ts
```

It starts without secrets and reports `not_configured` at `http://127.0.0.1:4179/health`. It does not generate placeholder prices or attempt an unauthenticated WebSocket connection. Supply secrets through the deployment's server-side secret manager, not source control:

| Variable | Purpose |
| --- | --- |
| `POLYMARKET_KEY_ID` | Official US API key ID |
| `POLYMARKET_SECRET_KEY` | Official US signing secret, in the SDK's required format |
| `TRADING_SERVICE_TOKEN` | Independent random internal API token, at least 32 characters |
| `TRADING_SERVICE_PORT` | Listener port, default `4179` |
| `TRADING_SERVICE_HOST` | Default `127.0.0.1`; non-loopback binding requires the service token |
| `TRADING_STREAM_IDLE_TIMEOUT_MS` | Transport silence timeout, default `60000`, allowed 15000–300000 |

The web app needs `TRADING_SERVICE_URL` and the same `TRADING_SERVICE_TOKEN`. Use HTTPS/private networking when the service is remote. The process is designed for one private owner/account. Do not connect an unrelated user's browser to this account stream. No CORS permission is emitted.

## Internal HTTP interface

Except `/health`, every route requires `Authorization: Bearer <TRADING_SERVICE_TOKEN>`. A missing/short configured token denies all private routes with 503; a wrong token returns 401. The token is never accepted in query strings.

| Route | Response / action |
| --- | --- |
| `GET /health` | Redacted process/provider/reconciliation state; HTTP 200 means the process responds, not that market data is usable |
| `GET /v1/status` | `StreamHealth` |
| `GET /v1/snapshot?markets=slug-a,slug-b` | `StreamSnapshot`; optional selected-market filter |
| `POST /v1/subscriptions` | `{ "markets": [{ "slug": "...", "league": "MLB", "detail": "book" }], "ownerId": "optional-owner" }`; returns snapshot |
| `POST /v1/reconcile` | Schedules read-only account reconciliation, returns 202 and health |
| `GET /v1/events?markets=slug-a,slug-b&ownerId=owner` | SSE `snapshot` on connect; `status`, `quote`, `trade`, `account` events thereafter; keeps the owner's selections leased |

`StreamSnapshot`, events, decimal strings, display-number prices, and `streamBookForDisplay()` are defined in `lib/trading/stream-types.ts`. Empty selections remove that owner's subscriptions. Owners' lists are merged, with full book taking precedence over lite; maximum 32 owners and 500 unique markets. Owner IDs may use letters, numbers, `_`, `.`, `:`, `-`, up to 400 characters. An owner expires 60 seconds after its last POST or SSE disconnect. Supply `ownerId` in SSE to retain the selection while viewing it; multiple tabs may share an owner. The server proxy must verify actual MLB/NFL membership from its catalogue before calling; a client-provided league label is not evidence. Internal selection changes are idempotent and have no trading side effect.

The SSE body uses standard named events and JSON in `data:`. Browser reconnect must replace state with the fresh `snapshot`, not append it as trade history. SSE has no replay guarantee or resume cursor. The service terminates slow consumers rather than accumulating unbounded queued financial state. UI transport keep-alive comments are not evidence of a provider update. Shared quote values always identify their source as `polymarket_us_websocket`; development replay is never inserted into this service.

## Provider contracts and data health

The installed official `polymarket-us` 0.1.1 SDK signs connections to the **US** `/v1/ws/markets` and `/v1/ws/private` endpoints. It sends the documented camelCase subscription requests. Book/lite/trade subscriptions are split into batches of at most 100 markets. Full book and trade feeds are used only for selections requesting `book`; discovery selections use `lite`.

The current private endpoint page differs from some 0.1.1 event types. We use the SDK's raw `message` event and explicit validated contracts. Current `positionSubscription`, `accountBalancesSnapshot`, and `accountBalancesUpdate` envelopes are supported, along with the explicitly typed SDK position snapshot/update variants. Unknown envelopes, invalid quantities, malformed prices, crossed/unsorted books, and unknown market subscriptions are rejected. Missing market identity in a position update triggers REST reconciliation rather than a guessed association. Rounded legacy position quantities are marked `legacy_rounded`; they are not a basis for future fractional execution.

There is a known documentation conflict: the WebSocket overview shows snake_case/numeric enums, while endpoint pages and the SDK use camelCase/string enums. This service follows the SDK/endpoint contracts. It does not claim those contracts were observed on an authenticated production connection. `authenticatedContractVerified` and `liveExecution` remain false.

Quote `receivedAt`, provider `sourceTime`, `lastPriceChangeAt`, connection activity, and heartbeat times are distinct. A healthy heartbeat with no price change keeps the connection alive without changing the quote's observation time or making an old source timestamp recent. Book snapshots replace book state; no invented delta protocol is applied. An older timestamped snapshot cannot overwrite newer state. Source clocks more than two seconds ahead are rejected; smaller leads remain visible in `sourceTime` and must never produce a negative displayed age.

Disconnects invalidate books immediately. A reconnect heartbeat alone does not revalidate old quotes: a new valid market snapshot is required. Quiet transport beyond the configured timeout causes exponential reconnect backoff with jitter, fresh authentication, and subscription restoration. The default 60-second timeout is **not a quote refresh interval**. Actual updates are forwarded as received.

Private updates are forwarded as provisional observations and always make reconciliation pending. Missing timestamps, older events, duplicate execution IDs, and late open-order events after terminal states cannot roll authoritative state backward. Full account readiness requires validated REST orders, complete paginated positions, and balances, with no private state change racing those reads. Requests are serialized at no more than five per second from this service; failures back off. A periodic 60-second account check is a reconciliation safeguard, not the live account update path. No whole-account atomicity guarantee is claimed where the provider exposes none.

## Deployment and remaining gates

Deploy on a runtime supporting a continuously running Node process and outbound authenticated WebSockets. The current request-driven UI deployment does not start this process. Health monitoring should examine provider/reconciliation state as well as HTTP liveness. Stop the process through SIGTERM/SIGINT for clean socket/SSE shutdown.

Current state is in memory and is rebuilt after restart. Durable tick archival, an execution journal, strategy orchestration, authenticated-session contract capture, source latency measurement, production credentials, and persistent service deployment are separate work. This foundation does not imply that historical tick replay or live execution is ready. It never substitutes minute history for live ticks.

## Official sources checked September 23, 2026

- [Market WebSocket](https://docs.polymarket.us/api-reference/websocket/markets)
- [Private WebSocket](https://docs.polymarket.us/api-reference/websocket/private)
- [TypeScript SDK WebSocket](https://docs.polymarket.us/api-reference/sdks/typescript/websocket)
- [WebSocket overview and authentication](https://docs.polymarket.us/api-reference/websocket/overview)
- [Rate limits](https://docs.polymarket.us/api-reference/rate-limits)
- [Open orders](https://docs.polymarket.us/api-reference/orders/get-open-orders)
- [Portfolio SDK and decimal quantities](https://docs.polymarket.us/api-reference/sdks/typescript/portfolio)
- [Account balance response](https://docs.polymarket.us/api-reference/account/get-account-balances)
