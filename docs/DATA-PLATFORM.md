# Data platform

Added September 27, 2026. It covers how the research data lake (about 5 GB on the owner's PC) gets stored somewhere cheap, made searchable, and streamed into the decision engine. Tooling: [`research/datastore/lake.py`](../research/datastore/lake.py), [`lib/datastore/catalog.ts`](../lib/datastore/catalog.ts) and [`lib/decision/sources.ts`](../lib/decision/sources.ts).

**Status:** built and tested against a local folder with synthetic data. **The first upload to R2 happens from the owner's PC**; nothing has been uploaded yet, and no research has been run from the cloud session.

## Recommendation: Cloudflare R2 plus DuckDB

| Piece | What it does | Cost for about 5 GB |
|---|---|---|
| **Cloudflare R2** (object storage) | Holds the lake as Parquet files, plus the catalog and evidence packs | Free tier covers about 10 GB-month of storage and free egress. Above that it's about $0.015 per GB-month. |
| **DuckDB** (query engine) | Runs SQL directly on the Parquet files in R2, over HTTPS, or on the PC | Free, and there's no server |
| DuckDB in the browser (`shell.duckdb.org`) | Lets Chad, or Chad's AI, search a public bucket without installing anything | Free |

**Check the numbers.** They're from my knowledge of Cloudflare's pricing. Confirm them on Cloudflare's R2 pricing page before relying on them.

**Why this setup:**
- The project already runs on Cloudflare. The paper runner is a Cloudflare Worker, and a Worker can read an R2 bucket directly through a binding, with no public URL needed.
- Parquet plus DuckDB means "searchable" without paying for or running a database.
- **Alternatives considered:**
  - **D1** (already used by the dashboard) is too small for raw history, and its daily row-read limits don't suit scans. It's fine for small derived tables.
  - **Hosted Postgres** free tiers are well under 5 GB.
  - **MotherDuck** (hosted DuckDB with a web UI) and **Hugging Face Datasets** (free public hosting with a browser SQL console) both work as optional mirrors if a nicer search UI is wanted. Check their current free limits first.

## Layout in the bucket

```
<prefix>/catalog.json                                  what exists, every file, columns, row counts, current pack + SHA-256
<prefix>/lake/pmus_history/league=cfb/month=2026-09/part_<uuid>.parquet
<prefix>/lake/pmus_catalog/part_<uuid>.parquet
<prefix>/lake/nfl_pbp/season=2025/part_<uuid>.parquet
<prefix>/lake/mlb_plate_appearances/season=2026/…      (and every other dataset in lake.py)
<prefix>/packs/latest.json                             the evidence pack the engine streams in
<prefix>/packs/<version>.json                          every published pack, kept for replay/audit
```

- Price history is re-packed from about 11,000 small per-market files into partitions by league and month, with `market_slug` as a column.
- nflverse folders are picked up automatically as `nfl_<folder>`, and play-by-play is split by season.
- Raw MLB JSON feeds are **not** uploaded: the extracted tables carry what the studies use. If the raw feeds are ever needed, copy them with any S3 tool (for example `rclone`).

## One-time setup at the PC

1. **Create the bucket.** In the Cloudflare dashboard, go to **R2**, then **Create bucket**, and name it (for example `dugout-lake`).
2. **Create an API token.** Go to **R2**, then **Manage R2 API Tokens**, and create a token with **Object Read & Write** on that bucket only. Note the Access Key ID, Secret Access Key and account ID.
3. **Add the credentials to `research/.env`.** The file is gitignored, so never commit these:
   ```
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET=dugout-lake
   LAKE_PREFIX=dugout
   # optional, after enabling public access (step 6):
   R2_PUBLIC_BASE=https://<your public bucket URL>/dugout
   ```
4. **Install the tools:** `research/.venv/Scripts/python -m pip install -r research/requirements.txt`. This adds `duckdb` and `boto3`.
5. **Upload:**
   ```
   python research/datastore/lake.py status           # sizes per dataset
   python research/datastore/lake.py publish --dry-run
   python research/datastore/lake.py publish          # replaces each dataset; re-run any time
   ```
   `--dest D:/lake` publishes to a local folder or external drive instead of R2. The layout is the same, which makes it a free backup.
6. **Optional: public reads.**
   - Turn it on under the bucket's **Settings**, then **Public access**. The `r2.dev` URL is rate-limited and meant for light use; a custom domain is better.
   - Once public, anyone with the URL can read the data and the packs. Writes still need the keys. The data comes from public APIs, so public reads are acceptable. Make that call before enabling it.

## Searching

```
python research/datastore/lake.py tables                       # every table and its columns
python research/datastore/lake.py find clemson                 # markets by team, title or slug
python research/datastore/lake.py query "SELECT league, month, count(*) FROM pmus_history GROUP BY ALL ORDER BY 1, 2"
python research/datastore/lake.py query "SELECT * FROM nfl_pbp WHERE season = 2025 AND posteam = 'KC' LIMIT 20" --csv kc.csv
```

- Add `--local` to search `research/data` directly, before or without publishing.
- From TypeScript, `datasetUrls(catalog, 'pmus_history', {league: 'cfb'})` lists the files, and `duckdbSelect(...)` writes a query ready to paste into `shell.duckdb.org` when the bucket is public.

## Streaming research into the engine

Research doesn't change engine code. It publishes an **evidence pack**, a JSON file holding evidence rows and model specs (see [DECISION-ENGINE.md](DECISION-ENGINE.md#plugs-for-research)).

```
node --experimental-strip-types scripts/evidence-pack.ts export pack.json     # start from the current pack
#   ...edit/add rows from a study...
node --experimental-strip-types scripts/evidence-pack.ts validate pack.json   # schema check, diff, SHA-256
python research/datastore/lake.py put-pack pack.json                          # -> packs/latest.json + catalog pin
```

Engine hosts pick the pack up at run time:

- **Node hosts:** `scripts/forward-test.ts` and `scripts/check-bet.ts` read `DUGOUT_EVIDENCE_PACK_URL`, plus `DUGOUT_EVIDENCE_PACK_SHA256` to pin it.
- **A Worker:** it uses `r2BindingSource(env.BUCKET, 'dugout/packs/latest.json')` with a `LivePack`, which refreshes every 10 minutes by default.

**Safety rules, enforced in code and tested:**
- A pack that fails validation or doesn't load leaves the last good pack in place.
- Anyone who can write to storage cannot switch on real money. `proven` rows in an **unpinned** pack are treated as leads, and only a pack whose SHA-256 matches the configured pin keeps them. `put-pack` prints the hash, and the owner sets the pin.
- The live paper bot keeps the compiled-in pack for now, so its replays stay exact. Pinning a pack version in the runner's session state is part of Step 8.

## Keeping the lake live

All three pieces are built. None of them collects anything until the lake exists.

1. **Nightly sync:** [`lake-sync.yml`](../.github/workflows/lake-sync.yml) and [`research/datastore/nightly.py`](../research/datastore/nightly.py).
   - Each night it adds one settled day (two days ago, UTC) of Polymarket US full-game markets and their price history.
   - It works in a staging folder, so it never touches the PC's full catalog, and it skips markets the lake already has. Files are named by day, so a re-run adds nothing twice.
   - It does nothing until the repository secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` are set (optionally also `R2_PUBLIC_BASE` and `LAKE_PREFIX`).
   - Run it by hand with the **Run workflow** button, or `python research/datastore/nightly.py --day YYYY-MM-DD`.
   - Play-by-play for MLB and NFL still comes from the PC fetchers.
2. **Live book recorder:** `lib/datastore/recorder.ts`, running in the runner.
   - Every accepted order book (top 10 levels a side, plus game status) is written about once a minute to `live-books/date=…/league=…/<slug>/`, and appears in `lake.py` as the `live_books` table.
   - Football records also carry the drive state, the YES and NO team ids, the away/home ordering and the report time. That's enough for `research/studies/drive_entry.py live` to study live drives, including college games, which have no public play-by-play in the lake.
   - It switches on when the runner gets an R2 binding named `LAKE` (see `services/runner/README.md`).
3. **Forward-test ledgers:** these stream to the `forward-test-data` branch.
