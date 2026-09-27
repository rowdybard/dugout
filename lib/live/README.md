# Live (real-money) execution: built, tested, NOT wired

This folder is the real-money order path for Polymarket US. It is a library only. **No runner route, Sites route, script or scheduled job calls it**, and no trading keys are configured anywhere, so it cannot place an order.

## What it does

- **`client.ts`: a Workers-native signed REST client.**
  - It uses the official SDK's endpoints and Ed25519 signing, and its signatures match `@noble/ed25519` byte for byte.
  - It never retries. Timeouts and 5xx responses are marked as having an unknown outcome.
- **`state.ts`: account state and its rules.**
  - Hard caps in code: $25 per order, $100 open exposure, $50 daily loss, 500 orders a day.
  - Reconciles against official balances, positions and open orders.
  - Kill-switch rules: an unknown submission, repeated sync failures, a stale account, the daily loss limit, or exposure over the limit.
- **`executor.ts`: arming, ticking, disarming and killing.**
  - **Arming is read-only.** It checks the balance, positions and open orders, and previews a far post-only order to confirm the wire format. It never places an order.
  - **Orders are journaled before they're sent,** and a request with an unknown outcome is never retried: it cancels everything and halts.
  - **Every order passes the evidence gate again in live mode.** Taker entries require `PROVEN` evidence.
  - **Maker quotes are post-only GTC,** flagged `MANUAL_ORDER_INDICATOR_AUTOMATIC` as the exchange requires. A moved quote is cancelled, and its replacement waits until the old order has left the book.
- **`bridge.ts`: mirrors the paper bot.** Live only ever does what the running paper bot is doing on the same focused game.

Tests: `tests/live-client.test.ts` and `tests/live-executor.test.ts`, which run against an in-memory exchange (`tests/helpers/fake-exchange.ts`).

## What is deliberately not done

Connecting this to the Cloudflare runner (arm, disarm and kill routes, plus a live tick after each paper tick) was stopped by the coding agent's safety check on real-world financial transactions. That step is the owner's decision. It would need:

1. **Runner secrets:** `POLYMARKET_TRADING_KEY_ID` and `POLYMARKET_TRADING_SECRET_KEY`, set with `wrangler secret put` and never in Sites, plus `LIVE_TRADING_ENABLED=true`.
2. **Owner-only runner and Sites routes** to arm (pilot mode, lower limits), disarm and kill.
3. **The runner alarm** calling `executor.tick(liveTickFor(session, inputs, liveState, now))` after each paper tick. The alarm keeps running while armed, and a failed live step kills.
4. **A first pilot with the smallest limits,** watched live, on a CFB game that the paper bot is already quoting.

Two response fields are still unverified against the real account:
- whether `currentBalance` includes cash reserved for open orders (this affects the daily-loss equity figure);
- the sign convention of `netPosition` (the code uses only its absolute value).

Read both from a real account before arming.
