"""Dugout data lake: publish research/data to cheap object storage and search it with SQL (docs/DATA-PLATFORM.md).

Storage: Cloudflare R2 (S3-compatible, no egress fees) or any local folder. Query engine: DuckDB, which reads
Parquet straight from R2 or HTTPS, so there is no database server to pay for or run.

Usage (from the repo root, research venv active):
  python research/datastore/lake.py status                      # what exists locally, and where it would go
  python research/datastore/lake.py publish [--only NAME ...]   # upload datasets (replaces each one); --append adds files
  python research/datastore/lake.py publish --dest D:/lake      # same, into a local folder or external drive
  python research/datastore/lake.py tables [--local]            # list searchable tables
  python research/datastore/lake.py query "SELECT ..." [--local] [--csv out.csv]
  python research/datastore/lake.py find clemson [--local]      # search market titles and slugs
  python research/datastore/lake.py put-pack pack.json          # publish an evidence pack (validate it first:
                                                                #   node --experimental-strip-types scripts/evidence-pack.ts validate pack.json)
Credentials live in research/.env (gitignored): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
optional R2_PUBLIC_BASE (https URL for public reads) and LAKE_PREFIX (default "dugout").
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("LAKE_DATA", ROOT / "data"))  # LAKE_DATA overrides, for tests
CATALOG_SCHEMA = "dugout-catalog-v1"
PACK_SCHEMA = "dugout-evidence-v1"
SEP = r"[\\/]"  # Windows or POSIX path separators inside DuckDB's filename column
NOT_SEP = r"[^\\/]"


def load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass
class Dataset:
    name: str
    glob: str  # relative to research/data
    description: str
    partition_by: list[str] = field(default_factory=list)
    # SQL over `src` (read_parquet of the glob with filename=true); default keeps every column.
    select: str = "SELECT * EXCLUDE (filename) FROM src"


def path_part(pattern: str) -> str:
    return "regexp_extract(filename, '" + pattern + "', 1)"


def season_from(folder: str) -> str:
    """SELECT for per-season folders: <folder>/<yyyy>/file.parquet."""
    return "SELECT " + path_part(folder + SEP + "([0-9]{4})" + SEP) + " AS season, * EXCLUDE (filename) FROM src"


HISTORY_SELECT = ("SELECT " + path_part(SEP + "history" + SEP + "(" + NOT_SEP + "+)" + SEP) + " AS league, "
                  + path_part("(" + NOT_SEP + "+)[.]parquet$") + " AS market_slug, "
                  "strftime(to_timestamp(ts), '%Y-%m') AS month, * EXCLUDE (filename) FROM src")


DATASETS: list[Dataset] = [
    Dataset("pmus_catalog", "pmus/catalog.parquet",
            "Every settled Polymarket US full-game winner market: teams, start time, settlement, fee coefficient."),
    Dataset("pmus_history", "pmus/history/*/*.parquet",
            "Polymarket US price history per market: ts (unix s), seq, long (YES ask-derived), short (NO ask-derived). "
            "YES bid = 1 - short; spread = long + short - 1.",
            ["league", "month"], HISTORY_SELECT),
    Dataset("aligned_mlb", "aligned/mlb.parquet", "MLB price observations aligned with game state and outcome."),
    Dataset("aligned_nfl", "aligned/nfl.parquet", "NFL price observations aligned with pre-snap state and outcome."),
    Dataset("mlb_schedule", "mlb/schedule/*.parquet", "MLB final games per season (Stats API)."),
    Dataset("mlb_games", "mlb/extract/*/games.parquet", "MLB game-level extract from Stats API live feeds.",
            ["season"], season_from("extract")),
    Dataset("mlb_plate_appearances", "mlb/extract/*/plate_appearances.parquet", "MLB plate appearances with official start/end times.",
            ["season"], season_from("extract")),
    Dataset("mlb_events", "mlb/extract/*/events.parquet", "MLB in-game events (pitching changes, substitutions, ...).",
            ["season"], season_from("extract")),
    Dataset("cfb_games", "cfb/games/*.parquet", "College football games (CollegeFootballData)."),
    Dataset("cfb_lines", "cfb/lines/*.parquet", "College football betting lines (CollegeFootballData)."),
    Dataset("cfb_plays", "cfb/plays/*/*.parquet", "College football plays (CollegeFootballData).",
            ["season"], season_from("plays")),
]


def nflverse_datasets() -> list[Dataset]:
    """Every nflverse folder under research/data/nfl becomes nfl_<folder>; play-by-play is split by season."""
    folder = DATA / "nfl"
    out = []
    for sub in sorted(p for p in folder.glob("*") if p.is_dir()) if folder.exists() else []:
        if not any(sub.glob("*.parquet")):
            continue
        name = "nfl_" + "".join(c if c.isalnum() else "_" for c in sub.name.lower())
        partition = ["season"] if sub.name == "pbp" else []
        out.append(Dataset(name, f"nfl/{sub.name}/*.parquet", f"nflverse release '{sub.name}'.", partition))
    return out


def all_datasets() -> list[Dataset]:
    return DATASETS + nflverse_datasets()


def local_files(ds: Dataset) -> list[Path]:
    return sorted(DATA.glob(ds.glob))


def source_sql(ds: Dataset) -> str:
    pattern = (DATA / ds.glob).as_posix()
    src = f"read_parquet('{pattern}', filename = true, union_by_name = true)"
    return f"WITH src AS (SELECT * FROM {src}) {ds.select}"


class Store:
    """Destination for published data: r2://bucket/prefix via DuckDB + boto3, or a local folder."""

    def __init__(self, dest: str | None):
        load_env()
        self.local: Path | None = None
        if dest and dest != "r2":
            self.local = Path(dest).resolve()
            self.base = self.local.as_posix()
            return
        missing = [k for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not os.environ.get(k)]
        if missing:
            sys.exit(f"Missing {', '.join(missing)} in research/.env (or pass --dest <folder>). See docs/DATA-PLATFORM.md.")
        self.bucket = os.environ["R2_BUCKET"]
        self.prefix = os.environ.get("LAKE_PREFIX", "dugout").strip("/")
        self.base = f"r2://{self.bucket}/{self.prefix}"
        self.public = os.environ.get("R2_PUBLIC_BASE", "").rstrip("/") or None

    def connect(self) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect()
        if self.local is None:
            con.execute("INSTALL httpfs; LOAD httpfs;")
            con.execute("CREATE SECRET r2 (TYPE r2, KEY_ID ?, SECRET ?, ACCOUNT_ID ?)",
                        [os.environ["R2_ACCESS_KEY_ID"], os.environ["R2_SECRET_ACCESS_KEY"], os.environ["R2_ACCOUNT_ID"]])
        return con

    def s3(self):
        import boto3  # only needed for small JSON objects and deletes on R2
        return boto3.client("s3", endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
                            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
                            region_name="auto")

    def key(self, rel: str) -> str:
        return f"{self.prefix}/{rel}"

    def delete_prefix(self, rel: str) -> None:
        if self.local is not None:
            shutil.rmtree(self.local / rel, ignore_errors=True)
            return
        s3, token = self.s3(), None
        while True:
            page = s3.list_objects_v2(Bucket=self.bucket, Prefix=self.key(rel) + "/", **({"ContinuationToken": token} if token else {}))
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if keys:
                s3.delete_objects(Bucket=self.bucket, Delete={"Objects": keys})
            if not page.get("IsTruncated"):
                return
            token = page["NextContinuationToken"]

    def list_files(self, con: duckdb.DuckDBPyConnection, rel: str) -> list[str]:
        if self.local is not None:
            return sorted(p.relative_to(self.local).as_posix() for p in (self.local / rel).rglob("*.parquet"))
        rows = con.execute(f"SELECT file FROM glob('{self.base}/{rel}/**/*.parquet') ORDER BY file").fetchall()
        return [r[0][len(self.base) + 1:] for r in rows]

    def put_json(self, rel: str, doc: dict) -> str:
        text = json.dumps(doc, indent=1) + "\n"
        if self.local is not None:
            path = self.local / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        else:
            self.s3().put_object(Bucket=self.bucket, Key=self.key(rel), Body=text.encode(), ContentType="application/json",
                                 CacheControl="max-age=60")
        return text

    def get_json(self, rel: str) -> dict | None:
        try:
            if self.local is not None:
                return json.loads((self.local / rel).read_text(encoding="utf-8"))
            return json.loads(self.s3().get_object(Bucket=self.bucket, Key=self.key(rel))["Body"].read())
        except Exception:  # missing catalog on first publish
            return None

    def public_base(self) -> str:
        if self.local is not None:
            return self.local.as_uri()
        return self.public or f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com/{self.bucket}/{self.prefix}"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def empty_catalog(store: Store) -> dict:
    return {"schema": CATALOG_SCHEMA, "base": store.public_base(), "updatedAt": now_iso(), "datasets": [], "evidencePack": None}


