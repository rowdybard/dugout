# Dugout paper runner

This Worker owns one account's authoritative paper session in a SQLite Durable Object. The Sites application stays the authenticated UI and signs server-to-server runner requests. The Worker has no real-order route or paid model client. It is independent of the optional Node stream bridge in `services/trading`.

The WebSocket handshake has a three-second deadline which is cleared after upgrade; it must not close a healthy long-lived connection. Full-book subscriptions request `responsesDebounced: false`. REST arrivals still pass provider ordering and freshness validation. Runtime quote age comes from accepted session evidence, never merely the most recently received input. Focus selects a game; the shared reducer evaluates both outcomes.

This directory is part of the full repository, not a standalone install. Its imports depend on shared `lib` sources. Keep the repository lockfile and shared sources when distributing it. See [the architecture](../../docs/ARCHITECTURE.md) for application boundaries.

## Configuration

Worker name: `dugout-paper-runner`. Namespace binding: `PAPER_RUNNERS`, class `OwnerPaperRunner`, SQLite migration tag `v1`.

The runner authorizes `RUNNER_OWNER_ID` plus the optional allow-list `RUNNER_OWNERS` ("*" for every account the site signs requests for, or a comma list of account ids; lib/runner/owners.ts). Each account gets its own Durable Object instance (`idFromName(owner)`), so accounts never share state. The site offers background setup to `DUGOUT_OWNER_ID` plus `DUGOUT_RUNNER_USERS`, and sends the owner's Polymarket stream credentials only to the owner's runner. It is meant for a small invited group, not a public service. Accounts not on the allow-list keep a browser-run bot. Never reuse the owner's identity for someone else.

| Location | Setting | Required value |
| --- | --- | --- |
| Worker variable | `RUNNER_OWNER_ID` | Unchanged, trusted Sites owner ID; not an email address |
| Worker variable | `RUNNER_ENGINE_VERSION` | Exact shared-engine commit/build identifier for replay provenance |
| Worker secret | `RUNNER_HMAC_SECRET` | Random signing secret; generate at least 32 random bytes |
| Sites server secret | `DUGOUT_RUNNER_SECRET` | Same value as the Worker's `RUNNER_HMAC_SECRET` |
| Sites server setting | `DUGOUT_RUNNER_URL` | HTTPS runner origin, without a path or query |
| Sites server setting | `DUGOUT_OWNER_ID` | Same trusted ID as `RUNNER_OWNER_ID`; gates migration/setup and paid adviser access |

**Deploy from GitHub (Cloudflare Workers Builds).** Connect the `dugout-paper-runner` Worker to the repo and use these settings. Every push to `main` then redeploys the runner, so it stays in step with the site.
- **Root directory:** the repo root.
- **Build command:** leave it empty. `pnpm run build` builds the site instead and stops on the site's settings check.
- **Deploy command:**
  ```
  npx wrangler deploy --config services/runner/wrangler.jsonc --var RUNNER_OWNER_ID:u_... --var "RUNNER_OWNERS:*" --var RUNNER_ENGINE_VERSION:$WORKERS_CI_COMMIT_SHA
  ```
- **Secret:** set `RUNNER_HMAC_SECRET` once under Settings → Variables and Secrets.

The checked-in Wrangler file leaves the owner blank and build ID as `pending-build`. Configure both for deployment. The protocol rejects secrets shorter than 32 characters, and absent owner authorization fails closed. The build ID is provenance and must be set accurately by the release process. Never put secrets or provider credentials in browser variables. Cloudflare deployer credentials belong in deployment tooling, not the Sites application or ZIP.

Sites checks `DUGOUT_OWNER_ID` before migration commands can pause or fence an account. Other authenticated visitors receive a disabled setup capability and keep their independent browser-mode session; they must keep the page open and visible. Missing owner configuration disables setup and adviser access. It does not change an existing writer fence or silently return a migrated account to browser trading.

