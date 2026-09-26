# Dugout optional Node streaming bridge

A persistent, **read-only** Polymarket US connection service retained for the optional stream proxy and older research surfaces. It cannot create, cancel, modify, or close a real-money order. The current [Cloudflare paper runner](../runner/README.md) has its own native market transport and does not require this process. Starting this bridge does not start the paper bot or take ownership of its journal.

The web application remains separately deployable and must proxy this service through owner authentication. Never put its token or exchange credentials in a browser bundle. Keep this directory with the repository's shared `lib/trading` sources and lockfile; it is not a standalone package.

## Run

Use the pnpm version pinned in `package.json`. From the repository root, using Node 22.13+ (Node 24 tested):

```sh
pnpm install --frozen-lockfile
pnpm trading:stream
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

`StreamSnapshot`, events, decimal strings, display-number prices, and `streamBookForDisplay()` are defined in `lib/trading/stream-types.ts`. Empty selections remove that owner's subscriptions. Owners' lists are merged, with full book taking precedence over lite; maximum 32 owners and 500 unique markets. Owner IDs may use letters, numbers, `_`, `.`, `:`, `-`, up to 400 characters. An owner expires 60 seconds after its last POST or SSE disconnect. Supply `ownerId` in SSE to retain the selection while viewing it; multiple tabs may share an owner. The shared selection contract supports MLB, NFL, ATP, WTA and CFB. The server proxy must verify the actual market in its catalogue or persisted positions before subscribing; a client-provided league label is not evidence. Internal selection changes are idempotent and have no trading side effect.

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

This bridge's state is in memory and is rebuilt after restart. It does not persist an authoritative paper session, archive all ticks or orchestrate strategy. Those paper-session responsibilities are implemented separately by `services/runner`; its journal is not populated by simply launching this bridge. The bridge's health flags do not establish authenticated production contract verification or actual live execution. It never substitutes minute history for live ticks.

Run its regressions from the repository root with `node --experimental-strip-types --test services/trading/*.test.ts`, or all shared tests with `pnpm test`. Deployment secrets and process state are excluded from the source ZIP. Supply them through the server environment only when explicitly enabling this optional component.

## Official sources checked September 23, 2026

- [Market WebSocket](https://docs.polymarket.us/api-reference/websocket/markets)
- [Private WebSocket](https://docs.polymarket.us/api-reference/websocket/private)
- [TypeScript SDK WebSocket](https://docs.polymarket.us/api-reference/sdks/typescript/websocket)
- [WebSocket overview and authentication](https://docs.polymarket.us/api-reference/websocket/overview)
- [Rate limits](https://docs.polymarket.us/api-reference/rate-limits)
- [Open orders](https://docs.polymarket.us/api-reference/orders/get-open-orders)
- [Portfolio SDK and decimal quantities](https://docs.polymarket.us/api-reference/sdks/typescript/portfolio)
- [Account balance response](https://docs.polymarket.us/api-reference/account/get-account-balances)
