# Dugout source handoff

Exported September 25, 2026 from application revision `35f6b1681364b0f0206e843494fa6d0b46fdd87f`. This public repository starts fresh history and excludes credentials, deployed database contents, local caches, and generated build output. Export changes are limited to setup documentation and ignore rules.

## What is implemented

- MLB/NFL market discovery and normalization using Polymarket US, beginner explanations, charts, scanner observations, watchlists, and paper portfolio views.
- A bot-first home, paper entry/exit controls, editable amount presets, and experimental strategy gates. Observations are not proven trading advantages.
- Authenticated market WebSocket ingestion in the Worker, forwarded to the browser using SSE. Stream books are cached in D1 with freshness and connection-generation checks. This market connection was observed working in the private hosted deployment.
- A separate optional Node streaming service under `services/trading/`; its deployment and private-account reconciliation are distinct from the verified Worker market stream.
- Browser-driven bot evaluation approximately every five seconds while visible. Closing the page does not leave an always-on trading runner operating.
- Explicit sports-source errors and retry cooldowns: HTTP 403 backs off for at least five minutes, HTTP 429 respects Retry-After with a minimum cooldown, and other transient failures use a shorter cooldown.

Real-money execution is disabled in the application. An adapter and tests exist as integration groundwork. Connecting API keys alone does not activate real-money trading.

## Remaining blocker

The last deployed NFL sports-context check returned **HTTP 403 Access Denied** from ESPN's scoreboard endpoint. This prevents the bot from obtaining the required live game context and passing its entry checks. Provider streaming and sports context are separate connections: a working Polymarket stream does not fix the ESPN rejection.

Source errors are surfaced, persisted, and cooled down. The error handling is implemented; the upstream denial is not resolved. Own-account Cloudflare deployment and an independent, always-on runner have not been verified. No reliable live profit claim is supported by the existing paper experiments or historical research.

## Local setup

1. Install Node.js 22.13 or newer and `pnpm@11.25.0`, as pinned in `package.json`.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm test` and `pnpm run build`. The build generates `dist/server/wrangler.json` for the local Worker/D1 tooling.
4. On a new local database, run each migration once, in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_black_the_santerians.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_silky_hammerhead.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_huge_aqueduct.sql
```

5. Run `pnpm dev` and open the loopback URL printed by the server (default port 5173). The portable development profile offers a mock local sign-in at `/signin-with-chatgpt?return_to=/`.

The checked-in `install:ci` script is a managed Linux helper; use the ordinary pnpm install command for a standalone checkout. Do not use `npm ci`: there is no `package-lock.json`.

## Credentials and deployment

Use `.env.example` as a list of configuration names, not as an automatic credential loader. Configure secrets through the server runtime. `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY` belong on the server; never prefix them with client-exposed environment-variable names. The optional standalone service additionally uses `TRADING_SERVICE_URL` and `TRADING_SERVICE_TOKEN` for the web app's authenticated internal connection. See [its setup guide](../services/trading/README.md).

The original application uses a private Sites access boundary, a Cloudflare Worker, and a D1 binding named `DB`. `.openai/hosting.json` identifies that existing Site; it does not provision a separate account's deployment. `vite.config.ts` uses a placeholder local database ID. A standalone Cloudflare deployment needs its own real Worker/D1 configuration and migrations. If using the optional separate streaming service, the web proxy requires an HTTPS `TRADING_SERVICE_URL`.

Before exposing a standalone deployment, implement a trusted authentication boundary for all account and write routes. Existing code trusts dispatch-injected `oai-authenticated-user-id` headers and includes a `private-owner` fallback for the private deployment. Direct public callers must not be able to supply trusted identity headers or share this fallback identity. Public source-code visibility does not change the hosted application's access policy.

The Git repository does not include the original bankroll, positions, snapshots, provider secrets, or Cloudflare credentials. Research datasets and development fixtures are included as labeled research/test inputs; they are not live production market data.

## Validation at export

The preceding full suite passed 190 tests. After the latest source-error/cooldown change, 24 targeted tests passed, including four new source-reader tests. A new full-suite run was not performed as part of the source export. Earlier QA screenshots and release notes are historical evidence, not proof that every external provider is currently reachable.

## Code map

| Area | Location |
| --- | --- |
| UI and routes | `app/`, `components/dugout/` |
| Bot evaluation and context gates | `lib/bot/` |
| Worker market streaming and storage | `lib/server/` |
| Execution abstractions and stream contracts | `lib/trading/` |
| Sports source handling | `lib/sports-context/` |
| Optional Node stream service | `services/trading/` |
| D1 schema changes | `drizzle/` |
| Tests and explicitly labeled fixtures | `tests/`, `development-fixtures/` |
| Historical MLB experiments | `research/mlb-elo/` |

See [API research](API-RESEARCH.md), [architecture](ARCHITECTURE.md), and [trading implementation](TRADING-IMPLEMENTATION.md) for further background.