**Optional research recording.** If the Worker has an R2 binding named `LAKE`, every accepted order book (top 10 levels a side, plus game status) is written in batches, about once a minute, under `<LAKE_PREFIX>/live-books/date=YYYY-MM-DD/league=<league>/<slug>/` (`lib/datastore/recorder.ts`). This is the depth data that resting-order research needs, and price history doesn't have it.
- **Turning it on:** the binding is deliberately not in `wrangler.jsonc`, because a deploy fails if the named bucket doesn't exist. After creating the bucket (see `docs/DATA-PLATFORM.md`), add `"r2_buckets": [{"binding": "LAKE", "bucket_name": "<your bucket>"}]`, and optionally the variable `LAKE_PREFIX` (default `dugout`).
- **Safety:** recording is read-only and never delays the paper step. Without the binding, nothing is recorded.

Provider stream credentials are transferred by the authenticated Sites server to `POST /v1/feed-credentials` after migration start. The body is `{keyId,secretKey}`. They are encrypted using AES-256-GCM with a random nonce; HKDF derives the encryption key from the signing secret using a distinct purpose and owner/epoch binding. Only ciphertext reaches SQL. Exports, responses and logs exclude credentials. Rotating the signing secret requires retransferring feed credentials. Missing credentials leaves the strict REST fallback available.

## Signed interface

All endpoints require the `signRunnerRequest` helper in `lib/runner/protocol.ts`. Its canonical UTF-8 input, newline joined without a trailing newline, is:

```
DUGOUT-RUNNER-V1
METHOD
pathname+query
sha256hex(exact UTF-8 request body)
owner
timestamp in milliseconds
nonce
epoch
```

The signature is base64url HMAC-SHA256. Headers are `x-dugout-owner`, `x-dugout-epoch`, `x-dugout-timestamp`, `x-dugout-nonce`, and `x-dugout-signature`. Clock skew is limited to 30 seconds; used nonces remain persisted for 65 seconds. Retrying a command uses a fresh nonce and the original command ID. A duplicate command ID with changed instructions fails. Duplicate identical commands return the current state without applying again.

| Endpoint | Purpose |
| --- | --- |
| GET `/v1/state` | Current session and background/source health |
| POST `/v1/command` | `{command: TennisAction}`; start, resume, pause, stop, reset, update-rules only |
| POST `/v1/migration/start` | `{manifest,session}`; inert staging |
| POST `/v1/migration/chunk` | `{migrationId,index,data}`; `data` is the exact hashed JSON string |
| GET `/v1/migration/status?migrationId=...` | Received chunk indexes |
| POST `/v1/migration/activate` | `{migrationId}`; atomic activation, no automatic resume |
| POST `/v1/feed-credentials` | Encrypted private feed credential transfer |
| GET `/v1/export?exportId=...&after=...&limit=250` | Frozen, paginated full journal export |

Start/resume requires one `focusSlug`. The runner never falls back to another match. Spread and book freshness cannot exceed 2 cents and 5 seconds. The shared strategy, fees, delayed-fill simulator, position risk snapshots and context policy remain in `lib/tennis`; this package does not substitute another strategy.

## Cutover

1. Freeze Sites writes using an owner/epoch fence while entries are inactive and there are no open positions or pending orders. Preserve the full source snapshot and source revision.
2. Hash the exact `JSON.stringify(session)` and every chunk's UTF-8 bytes. Import the complete active session journal and every observation referenced by decisions, executions and shadow exits. Retrying identical chunks is safe.
3. Activation verifies all hashes/counts, every reference, six-decimal cash and closed-position reconciliation, and exact agreement between snapshot ledger entries and imported execution rows. It records the full source snapshot and the resulting checkpoint atomically. A stopped source remains stopped; idle/paused sources become paused. Activation does not schedule an alarm.
4. Switch the Sites authority fence only after verifying the imported session. Archive source history read-only. A user must explicitly resume or reset/start afterward. Do not restore browser ticks after activation.

Chunks are at most 250,000 UTF-8 bytes and 2,000 rows each. The manifest allows at most 2,000 chunks, 64 MB total bytes, and 250,000 journal and observation rows each. Validation reads bounded batches. Missing legacy evidence blocks activation rather than inventing observations.

## Runtime and evidence

Alarms target a 2.5-second interval after each completed check. A recovery alarm is persisted before external requests; platform scheduling/network delay is possible. Pause leaves exit checks active for held positions; stopped/paused flat sessions close the provider stream and delete the alarm. A fresh confirmed end of the focused game pauses new entries. Revision, session ID and epoch compare-and-swap prevents stale network work from overwriting controls or a reset account.

