# Dugout architecture

This describes the current source. Historical release and QA notes describe earlier milestones; their test counts, screenshots and deployment limitations are not the current operating contract.

## Application boundaries

| Component | Source | Responsibility |
| --- | --- | --- |
| Current dashboard | `app/page.tsx`, `components/tennis`, `components/tennis/use-tennis.ts` | Bot controls, focused game, both outcomes, charts, reasons, history and optional adviser |
| Sites API | `app/api/tennis`, `lib/tennis/server.ts` | Authenticated UI requests, bounded data reads, session routing, history and migration |
| Shared paper engine | `lib/tennis` | ATP/WTA/NFL/CFB normalization, price policy, football context gate, simulated execution, risk snapshots and shadow exits |
| Execution primitives | `lib/trading` | Decimal money, validated books, depth/fee simulation, source receipts and read-only market transport |
| Background service | `services/runner` | One owner's authoritative session in a SQLite Durable Object, alarms, native feeds, commands and transactional journal |
| Sites/runner boundary | `lib/runner` | Signed requests, authority fence, migration, replay contracts and deterministic reducer |
| Sites storage | `lib/server/storage.ts`, `db/schema.ts`, `drizzle` | D1 cache, existing paper archives, observations, migration staging/fence and adviser history |
| Optional Node bridge | `services/trading` | Read-only account/market stream proxy; not required by the Cloudflare runner |
| Retained research | `lib/bot`, `lib/market`, `services/paper-bot`, `research/mlb-elo`, `data` | Older MLB/NFL workflows, research and compatibility paths; not the current dashboard's strategy engine |

The naming `tennis` remains for the live-game engine after NFL/CFB support was added. Tennis infrastructure and historical journals remain intact. Older manual paper routes and source are retained for compatibility; they are not controls in the current dashboard. The app has no connected real-money order endpoint. A retained, unconnected live-adapter module is not authorization or an enabled execution path.

## Identity and authority

The UI is hosted behind Sites' owner-private authentication. The runner boundary requires the trusted `oai-authenticated-user-id` header and does not invent an owner. Other legacy helpers retain a `private-owner` fallback, so exposing the web app directly without the trusted outer authentication boundary is unsupported. This release does not add Google OAuth or Cloudflare Access to the frontend.

Sites signs server-to-server requests using `DUGOUT_RUNNER_SECRET`; the Worker verifies the same value as `RUNNER_HMAC_SECRET`, plus owner, epoch, timestamp, nonce, method, URL and body hash. Redirects are rejected without forwarding signed credentials. The browser receives neither signing secrets nor provider keys. See [the runner README](../services/runner/README.md) for the exact protocol and configuration.

An owner without a runner fence uses the retained browser-driven session path. Migration first freezes that owner's Sites session while flat and inactive, then transfers the full active journal and referenced observations through resumable hashed chunks. Activation reconciles cash and execution records, stores a replay checkpoint, and leaves the session paused or stopped. An explicit user command starts it. Sites keeps the source archive read-only. An unavailable runner or failed migration never falls back to browser trading after a fence exists.

The native runner currently permits exactly one configured `RUNNER_OWNER_ID`. Inviting another authenticated Sites identity creates that identity's separate D1 paper account; it does not grant access to the first owner's account or automatically provision a background runner. Until a supported per-customer runner arrangement exists, the invited account uses browser-owned checks and requires the page to remain active. This is not yet multi-customer background hosting.

Sites uses a matching server-only `DUGOUT_OWNER_ID` pin to gate background setup/migration and paid adviser access. Unauthorized migration commands fail before any pause, fence or history transfer. Guest UI hides those unavailable controls; adviser reads reveal only disabled capability flags. A missing pin disables new setup and adviser access, while existing runner fences and normal session/exit management remain intact.

## Decision and execution path

The engine acts on validated inputs, not chart pixels. Entry and delayed fill checks require an executable book, depth, quantity/tick/fee metadata and configured price rules. The service enforces at most a two-cent spread and five-second book age. Both outcomes belong to one explicitly focused game; the runner does not choose another game automatically.

The `football-context-v1` policy adds a report quality gate, not a football win-probability model. Provider game identity, score, period, down/distance, possession and timestamps are validated. Old, incomplete, conflicting or mismatched reports block context-dependent entries. Adverse-context early exits are recorded as shadow comparisons; configured exits remain governed by the paper engine. Held positions retain their risk snapshot instead of silently widening their loss allowance when settings change.

Books and game reports have separate clocks. The compact football event request uses a verified event ID and full-game-winner filter, a bounded fresh-source request and three-second helper cache. The provider's event-state timestamp remains the report time; fetching again does not rejuvenate a stale play. A slow report does not hold up an existing position's book-based exit check. Metadata has a separate refresh clock. REST and WebSocket sources retain provenance; recorded development data cannot masquerade as current input.

The adapter starts a recovery alarm before external I/O and schedules the next check about 2.5 seconds after work finishes. It can continue with the page closed when deployed, activated, running and healthy. This is not a scheduling or provider-latency guarantee. Confirmed game completion pauses entries while exits continue. A persisted estimate at 75,000 daily row/alarm writes also pauses entries, reserving management of existing positions; it is not an account-wide platform quota guarantee.

## Persistence, evidence and optional AI

The Durable Object commits session changes, decisions, simulated fills/fees, shadow evidence and replay frames transactionally. Session ID, epoch and monotonic revision checks prevent stale requests from overwriting reset or control changes. Replay records exact normalized inputs by content hash, engine identity, action time and before/after state hashes. Exact replay begins at the migration checkpoint; imported older history retains its evidence limits. Export pagination completion and missing-observation completeness are separate checks.

Public-read pacing/backoff and completed D1 cache values survive individual requests. Cache writes use compare-and-swap, and no request's pending network promise is reused by another Worker request. Source failures remain visible rather than silently replacing fresh inputs with older records.

The optional Claude adviser lives in `app/api/tennis/advisor/route.ts`. Only an explicit Send action requests a model reply. Page loading, rule changes and bot ticks do not call it. Saved short notes, recent chat and a current account snapshot supply context. It cannot issue runner commands or modify rules. The source sets `claude-sonnet-5` in `lib/tennis/advisor.ts`; availability is an external runtime dependency. Internal allowance reservations and estimated costs are not an Anthropic balance or provider-enforced spending cap.

## Build and distribution

Use the pinned pnpm version, `pnpm install --frozen-lockfile`, then `pnpm test`, `pnpm runner:check`, `pnpm build` and `pnpm runner:build` from the root as appropriate. `runner:build` is a dry-run bundle. The web build goes through `scripts/run-framework.mjs`, Vinext/Vite and the vendored Sites plugin; `pnpm start` serves the generated Worker locally. `install:ci` is a managed Linux Bash installer, not the portable Windows setup command.

Distribute the complete source tree with the lockfile/workspace policy, shared libraries, both services, tests and fixtures, all Drizzle migrations and metadata, vendored plugin/styles and licenses, model/research artifacts, scripts, public assets and example configuration. `development-fixtures/us-api.json` is required by the development-only replay import and is historical data, not a live feed.

A source ZIP does not contain remote Sites D1 or runner Durable Object account state. Account backup requires a separate saved-history export. Exclude dependency/build folders, local runtime databases, `.wrangler`, `.sites-runtime`, `.git`, credentials and secret environment files. The checked-in hosting project ID associates a Sites project; it is not portable authentication. A new deployment needs its own approved hosting configuration and server-side secrets. Never infer deployment success, live fills or profitability from a build or synthetic test pass.
