# Dugout paper runner

This Worker owns one account's authoritative paper session in a SQLite Durable Object. The Sites application stays the authenticated UI. Only the Sites server can sign runner requests. It has no real-order route or paid model client.

## Configuration

Worker name: `dugout-paper-runner`. Namespace binding: `PAPER_RUNNERS`, class `OwnerPaperRunner`, SQLite migration tag `v1`.

Set `RUNNER_OWNER_ID` to the unchanged Sites owner ID and `RUNNER_ENGINE_VERSION` to the exact published shared-engine commit/build identifier. Set one random server secret of at least 32 bytes, `RUNNER_HMAC_SECRET`, identically on Sites and this Worker. Empty settings fail closed. Never put the secret or provider credentials in a public/browser environment variable.

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

The provider transport uses the official read-only market WebSocket and existing strict parser. REST books retain request/receipt timestamps, provider timestamps and cache provenance. Old or cached books cannot become fresh from a heartbeat. Football context uses the shared priority report helper: verified direct event lookup, a 3-second cache, and a 2-second maximum wait. Reports and connection setup run alongside books using platform `waitUntil`. Held exits wait only for their book; pending/new entries wait for the bounded report check. Tennis keeps its verified 15-second event context cache. Initial discovery uses the shared resumable 20-event pagination, so the focus can be beyond the first page. Fee/tick/size metadata has its own 60-second refresh clock, independent of context receipt age. HTTP 429 backoff survives reconstruction.

Confirmed final context is returned separately when a final book is unavailable, so a completed game still records an automatic pause. That lifecycle cause and verified context are preserved in the control/replay journal. Existing exits continue. Starting/resuming without an explicit duration clears the old browser observation window, with that transition recorded in the replay frame; the service then runs until the focused game ends, a user pauses/stops it, or a safety limit pauses entries.

SQL cursor row-write counts and alarm writes feed a persisted UTC-day estimate. At 75,000 estimated writes, new entries pause while existing exits remain managed. Start/resume cannot bypass that pause. This is an account-local estimate, not a hard guarantee against Cloudflare account-wide limits; other Workers, reads, duration and other quotas still apply. No billing plan upgrade occurs automatically.

Every committed action and tick—including no-input ticks—records exact inputs by content hash, engine/build identity, timestamp, source failures and before/after state hashes in the same transaction as session and journal changes. Reset IDs are captured as replay entropy. `lib/runner/replay.ts` reproduces frames from the initial migration checkpoint. Older imported histories retain their original evidence limitations and are not presented as exact whole-strategy replay.

An export ID fixes the account snapshot and journal boundary for 24 hours. `complete` means all pages were read. Check each page's `missingObservationIds` and `pageEvidenceComplete` separately; exact replay starts at `migration-checkpoint`. New decision/execution/shadow rows link `runnerFrameId` and `runnerInputIds` instead of ambiguously resolving inputs by book timestamp alone. Credentials are never included.

## Local verification

From the repository root, with existing dependencies installed and Node 24:

```
node --experimental-strip-types --test services/runner/tests/*.test.ts
node node_modules/typescript/bin/tsc -p services/runner/tsconfig.json
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config services/runner/wrangler.jsonc --outdir services/runner/build
```

Tests use synthetic fixtures and mocked transport/runtime, including SQLite rollback, signature tampering, nonce replay, encrypted credentials, handoff integrity, command races, delayed paper buy/sell replay and fees, reset replay, export boundaries, native source freshness, focus persistence, alarm recovery and concurrent pause. They do not establish a live automatic strategy entry/exit. Complete the private hosted cutover and browser-closed observation separately before calling the service live-tested.