The provider transport uses the official read-only market WebSocket and existing strict parser. REST books retain request/receipt timestamps, provider timestamps and cache provenance. A heartbeat never renews a book receipt. A newly fetched, verified uncached REST snapshot can contain an older last-transaction timestamp when the book has not changed; that source timestamp is retained rather than rewritten.

Football uses `lib/tennis/priority-context.ts` and `lib/trading/fresh-event.ts`: a verified numeric event ID selects a compact `/v1/events?id=...&sportsMarketTypes=football_team_full_game_winner` response. A per-read `dugout_read` nonce and `cache: no-store` request a new source check; only `MISS`, `BYPASS`, or `DYNAMIC` with zero/absent cache age is accepted. The provider's report timestamp remains authoritative: a fresh HTTP receipt cannot make an old play fresh. The helper has a 3-second cache and 2-second request limit. The context policy still rejects reports older than 45 seconds and incomplete down/distance identity. It does not estimate win probability.

Reports and connection setup run alongside books using platform `waitUntil`. Held exits wait only for their book; pending/new entries wait for the bounded report check. Tennis keeps its verified 15-second event context cache. Initial discovery uses shared resumable 20-event pagination, so a focus can be beyond the first page. Fee/tick/size metadata has its own 60-second refresh clock, independent of context receipt age. HTTP 429 backoff survives reconstruction. Bounded response sizes and deadlines reject failed feeds rather than substituting recorded data.

Confirmed final context is returned separately when a final book is unavailable, so a completed game still records an automatic pause. That lifecycle cause and verified context are preserved in the control/replay journal. Existing exits continue. Starting/resuming without an explicit duration clears the old browser observation window, with that transition recorded in the replay frame; the service then runs until the focused game ends, a user pauses/stops it, or a safety limit pauses entries.

SQL cursor row-write counts and alarm writes feed a persisted UTC-day estimate. At 75,000 estimated writes, new entries pause while existing exits remain managed. Start/resume cannot bypass that pause. This is an account-local estimate, not a hard guarantee against Cloudflare account-wide limits; other Workers, reads, duration and other quotas still apply. No billing plan upgrade occurs automatically.

Every committed action and tick—including no-input ticks—records exact inputs by content hash, engine/build identity, timestamp, source failures and before/after state hashes in the same transaction as session and journal changes. Reset IDs are captured as replay entropy. `lib/runner/replay.ts` reproduces frames from the initial migration checkpoint. Older imported histories retain their original evidence limitations and are not presented as exact whole-strategy replay.

An export ID fixes the account snapshot and journal boundary for 24 hours. `complete` means all pages were read. Check each page's `missingObservationIds` and `pageEvidenceComplete` separately; exact replay starts at `migration-checkpoint`. New decision/execution/shadow rows link `runnerFrameId` and `runnerInputIds` instead of ambiguously resolving inputs by book timestamp alone. Credentials are never included.

## Local verification

From the repository root, with Node 24 and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
node --experimental-strip-types --test services/runner/tests/*.test.ts
pnpm runner:check
pnpm runner:build
```

`runner:build` is a Wrangler dry run and writes to `outputs/runner-build`; it does not publish or start a session. Use `pnpm test` for the complete shared-engine, Sites migration, and service test suite. Deployment separately requires Cloudflare authorization, the SQLite Durable Object binding/migration, configured server secrets and matching Sites proxy release. The runner has no D1 binding; Sites' archive and migration do.

Tests use synthetic fixtures and mocked transport/runtime, including SQLite rollback, signature tampering, nonce replay, encrypted credentials, handoff integrity, command races, delayed paper buy/sell replay and fees, reset replay, export boundaries, native source freshness, focus persistence, alarm recovery and concurrent pause. They do not establish a live automatic strategy entry/exit. The source package does not certify a deployment's configuration or health. Confirm actual health and journal evidence separately; a genuine automatic entry and exit on a live game is required to claim that milestone.

## Source package versus account backup

The ZIP includes implementation, fixtures and migrations, not the owner's remote Durable Object/D1 databases or private provider keys. Preserve a saved-history export separately when backing up an account. Exclude `.wrangler` state, `.dev.vars`, `.env` secrets, build output, `node_modules`, and credentials. A new deployment from source does not recover a previous balance/journal and must not silently start trading.
