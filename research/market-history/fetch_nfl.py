"""NFL play-by-play and context from nflverse release assets (no auth).

Usage: research/.venv/Scripts/python research/market-history/fetch_nfl.py [--first 1999]

Downloads to research/data/nfl/<tag>/<asset>.parquet:
  pbp               play_by_play_<season>  (1999+; time_of_day, EPA, nflfastR WP, drive info)
  schedules         games                  (closing spread/total/moneylines, QBs, roof, weather)
  injuries          injuries_<season>      (2009+)
  depth_charts      depth_charts_<season>  (2001+)
  pbp_participation pbp_participation_<season> (2016+; players on field)
  snap_counts       snap_counts_<season>   (2012+)
Current-season files are refreshed when older than 12 hours; others are downloaded once.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, get_json, session, update_manifest  # noqa: E402

OUT = DATA / "nfl"
TAGS = ("pbp", "schedules", "injuries", "depth_charts", "pbp_participation", "snap_counts")
CURRENT_SEASON = datetime.now(timezone.utc).year if datetime.now(timezone.utc).month >= 3 else datetime.now(timezone.utc).year - 1


def season_of(name: str) -> int | None:
    match = re.search(r"_(\d{4})\.parquet$", name)
    return int(match.group(1)) if match else None


def download(url: str, path: Path) -> None:
    tmp = path.with_suffix(".part")
    with session().get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--first", type=int, default=1999, help="first season to download")
    args = parser.parse_args()
    summary = {}
    for tag in TAGS:
        release = get_json(f"https://api.github.com/repos/nflverse/nflverse-data/releases/tags/{tag}")
        assets = [a for a in (release or {}).get("assets", []) if a["name"].endswith(".parquet") and "_old_" not in a["name"]]
        wanted = [a for a in assets if (season_of(a["name"]) or CURRENT_SEASON) >= args.first]
        folder = OUT / tag
        folder.mkdir(parents=True, exist_ok=True)
        fetched = 0
        for asset in wanted:
            path = folder / asset["name"]
            season = season_of(asset["name"])
            stale = season is None or season >= CURRENT_SEASON
            fresh_enough = path.exists() and time.time() - path.stat().st_mtime < 12 * 3600
            if path.exists() and path.stat().st_size == asset["size"] and (not stale or fresh_enough):
                continue
            download(asset["browser_download_url"], path)
            fetched += 1
        seasons = sorted(s for s in (season_of(a["name"]) for a in wanted) if s)
        summary[tag] = {"files": len(wanted), "downloadedThisRun": fetched,
                        "seasons": f"{seasons[0]}-{seasons[-1]}" if seasons else "n/a"}
        print(tag, summary[tag], flush=True)
    pbp_rows = sum(pd.read_parquet(p, columns=["play_id"]).shape[0] for p in (OUT / "pbp").glob("*.parquet"))
    summary["pbp"]["plays"] = pbp_rows
    update_manifest("nflverse", {"path": str(OUT.relative_to(DATA)), "tags": summary,
                                 "source": "https://github.com/nflverse/nflverse-data/releases"})
    print(f"nflverse done: {pbp_rows} plays")


if __name__ == "__main__":
    main()
