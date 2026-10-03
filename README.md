# Dugout

Dugout is a private sports **paper-trading** dashboard for Polymarket US markets, currently focused on **college football**. Pick a game, choose Steady or Bold, and press Start. The bot trades with fake money only and places no real orders.

It runs on Cloudflare:
- **The site:** a Worker behind Cloudflare Access with Google sign-in, using a D1 database. Each invited person gets their own paper account.
- **The background runner:** a separate Worker with one SQLite Durable Object per person, so a bot keeps running with the tab closed.

Shared strategy and simulated execution code serve both. The word `tennis` remains in shared paths and types, which also serve football.

## Start here

- **[Strategy lab handoff](docs/STRATEGY-LAB-HANDOFF.md): read this first.** As of September 27, 2026, the project is rebuilding its strategy from historical data toward a real-money, context-driven decision engine. It holds the audit findings, decisions, data sources and the current checklist.
- [Decision engine](docs/DECISION-ENGINE.md): what the research permits, how the bot consults it, the plugs for new research, the bet checker, and the CFB favourite forward test.
- [Data platform](docs/DATA-PLATFORM.md): where the research data lives (R2 plus DuckDB), how to search it, and how research streams into the engine.
- [Full bot and developer manual](docs/BOT-MANUAL.md): operation, actual rules, editing, troubleshooting, configuration and limitations.
- [Chad's getting-started guide](chad.md): plain-English instructions for invited users.
- [Cloudflare hosting](docs/CLOUDFLARE-HOSTING.md): deploying the site and runner, Google sign-in, secrets.
- [Maintainer handoff](docs/MAINTAINER-HANDOFF.md): where things stand and what remains unverified.
- [Architecture](docs/ARCHITECTURE.md), [runner setup](services/runner/README.md), and [release evidence](docs/RELEASE-STATUS.md).
- [ZIP contents and restore notes](docs/DISTRIBUTION.md).
- [Documentation index](docs/README.md): current guides versus historical research/release notes.

## Current interface

The page shows only what's needed to run the bot:
- **Search box:** live and upcoming college games.
- **Bot card:**
  - **Steady / Bold**, balance, and **Reset balance** ($5–$10,000, any time; open paper trades are dropped).
  - **Start / Pause / Resume / End run / New run**.
  - A plain-English **status box** with a **Both sides** line per team.
  - **Open orders & shares:** every resting offer and holding, across the main game and the Octopus's arms.
- **Game tracker:** score, clock and field drawing from Polymarket game reports.
- **Trades & balance:** the ledger and balance chart.

**Settings & history** holds the rules, background runner setup, the optional personal Polymarket key, the Decision engine card, diagnostics and downloads.

**How the bot trades:** it runs on the **evidence-gated decision engine** ([docs/DECISION-ENGINE.md](docs/DECISION-ENGINE.md)). Its main activity is paper market making: resting buy offers on both teams, with conservative fills and maker rebates. A completed pair pays $1 at settlement.
- **Steady:** resting offers only, about 5% of the balance each. After a one-sided fill it tries to complete the pair, and sells the unpaired shares after 10 minutes.
- **Bold:** offers at 12% of the balance (at most $50), plus the hold-to-final bets the evidence allows. After a one-sided fill it takes its profit at 5¢ up (completing the pair at that price, or selling). It buys once more on a 5¢ dip, capped at 2× the order size, and sells if the price then falls 10¢ below its average.
- **The Octopus** (experimental, either mode): the same offers on up to 6 extra games. Games can be pinned, or picked automatically every 5 minutes (calm, liquid college games). All resting offers together stay within 50% of the balance, with the main game first. Each event is logged as one short JSON line, written to tiny log files.
- **When offers come down:** for 30 s after each live play, and whenever the game report is older than 45 s. The engine refuses losing or untested bets.
- **Not AI:** these are deterministic calculations, not AI calls or a profit forecast. Real money is not connected (`lib/live/README.md`).

## Local development

The package declares Node `>=22.13.0`; this release was checked with Node **24.20.0** on Windows. The pinned package manager is **pnpm 11.25.0**, with `pnpm-lock.yaml` and installation policy in `pnpm-workspace.yaml`.

With that pnpm version installed, from the project directory:

```sh
pnpm install --frozen-lockfile
pnpm build
```

An empty local D1 database needs the SQL files in `drizzle/` applied once, in filename order, before the data-backed app can work. Build first to generate `dist/server/wrangler.json`. For each not-yet-applied file:

```sh
pnpm exec wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_black_the_santerians.sql
```

Replace the filename with each subsequent migration; do not replay an already applied migration against a populated database. Local migrations do not change the hosted database.

```sh
pnpm dev
```

Portable development starts at port 5173 unless overridden. Use the address printed by the server. Its loopback-only mock sign-in route is `/signin-with-chatgpt?return_to=/`; it creates a local development identity, not the hosted owner's account. Mock auth is not included in production. Hosted routes rely on the hosting platform's authenticated identity headers.

No checkout-local execution profile is included in a source ZIP. `scripts/execution-profile.mjs` defaults such a checkout to `portable`. The existing `install:ci` script is a **managed Linux Bash installer**, with `flock` and GNU `timeout` requirements; it is not the Windows installation command. A fresh dependency installation from the distributed ZIP has not been separately validated; release checks used the installed checkout dependencies.

## Commands

| Command | Actual purpose |
| --- | --- |
| `pnpm dev` | Portable Vinext development server; managed profile uses Vite |
| `pnpm build` | Production frontend and Sites backend build |
| `pnpm start` | Local preview of the built Worker using local D1; does not deploy |
| `pnpm test` | Root, stream-service and runner tests |
| `pnpm exec tsc --noEmit` | Main TypeScript check |
| `pnpm runner:check` | Runner TypeScript check |
| `pnpm runner:build` | Dry-run runner bundle; does not deploy |
| `pnpm lint` | Repository-wide lint; see limitations in release evidence |
| `pnpm trading:stream` | Optional separate read-only Node streaming service |
| `pnpm db:generate` | Generate Drizzle migrations after schema changes |

## Hosting and credentials

The site and the runner are deployed from GitHub with Cloudflare Workers Builds; every push to `main` redeploys both. [docs/CLOUDFLARE-HOSTING.md](docs/CLOUDFLARE-HOSTING.md) has the build variables, deploy commands and secrets, and [services/runner/README.md](services/runner/README.md) covers the runner.

**Sign-in:** Cloudflare Access with Google sign-in and an invite list. The site verifies the Access token on every request and derives a stable account ID from the email. The build refuses to produce an unprotected site on Workers Builds.

**Background runners:**
- **Who may use one:** `DUGOUT_RUNNER_USERS` (site) and `RUNNER_OWNERS` (runner) say which accounts may have one (`*` for all invited accounts). Each gets its own Durable Object instance.
- **Signed commands:** the site signs every command with `DUGOUT_RUNNER_SECRET`, which equals the runner's `RUNNER_HMAC_SECRET`. The browser never sees the secret.
- **Owner extras:** `DUGOUT_OWNER_ID` marks the owner, who gets the Claude adviser, the owner's Polymarket keys and the all-games research sweep.
- **Personal key:** anyone can add their own read-only Polymarket key for live prices. It is checked, stored encrypted in their runner, and never returned.

`.env.example` lists configuration names with blank values. Put real values in the Cloudflare dashboard (as Secrets) or `wrangler secret put`, never in the repository.

Claude is an optional chat adviser for the owner. It makes no automatic decisions, changes no rules and places no orders.

## Verified limits

- **Tested:** the strategy code has a full automated test suite. The site and runner were exercised locally in a browser and run live on Cloudflare during October 2–3, 2026.
- **Not proven:** no strategy is proven profitable. Paper fills are conservative simulations and do not establish real execution or queue position.
- **Free-plan limits:**
  - Each request gets 10 ms of CPU, and requests over it return a plain 503. The site avoids re-parsing large runner state to stay under it.
  - D1 allows 100,000 rows written a day. Game-list caching was cut about 20×.
  - Durable Objects also have a daily write allowance. The runner checks every 10 s before kickoff and every 2.5 s live, and pauses new entries at 90,000 rows a day.
  - The Workers Paid plan ($5/month) removes these as practical concerns.