def cmd_status(_args) -> None:
    print(f"Local data: {DATA}")
    total = 0
    for ds in all_datasets():
        files = local_files(ds)
        size = sum(f.stat().st_size for f in files)
        total += size
        print(f"  {ds.name:24s} {len(files):6d} files {size / 1e6:10.1f} MB  {'partition ' + ','.join(ds.partition_by) if ds.partition_by else ''}")
    print(f"  total {total / 1e9:.2f} GB (Parquet is re-compressed with zstd on publish)")
    load_env()
    print("R2 configured:", all(os.environ.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")))


def cmd_publish(args) -> None:
    store = Store(args.dest)
    con = store.connect()
    catalog = store.get_json("catalog.json") or empty_catalog(store)
    catalog["base"] = store.public_base()
    known = {d["name"]: d for d in catalog["datasets"]}
    for ds in all_datasets():
        if args.only and ds.name not in args.only:
            continue
        files = local_files(ds)
        if not files:
            print(f"skip {ds.name}: no local files match {ds.glob}")
            continue
        rel = f"lake/{ds.name}"
        if not args.append:
            store.delete_prefix(rel)
        if store.local is not None:
            (store.local / rel).mkdir(parents=True, exist_ok=True)
        # Partitioned writes fill hive folders; unpartitioned ones are one file. Unique names make --append safe.
        if ds.partition_by:
            target = f"{store.base}/{rel}"
            opts = ["FORMAT parquet", "COMPRESSION zstd", f"PARTITION_BY ({', '.join(ds.partition_by)})",
                    "FILENAME_PATTERN 'part_{uuid}'", "OVERWRITE_OR_IGNORE true"]
        else:
            target = f"{store.base}/{rel}/part_{uuid.uuid4().hex}.parquet"
            opts = ["FORMAT parquet", "COMPRESSION zstd"]
        print(f"publish {ds.name}: {len(files)} local files -> {store.base}/{rel}", flush=True)
        if args.dry_run:
            continue
        con.execute(f"COPY ({source_sql(ds)}) TO '{target}' ({', '.join(opts)})")
        written = store.list_files(con, rel)
        reader = f"read_parquet([{', '.join(repr(store.base + '/' + f) for f in written)}], hive_partitioning = true, union_by_name = true)"
        rows = con.execute(f"SELECT count(*) FROM {reader}").fetchone()[0]
        columns = [{"name": r[0], "type": r[1]} for r in con.execute(f"DESCRIBE SELECT * FROM {reader}").fetchall()]
        size = sum((store.local / f).stat().st_size for f in written) if store.local is not None else None
        known[ds.name] = {"name": ds.name, "description": ds.description, "format": "parquet", "path": rel, "partitions": ds.partition_by,
                          "files": written, "columns": columns, "rows": rows, "bytes": size, "updatedAt": now_iso()}
        print(f"  {rows:,} rows in {len(written)} files")
    catalog["datasets"] = sorted(known.values(), key=lambda d: d["name"])
    catalog["updatedAt"] = now_iso()
    if not args.dry_run:
        store.put_json("catalog.json", catalog)
        print(f"catalog.json updated ({len(catalog['datasets'])} datasets)")


def connect_for_query(args) -> duckdb.DuckDBPyConnection:
    """Views named after each dataset, over local research/data (--local) or the published lake."""
    if args.local:
        con = duckdb.connect()
        for ds in all_datasets():
            if local_files(ds):
                con.execute(f"CREATE VIEW {ds.name} AS {source_sql(ds)}")
        return con
    store = Store(args.dest)
    con = store.connect()
    catalog = store.get_json("catalog.json")
    if not catalog:
        sys.exit("No catalog.json at the destination yet. Run publish first, or use --local.")
    for d in catalog["datasets"]:
        files = ", ".join(repr(store.base + "/" + f) for f in d["files"])
        con.execute(f"CREATE VIEW {d['name']} AS SELECT * FROM read_parquet([{files}], hive_partitioning = true, union_by_name = true)")
    return con


def cmd_tables(args) -> None:
    con = connect_for_query(args)
    for (name,) in con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal ORDER BY 1").fetchall():
        cols = con.execute(f"SELECT column_name FROM information_schema.columns WHERE table_name = '{name}' ORDER BY ordinal_position").fetchall()
        print(f"{name}: {', '.join(c[0] for c in cols)}")


def cmd_query(args) -> None:
    con = connect_for_query(args)
    rel = con.sql(args.sql)
    if args.csv:
        rel.write_csv(args.csv)
        print(f"wrote {args.csv}")
    else:
        rel.show(max_rows=args.rows, max_width=200)


def cmd_find(args) -> None:
    con = connect_for_query(args)
    text = "%" + args.text.replace("%", "") + "%"
    con.execute("""SELECT league, market_slug, title, strftime(to_timestamp(start_ts), '%Y-%m-%d %H:%M UTC') AS start, long_name AS yes_side, short_name AS no_side,
                          long_settle AS yes_settle FROM pmus_catalog WHERE title ILIKE ? OR market_slug ILIKE ? OR long_name ILIKE ? OR short_name ILIKE ?
                   ORDER BY start_ts DESC LIMIT 50""", [text] * 4)
    for row in con.fetchall():
        print(" | ".join("" if v is None else str(v) for v in row))


def cmd_put_pack(args) -> None:
    text = Path(args.pack).read_text(encoding="utf-8")
    pack = json.loads(text)
    if pack.get("schema") != PACK_SCHEMA or not pack.get("version") or not isinstance(pack.get("evidence"), list):
        sys.exit("Not an evidence pack. Validate with scripts/evidence-pack.ts validate first.")
    store = Store(args.dest)
    version = "".join(c if c.isalnum() or c in "-._" else "-" for c in pack["version"])
    store.put_json(f"packs/{version}.json", pack)
    latest = store.put_json("packs/latest.json", pack)
    sha = hashlib.sha256(latest.encode()).hexdigest()
    catalog = store.get_json("catalog.json") or empty_catalog(store)
    catalog["evidencePack"] = {"path": "packs/latest.json", "sha256": sha}
    catalog["updatedAt"] = now_iso()
    store.put_json("catalog.json", catalog)
    print(f"Published pack {pack['version']} to packs/latest.json")
    print(f"Pin it in the engine host with DUGOUT_EVIDENCE_PACK_SHA256={sha}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    p = sub.add_parser("publish")
    p.add_argument("--only", nargs="*")
    p.add_argument("--dest", help="r2 (default) or a local folder")
    p.add_argument("--append", action="store_true", help="add files instead of replacing each dataset")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_publish)
    for name, func in (("tables", cmd_tables), ("query", cmd_query), ("find", cmd_find)):
        q = sub.add_parser(name)
        if name == "query":
            q.add_argument("sql")
            q.add_argument("--csv")
            q.add_argument("--rows", type=int, default=40)
        if name == "find":
            q.add_argument("text")
        q.add_argument("--local", action="store_true", help="query research/data directly instead of the published lake")
        q.add_argument("--dest", help="r2 (default) or a local folder that was published to")
        q.set_defaults(func=func)
    p = sub.add_parser("put-pack")
    p.add_argument("pack")
    p.add_argument("--dest")
    p.set_defaults(func=cmd_put_pack)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
