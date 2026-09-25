# Dugout architecture

- `lib/server/polymarket.ts`: read-only official US SDK and current documented REST adapter.
- `lib/server/ingestion.ts`: bounded league pagination, sports normalization, quote/history ingestion, snapshot collection.
- `lib/server/storage.ts`, `db/schema.ts`: Cloudflare D1 cache, time-indexed snapshots, versioned portfolio/watch/config state.
- `lib/market/scanner.ts`: configurable absolute and relative observations, with plain-language reasons; pure and testable.
- `lib/market/paper.ts`: depth-aware buys and sells, estimated fees, no real trading.
- `lib/server/portfolio.ts`: revaluation and official settlement reconciliation.
- `components/dugout`: independent cards, charts, market detail/calculator and portfolio analytics.
- `lib/market/explain.ts`: concise education layer.
- `app/api`: public market reads and server-validated paper/watch/settings mutations, with same-origin checks and optimistic concurrency.

Hosting is owner-private. Profile identity uses the trusted platform-authenticated user header; owner-private fallback is one shared private-owner ledger. Do not make this Site public without requiring authenticated identity on all profile endpoints.

Snapshots persist at most one per market per minute, with 30-day retention. Provider history is cached separately. Stored triggers preserve reasons. Portfolio writes compare a version number, preventing a stale request from overwriting another trade. Settlement removes a position from open state, so the same official payout cannot be credited twice.

Future streaming transport should enqueue normalized updates into the same persistence/scanner boundaries. A durable scheduled ingestion service must be added before claiming 24/7 observation. Context providers should enrich Game separately without changing market pricing math.

## Test commands
`node --experimental-strip-types --test tests/paper.test.ts`
`node node_modules/typescript/bin/tsc --noEmit`

Local development replay can use genuine captured official API responses when preview networking is unavailable. It must carry an explicit development replay label and remain gated out of production. Captures are not synthetic data and are not current quotes.

## V1 validation performed
- TypeScript checks and production build.
- Seven math/scanner tests: fee-inclusive budgets, walking price levels, missing depth, bid-based exits, threshold sensitivity, absent data, and complementary NO-side pricing.
- Official SDK live smoke calls: BBO/book/market metadata response envelopes matched documented shapes.
- Browser QA against explicitly labeled real API recordings: feed, chart, order book, paper buy/manual close, P/L and cash reconciliation, signal analytics, configurable threshold, and watchlist.
- Mobile QA in a real 390px iframe viewport; no fabricated data used.
- Preview's restricted outbound networking could not fetch the API directly. Production adapter uses public US API; the development recording import is compile-time gated out of production.
