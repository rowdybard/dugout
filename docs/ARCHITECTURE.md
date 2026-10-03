# Dugout architecture

This describes the current source. Historical release and QA notes describe earlier milestones; their test counts, screenshots and deployment limitations are not the current operating contract.

## Application boundaries

| Component | Source | Responsibility |
| --- | --- | --- |
| Current dashboard | `app/page.tsx`, `components/tennis`, `components/tennis/use-tennis.ts` | Bot controls, focused game, both outcomes, charts, reasons, history and optional adviser |
| Site API (Cloudflare Worker) | `worker/cloudflare-entry.ts`, `app/api/tennis`, `lib/tennis/server.ts` | Access sign-in check, UI requests, bounded data reads, session routing, history and migration |
| Shared paper engine | `lib/tennis` | ATP/WTA/NFL/CFB normalization, price policy, football context gate, simulated execution, risk snapshots and shadow exits |
| Execution primitives | `lib/trading` | Decimal money, validated books, depth/fee simulation, source receipts and read-only market transport |
| Background service | `services/runner` | One SQLite Durable Object per allowed account: authoritative session, alarms, feeds, commands and transactional journal |
| Site/runner boundary | `lib/runner` | Signed requests, allow-lists, authority fence, migration, personal feed key, replay contracts and deterministic reducer |
| Site storage (D1) | `lib/server/storage.ts`, `db/schema.ts`, `drizzle` | D1 cache, existing paper archives, observations, migration staging/fence and adviser history |
| Optional Node bridge | `services/trading` | Read-only account/market stream proxy; not required by the Cloudflare runner |
| Retained research | `lib/bot`, `lib/market`, `services/paper-bot`, `research/mlb-elo`, `data` | Older MLB/NFL workflows, research and compatibility paths; not the current dashboard's strategy engine |

The naming `tennis` remains for the live-game engine after NFL/CFB support was added. Tennis infrastructure and historical journals remain intact. Older manual paper routes and source are retained for compatibility; they are not controls in the current dashboard. The app has no connected real-money order endpoint. A retained, unconnected live-adapter module is not authorization or an enabled execution path.

## Identity and authority

**Sign-in:** the site is a Cloudflare Worker behind Cloudflare Access with Google sign-in.
- **Token check:** `worker/cloudflare-entry.ts` verifies the Access JWT on every request (signature, audience, issuer, expiry).
- **Identity:** the account id is `u_` + a hash of the verified email. The Worker sets the internal identity header itself and refuses any copy a client sends.
- **Fails closed:** without valid Access settings everyone is refused, and Workers Builds will not build an unprotected site.

**Runner requests:** the site signs every request with `DUGOUT_RUNNER_SECRET`. The runner verifies it as `RUNNER_HMAC_SECRET`, together with owner, epoch, timestamp, nonce, method, URL and body hash. Redirects are rejected without forwarding signed credentials. The browser receives neither signing secrets nor provider keys. See [the runner README](../services/runner/README.md).

**Accounts and runners:**
- **Separate accounts:** every invited identity has its own D1 paper account.
- **Who gets a runner:** accounts allowed by `DUGOUT_RUNNER_USERS` (site) and `RUNNER_OWNERS` (runner) can move to their own runner instance (`idFromName(owner)`). `*` allows every invited account.
- **Migration:** freezes the account while flat, transfers the journal in hashed chunks, reconciles, and leaves it paused. After that, a runner outage never falls back to browser trading.
- **Owner extras:** the owner (`DUGOUT_OWNER_ID` = `RUNNER_OWNER_ID`) also gets the Claude adviser, the owner's stream keys and the all-games research sweep.
- **Personal key:** any account may store its own read-only Polymarket key, encrypted in its runner.

## Decision and execution path

The engine acts on validated inputs, not chart pixels. Entry and delayed fill checks require an executable book, depth, quantity/tick/fee metadata and configured price rules. The service enforces at most a two-cent spread and five-second book age. Both outcomes belong to one explicitly focused game; the runner does not choose another game automatically.

The `football-context-v1` policy adds a report quality gate, not a football win-probability model. Provider game identity, score, period, down/distance, possession and timestamps are validated. Old, incomplete, conflicting or mismatched reports block context-dependent entries. Adverse-context early exits are recorded as shadow comparisons; configured exits remain governed by the paper engine. Held positions retain their risk snapshot instead of silently widening their loss allowance when settings change.

