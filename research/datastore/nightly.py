"""Nightly lake sync: one settled day of Polymarket US full-game markets and their price history -> the lake.

Runs in GitHub Actions (.github/workflows/lake-sync.yml) once the R2 secrets exist, and can be run by hand:
  python research/datastore/nightly.py [--day 2026-10-01] [--leagues nfl,cfb,mlb,atp,wta] [--dest r2|DIR] [--dry-run]

The default day is two days ago (UTC), so every market has settled. Work happens in a staging folder
(research/data/nightly/<day>), never in research/data/pmus, so running it on the research PC cannot overwrite the
full catalog. Markets the lake already has are skipped, and files are named by day, so a re-run adds nothing twice.
"""
from __future__ import annotations

import argparse
import sys
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "market-history"))
sys.path.insert(0, str(HERE))
import fetch_polymarket_us as pm  # noqa: E402
import lake  # noqa: E402

Get = Callable[[str, dict], dict | None]


def day_bounds(day: str) -> tuple[int, int]:
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(start.timestamp()), int((start + timedelta(days=1)).timestamp())


def default_day(now: datetime | None = None) -> str:
    return ((now or datetime.now(timezone.utc)) - timedelta(days=2)).strftime("%Y-%m-%d")


def collect_day(day: str, leagues: list[str], get: Get, max_pages: int = 300) -> pd.DataFrame:
    """Closed events newest first. Once a page's oldest event starts before the day, every later page is older."""
    start, end = day_bounds(day)
    rows: list[dict] = []
    for page in range(max_pages):
        data = get(f"{pm.BASE}/v1/events", {"closed": "true", "limit": pm.PAGE_SIZE, "offset": page * pm.PAGE_SIZE,
                                            "orderBy": "startTime", "orderDirection": "desc"})
        events = (data or {}).get("events") or []
        if not events:
            break
        for event in events:
            rows.extend(pm.slim_markets(event))
        starts = [s for s in (pm.iso_to_epoch(e.get("startTime")) for e in events) if s is not None]
        if starts and min(starts) < start:
            break
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    keep = (df.league.isin(leagues) & df.market_slug.str.startswith("aec-") & df.market_type.isin(pm.FULL_GAME_TYPES)
            & df.start_ts.notna() & (df.start_ts >= start) & (df.start_ts < end))
    return df[keep].drop_duplicates("market_slug", keep="last").reset_index(drop=True)


def fetch_history(rows: pd.DataFrame, staging: Path, get: Get) -> int:
    """Same windows and file format as fetch_polymarket_us.py history, written under the staging folder."""
    written = 0
    for row in rows.itertuples():
        path = staging / "pmus" / "history" / row.league / f"{row.market_slug}.parquet"
        if path.exists():
            continue
        points: list[dict] = []
        for a, b in pm.history_windows(row):
            data = get(f"{pm.BASE}/v1/price-history", {"symbol": row.market_slug, "timestamp.startTimestamp": a,
                                                        "timestamp.endTimestamp": b, "fidelity": 1})
            points.extend((data or {}).get("history") or [])
        df = pd.DataFrame({"ts": [int(p["timestamp"]) for p in points], "long": [pm._num(p.get("longPrice")) for p in points],
                           "short": [pm._num(p.get("shortPrice")) for p in points]})
        df["seq"] = range(len(df))
        df = df.astype({"ts": "int64", "seq": "int32", "long": "float32", "short": "float32"})
        path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(path, index=False)
        written += 1
    return written


def existing_slugs(day: str, dest: str | None) -> set[str]:
    """Slugs already in the lake for this day; empty when the lake has no catalog yet."""
    start, end = day_bounds(day)
    try:
        con = lake.connect_for_query(Namespace(local=False, dest=dest))
        if not con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'pmus_catalog'").fetchone()[0]:
            return set()
        return {r[0] for r in con.execute("SELECT market_slug FROM pmus_catalog WHERE start_ts >= ? AND start_ts < ?", [start, end]).fetchall()}
    except SystemExit:
        return set()


def run(day: str, leagues: list[str], dest: str | None, dry_run: bool, get: Get) -> dict:
    rows = collect_day(day, leagues, get)
    have = existing_slugs(day, dest)
    new = rows[~rows.market_slug.isin(have)] if not rows.empty else rows
    summary = {"day": day, "markets": len(rows), "alreadyInLake": len(rows) - len(new), "published": 0}
    if new.empty:
        return summary
    staging = ROOT / "data" / "nightly" / day
    (staging / "pmus").mkdir(parents=True, exist_ok=True)
    new.to_parquet(staging / "pmus" / "catalog.parquet", index=False)
    fetch_history(new, staging, get)
    lake.DATA = staging
    lake.cmd_publish(Namespace(only=["pmus_catalog", "pmus_history"], dest=dest, append=True, dry_run=dry_run, tag=f"day-{day}"))
    summary["published"] = len(new)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--day", default=None, help="UTC day YYYY-MM-DD (default: two days ago)")
    parser.add_argument("--leagues", default=",".join(pm.TARGET_LEAGUES))
    parser.add_argument("--dest", help="r2 (default) or a local folder")
    parser.add_argument("--rate", type=float, default=4.0, help="max requests per second")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    day = args.day or default_day()
    day_bounds(day)
    limiter = pm.RateLimiter(args.rate)
    summary = run(day, args.leagues.split(","), args.dest, args.dry_run, lambda url, params: pm.get_json(url, params, limiter))
    print(summary)


if __name__ == "__main__":
    main()
