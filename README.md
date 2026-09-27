# Dugout

Dugout is a private sports **paper-trading** dashboard for listed Polymarket US ATP, WTA, NFL, and college-football winner markets. Choose a game to view, focus the bot on one game, and explicitly press Start. The shared engine evaluates both outcomes and allows at most one open position. It does not place real orders.

This project contains the React frontend, Sites-hosted HTTP backend and D1 schema/migrations, shared strategy and simulated execution code, and a separate Cloudflare Worker with a SQLite Durable Object for background operation. The word `tennis` remains in shared paths and types used by football too.

## Start here

- **[Strategy lab handoff](docs/STRATEGY-LAB-HANDOFF.md): read this first.** As of September 27, 2026, the project is rebuilding its strategy from historical data toward a real-money, context-driven decision engine. It holds the audit findings, decisions, data sources and the current checklist.
- [Decision engine](docs/DECISION-ENGINE.md): what the research permits, how the bot consults it, the bet checker, and the CFB favourite forward test.
- [Full bot and developer manual](docs/BOT-MANUAL.md): operation, actual rules, editing, troubleshooting, configuration and limitations.
- [Chad's getting-started guide](chad.md): plain-English customer instructions and access status.
- [Maintainer handoff](docs/MAINTAINER-HANDOFF.md): where things stand and what remains unverified.
- [Architecture](docs/ARCHITECTURE.md), [runner setup](services/runner/README.md), and [release evidence](docs/RELEASE-STATUS.md).
- [ZIP contents and restore notes](docs/DISTRIBUTION.md).
- [Documentation index](docs/README.md): current guides versus historical research/release notes.

## Current interface

Beginner mode is disabled in the active dashboard. A saved browser preference cannot re-enable it. The main view keeps bot controls, current decision, game selection/focus, live field/chart, quotes, balance and active-order/position information visible. Technical details and detailed history are expandable.

New accounts use the versioned **local decision engine**. It measures a price drop against prior quote noise, checks independently recovering buyer prices and available depth, and subtracts spread, fees and a delay allowance before considering entry. Held positions use frozen entry evidence, a ratcheting volatility buffer and setup-invalidation checks within the original loss/time bounds. These are deterministic local calculations, not AI calls, a win probability or a proven profit forecast. **Decision details** exposes the measurements behind the plain-language reason.

Start/Resume explicitly saves the new policy for an older account before starting. It preserves stake, cash, journal, rest and loss/time settings, while requiring at least 30 seconds/10 quotes and retaining the 2¢/5-second entry limits. Historical configurations without the new version field keep their legacy reducer behavior for replay; existing positions retain their entry-time exit policy.

Selecting a game changes the chart. **Focus bot on this game** changes future entry eligibility. **Pause** prevents entries and continues exits; **Stop** requests an exit and waits for executable conditions. A simulated order is not guaranteed to fill. The full manual describes these distinctions.

The bot focuses on the whole game, never a user-selected team. **Compare both teams** shows each side's latest saved decision. Chart-side selection affects viewing only. **Accepted bot quote**, **Bot game report**, and **Runner update** have separate clocks; chart refreshes and rejected book arrivals cannot make the bot's accepted book appear fresh.

Football field reports and executable books have separate timestamps. A successful check can return an old play report. New football entries under the context policy need verified context within 45 seconds. Runner entries enforce a spread no wider than 2 cents and book age no older than 5 seconds. These are eligibility checks, not a profit guarantee.

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

The current dashboard is [owner-private on Sites](https://dugout-signals.rowdybard.chatgpt.site/). `.openai/hosting.json` records that existing project's binding names and project ID; it does not grant access. The background runner has its own `services/runner/wrangler.jsonc`.

The Sites backend signs commands to the runner. The browser receives neither the signing secret nor a choice of runner owner. Migrated accounts are fenced against the old database writer; a runner outage does not turn browser trading back on. Preserve the existing Durable Object namespace and journal when updating a deployment.

Private invited visitors use their own hosting identity and separate paper balance/history. Their browser bot requires the tab to remain open and visible. Background setup and the paid Claude adviser are restricted to the server-configured `DUGOUT_OWNER_ID`, which must match the Worker's `RUNNER_OWNER_ID`. A missing pin disables new setup and adviser access; existing runner fences and exit management remain intact. A customer invitation and complete customer run still need end-to-end verification.

`.env.example` lists configuration names with blank secret values. Configure actual secrets in the appropriate runtime/secret manager. Copying the source does not copy Cloudflare databases, grant login access, or restore an account. See the manual before setting up a different owner/deployment.

Claude is an optional chat adviser. Model requests occur only through an explicit chat Send; Claude does not make automatic bot decisions, change rules or place orders. Model availability and provider billing must not be inferred from the hardcoded model string or the application's cost estimate.

## Verified limits

The Cloudflare runner was deployed and the existing account migrated while paused. Recorded journal reconciliation retained cash **93.93805**, 19 historical fills and 4.11 in execution fees on September 26, 2026. Those are dated evidence, not a promise of the current account balance.

Report-refresh changes were checked against live read-only data. **A 60-minute run of the new Cloudflare runner with the dashboard closed, and a genuine automatic entry/exit under that runner, remain unverified.** Older paper fills and synthetic tests do not establish that milestone or a profitable strategy. No paid plan was enabled for the runner. Its quota estimates are not exact Cloudflare billing counters.