Books and game reports have separate clocks. The compact football event request uses a verified event ID and full-game-winner filter and a bounded fresh-source request (3 s) in its own rate-limit lane, so a 429 on prices or the game list never silences reports. It has a three-second helper cache. The provider's event-state timestamp remains the report time; fetching again does not rejuvenate a stale play. A slow report does not hold up an existing position's book-based exit check. Metadata has a separate refresh clock. REST and WebSocket sources retain provenance; recorded development data cannot masquerade as current input.

When Polymarket omits drive details, an explicitly reviewed ESPN event mapping can supply possession, down, distance and the resulting field position. The initial mapping is Montana State–Idaho on October 2, 2026 (Polymarket 117784 / ESPN 401868094). Teams, home/away assignments and kickoff must agree. Polymarket still owns the clock, score, quarter, market status, prices and settlement. ESPN's latest play must belong to its current drive and agree with the Polymarket score and quarter. Kicks, scoring and possession transitions wait for a complete next-play state.

Each provider retains its own report and receipt timestamps, each at most 45 seconds old; report times must be no more than 15 seconds apart. Clock updates cannot refresh an old drive. ESPN reads have a ten-second cache and separate backoff. Dashboard, browser execution and runner execution use the same composition and validation functions. Invalid drive context blocks new buys, including resting fills and dip additions, while fresh Polymarket scoreboard facts can still trigger applicable exits. Last-known drive details retain their original source age and a waiting reason. Returning to complete Polymarket drive data resets entry confirmation without manufacturing a possession-change event.

The adapter starts a recovery alarm before external I/O. It schedules the next check 10 seconds later before kickoff with nothing held or pending, and 2.5 seconds later once a watched game is live or anything is held or pending. It can continue with the page closed when deployed, activated, running and healthy. This is not a scheduling or provider-latency guarantee. Confirmed game completion pauses entries while exits continue. Counted SQLite row writes reaching 90,000 in a UTC day also pause entries, while existing positions stay managed. It is a per-runner guard, not an account-wide platform quota.

## Persistence, evidence and optional AI

The Durable Object commits session changes, decisions, simulated fills/fees, shadow evidence and replay frames transactionally. Session ID, epoch and monotonic revision checks prevent stale requests from overwriting reset or control changes. Replay records exact normalized inputs by content hash, engine identity, action time and before/after state hashes. Exact replay begins at the migration checkpoint; imported older history retains its evidence limits. Export pagination completion and missing-observation completeness are separate checks.

Public-read pacing/backoff and completed D1 cache values survive individual requests. Cache writes use compare-and-swap, and no request's pending network promise is reused by another Worker request. Source failures remain visible rather than silently replacing fresh inputs with older records.

The optional Claude adviser lives in `app/api/tennis/advisor/route.ts`. Only an explicit Send action requests a model reply. Page loading, rule changes and bot ticks do not call it. Saved short notes, recent chat and a current account snapshot supply context. It cannot issue runner commands or modify rules. The source sets `claude-sonnet-5` in `lib/tennis/advisor.ts`; availability is an external runtime dependency. Internal allowance reservations and estimated costs are not an Anthropic balance or provider-enforced spending cap.

## Build and distribution

Use the pinned pnpm version, `pnpm install --frozen-lockfile`, then `pnpm test`, `pnpm runner:check`, `pnpm build` and `pnpm runner:build` from the root as appropriate. `runner:build` is a dry-run bundle. The web build goes through `scripts/run-framework.mjs`, Vinext/Vite and the vendored Sites plugin; `pnpm start` serves the generated Worker locally. `install:ci` is a managed Linux Bash installer, not the portable Windows setup command.

Distribute the complete source tree with the lockfile/workspace policy, shared libraries, both services, tests and fixtures, all Drizzle migrations and metadata, vendored plugin/styles and licenses, model/research artifacts, scripts, public assets and example configuration. `development-fixtures/us-api.json` is required by the development-only replay import and is historical data, not a live feed.

A source ZIP does not contain the remote D1 database or runner Durable Object account state. Account backup requires a separate saved-history export. Exclude dependency/build folders, local runtime databases, `.wrangler`, `.sites-runtime`, `.git`, credentials and secret environment files. The checked-in hosting project ID associates a Sites project; it is not portable authentication. A new deployment needs its own approved hosting configuration and server-side secrets. Never infer deployment success, live fills or profitability from a build or synthetic test pass.
