"""College football plays, games and betting lines from CollegeFootballData (free key required).

Get a key (email only): https://collegefootballdata.com/key, then put it in research/.env:
  CFBD_API_KEY=your-key
Usage: research/.venv/Scripts/python research/market-history/fetch_cfb.py --seasons 2014-2026

Writes research/data/cfb/{games,lines}/<season>.parquet and plays/<season>/<seasonType>-w<week>.parquet.
Calls are counted because the free tier has a monthly request allowance: about 20 per season.
Resumable: existing week files are skipped (the current season's latest weeks are refetched).
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, RateLimiter, get_json, load_env, update_manifest  # noqa: E402

API = "https://api.collegefootballdata.com"
OUT = DATA / "cfb"
CURRENT = datetime.now(timezone.utc).year


def seasons_arg(value: str) -> list[int]:
    a, _, b = value.partition("-")
    return list(range(int(a), int(b or a) + 1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seasons", default="2014-2026", type=seasons_arg)
    args = parser.parse_args()
    load_env()
    key = os.environ.get("CFBD_API_KEY")
    if not key:
        sys.exit("CFBD_API_KEY is missing. Request a free key at https://collegefootballdata.com/key "
                 "and add CFBD_API_KEY=... to research/.env")
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    limiter, calls, summary = RateLimiter(2), 0, {}

    def call(path: str, params: dict):
        nonlocal calls
        calls += 1
        return get_json(API + path, params, limiter, headers=headers) or []

    for season in args.seasons:
        for kind in ("games", "lines"):
            path = OUT / kind / f"{season}.parquet"
            if path.exists() and season < CURRENT:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            rows = call(f"/{kind}", {"year": season, "seasonType": "both", "classification": "fbs"} if kind == "games"
                        else {"year": season, "seasonType": "both"})
            pd.json_normalize(rows).to_parquet(path, index=False)
        games = pd.read_parquet(OUT / "games" / f"{season}.parquet")
        type_col = "seasonType" if "seasonType" in games.columns else "season_type"
        played = games[games.get("completed", True) == True] if "completed" in games.columns else games  # noqa: E712
        weeks = sorted({(t, int(w)) for t, w in zip(played[type_col], played["week"])})
        plays_total = 0
        for season_type, week in weeks:
            path = OUT / "plays" / str(season) / f"{season_type}-w{week:02d}.parquet"
            recent = season == CURRENT and (season_type, week) in weeks[-2:]
            if path.exists() and not recent:
                plays_total += pd.read_parquet(path, columns=[]).shape[0]
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            rows = call("/plays", {"year": season, "week": week, "seasonType": season_type, "classification": "fbs"})
            df = pd.json_normalize(rows)
            df.to_parquet(path, index=False)
            plays_total += len(df)
        summary[str(season)] = {"games": len(games), "weeks": len(weeks), "plays": plays_total}
        print(f"cfb {season}: {summary[str(season)]} (API calls so far {calls})", flush=True)
    update_manifest("cfbd", {"path": str(OUT.relative_to(DATA)), "bySeason": summary, "apiCallsThisRun": calls,
                             "source": API})


if __name__ == "__main__":
    main()
