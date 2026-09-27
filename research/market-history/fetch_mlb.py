"""MLB pitch-by-pitch history from the public MLB Stats API (no auth).

Usage (repo root):
  research/.venv/Scripts/python research/market-history/fetch_mlb.py schedule --seasons 2021-2026
  research/.venv/Scripts/python research/market-history/fetch_mlb.py feeds    --seasons 2025-2026
  research/.venv/Scripts/python research/market-history/fetch_mlb.py extract  --seasons 2021-2026

schedule: one request per season -> research/data/mlb/schedule/<season>.parquet (final games only,
          regular season + postseason, probable pitchers, venue, day/night, doubleheader)
feeds:    GET /api/v1.1/game/{gamePk}/feed/live per final game, stored gzipped and unmodified at
          research/data/mlb/feeds/<season>/<gamePk>.json.gz (~90 KB each), so new features can be
          extracted later without re-downloading. Pitch-level Statcast measurements (speed, spin,
          break) are already inside these feeds, so a separate Savant download is unnecessary.
extract:  per season -> research/data/mlb/extract/<season>/{games,plate_appearances,events}.parquet
          events = every pitch/action with start/end timestamps (UTC ms), count, score, pitcher,
          batter, pitch type/speed, pitcher's running pitch count; plate_appearances carry the
          base-out-score state before and after each PA for win-expectancy training.
All steps are resumable.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, RateLimiter, get_json, update_manifest  # noqa: E402

API = "https://statsapi.mlb.com/api"
OUT = DATA / "mlb"
GAME_TYPES = "R,F,D,L,W"  # regular season, wild card, division, league, world series
FINAL_STATES = {"F", "O"}  # codedGameState: Final / Game Over (includes completed-early)


def seasons_arg(value: str) -> list[int]:
    if "-" in value:
        a, b = value.split("-")
        return list(range(int(a), int(b) + 1))
    return [int(v) for v in value.split(",")]


def ms(value: str | None) -> int | None:
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def fetch_schedule(season: int) -> pd.DataFrame:
    data = get_json(f"{API}/v1/schedule", {"sportId": 1, "season": season, "gameType": GAME_TYPES,
                                           "hydrate": "probablePitcher,team,venue"})
    rows = []
    for day in (data or {}).get("dates", []):
        for g in day.get("games", []):
            status = g.get("status", {})
            if status.get("codedGameState") not in FINAL_STATES:
                continue
            teams = g.get("teams", {})
            row = {"gamePk": g["gamePk"], "season": season, "gameType": g.get("gameType"),
                   "gameDate": g.get("gameDate"), "startMs": ms(g.get("gameDate")), "officialDate": g.get("officialDate"),
                   "doubleHeader": g.get("doubleHeader"), "gameNumber": g.get("gameNumber"), "dayNight": g.get("dayNight"),
                   "venueId": (g.get("venue") or {}).get("id"), "venue": (g.get("venue") or {}).get("name"),
                   "scheduledInnings": g.get("scheduledInnings"), "detailedState": status.get("detailedState")}
            for side in ("away", "home"):
                t = teams.get(side, {})
                team = t.get("team", {})
                row[f"{side}Id"] = team.get("id")
                row[f"{side}Abbr"] = team.get("abbreviation")
                row[f"{side}Name"] = team.get("name")
                row[f"{side}Score"] = t.get("score")
                row[f"{side}ProbableId"] = (t.get("probablePitcher") or {}).get("id")
                row[f"{side}ProbableName"] = (t.get("probablePitcher") or {}).get("fullName")
            rows.append(row)
    df = pd.DataFrame(rows).drop_duplicates("gamePk", keep="last")
    path = OUT / "schedule" / f"{season}.parquet"
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)
    print(f"schedule {season}: {len(df)} final games", flush=True)
    return df


def fetch_feed(season: int, game_pk: int, limiter: RateLimiter) -> str:
    path = OUT / "feeds" / str(season) / f"{game_pk}.json.gz"
    if path.exists():
        return "skip"
    data = get_json(f"{API}/v1.1/game/{game_pk}/feed/live", limiter=limiter, timeout=120)
    if data is None:
        return "missing"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(data, fh, separators=(",", ":"))
    tmp.replace(path)
    return "ok"


def fetch_feeds(seasons: list[int], workers: int, rate: float) -> None:
    limiter = RateLimiter(rate)
    for season in seasons:
        sched_path = OUT / "schedule" / f"{season}.parquet"
        schedule = pd.read_parquet(sched_path) if sched_path.exists() else fetch_schedule(season)
        counts = {"ok": 0, "skip": 0, "missing": 0, "error": 0}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(fetch_feed, season, int(pk), limiter): pk for pk in schedule.gamePk}
            for i, fut in enumerate(as_completed(futures), 1):
                try:
                    counts[fut.result()] += 1
                except Exception as exc:
                    counts["error"] += 1
                    print(f"error {futures[fut]}: {exc}", flush=True)
                if i % 500 == 0:
                    print(f"feeds {season} {i}/{len(futures)} {counts}", flush=True)
        print(f"feeds {season} done {counts}", flush=True)


def _base_state(matchup: dict) -> tuple[int, int, int]:
    return tuple(1 if matchup.get(k) else 0 for k in ("postOnFirst", "postOnSecond", "postOnThird"))  # type: ignore[return-value]


def extract_game(feed: dict) -> tuple[dict, list[dict], list[dict]]:
    gd, ld = feed.get("gameData", {}), feed.get("liveData", {})
    game_pk = feed.get("gamePk") or gd.get("game", {}).get("pk")
    teams, weather, linescore = gd.get("teams", {}), gd.get("weather", {}), ld.get("linescore", {})
    box = ld.get("boxscore", {}).get("teams", {})
    game = {"gamePk": game_pk, "season": int(gd.get("game", {}).get("season", 0) or 0),
            "gameType": gd.get("game", {}).get("type"), "startMs": ms(gd.get("datetime", {}).get("dateTime")),
            "venueId": gd.get("venue", {}).get("id"), "weatherCondition": weather.get("condition"),
            "temp": pd.to_numeric(weather.get("temp"), errors="coerce"), "wind": weather.get("wind"),
            "innings": linescore.get("currentInning"), "scheduledInnings": linescore.get("scheduledInnings")}
    for side in ("away", "home"):
        game[f"{side}Id"] = teams.get(side, {}).get("id")
        game[f"{side}Abbr"] = teams.get(side, {}).get("abbreviation")
        game[f"{side}Runs"] = linescore.get("teams", {}).get(side, {}).get("runs")
        game[f"{side}ProbableId"] = (gd.get("probablePitchers", {}).get(side) or {}).get("id")
        game[f"{side}BattingOrder"] = json.dumps(box.get(side, {}).get("battingOrder", []))
        game[f"{side}Pitchers"] = json.dumps(box.get(side, {}).get("pitchers", []))
    if game["homeRuns"] is not None and game["awayRuns"] is not None:
        game["homeWin"] = int(game["homeRuns"] > game["awayRuns"])

    pas, events = [], []
    pitch_counts: dict[int, int] = {}
    away, home, outs = 0, 0, 0
    bases = (0, 0, 0)
    last_half = None
    for play in ld.get("plays", {}).get("allPlays", []):
        about, result, matchup = play.get("about", {}), play.get("result", {}), play.get("matchup", {})
        half = (about.get("inning"), about.get("isTopInning"))
        if half != last_half:  # new half-inning resets outs; ghost runner shows up in the first event's state
            outs, bases, last_half = 0, (0, 0, 0), half
        pitcher = (matchup.get("pitcher") or {}).get("id")
        batter = (matchup.get("batter") or {}).get("id")
        pre = {"awayScorePre": away, "homeScorePre": home, "outsPre": outs, "on1Pre": bases[0], "on2Pre": bases[1], "on3Pre": bases[2]}
        for ev in play.get("playEvents", []):
            details, count = ev.get("details", {}), ev.get("count", {})
            is_pitch = bool(ev.get("isPitch"))
            if is_pitch and pitcher:
                pitch_counts[pitcher] = pitch_counts.get(pitcher, 0) + 1
            pitch = ev.get("pitchData") or {}
            events.append({
                "gamePk": game_pk, "atBatIndex": about.get("atBatIndex"), "eventIndex": ev.get("index"),
                "type": ev.get("type"), "isPitch": is_pitch, "startMs": ms(ev.get("startTime")), "endMs": ms(ev.get("endTime")),
                "inning": about.get("inning"), "isTop": about.get("isTopInning"),
                "balls": count.get("balls"), "strikes": count.get("strikes"), "outs": count.get("outs"),
                "awayScore": details.get("awayScore", away), "homeScore": details.get("homeScore", home),
                "eventType": details.get("eventType"), "code": details.get("code"),
                "isInPlay": details.get("isInPlay"), "isStrike": details.get("isStrike"), "isBall": details.get("isBall"),
                "pitchType": (details.get("type") or {}).get("code"), "startSpeed": pitch.get("startSpeed"),
                "spinRate": (pitch.get("breaks") or {}).get("spinRate"),
                "pitcherId": pitcher, "batterId": batter, "playerId": (ev.get("player") or {}).get("id"),
                "pitcherPitchCount": pitch_counts.get(pitcher, 0) if pitcher else None,
            })
        away, home = result.get("awayScore", away), result.get("homeScore", home)
        outs = play.get("count", {}).get("outs", outs)
        bases = _base_state(matchup) if outs < 3 else (0, 0, 0)
        pas.append({
            "gamePk": game_pk, "atBatIndex": about.get("atBatIndex"), "inning": about.get("inning"),
            "isTop": about.get("isTopInning"), "startMs": ms(about.get("startTime")), "endMs": ms(about.get("endTime")),
            "batterId": batter, "pitcherId": pitcher, "batSide": (matchup.get("batSide") or {}).get("code"),
            "pitchHand": (matchup.get("pitchHand") or {}).get("code"), "eventType": result.get("eventType"),
            "rbi": result.get("rbi"), "isScoringPlay": about.get("isScoringPlay"), **pre,
            "awayScorePost": away, "homeScorePost": home, "outsPost": outs,
            "on1Post": bases[0], "on2Post": bases[1], "on3Post": bases[2],
            "pitcherPitchCount": pitch_counts.get(pitcher, 0) if pitcher else None,
        })
    return game, pas, events


def extract(seasons: list[int]) -> None:
    summary = {}
    for season in seasons:
        folder = OUT / "feeds" / str(season)
        files = sorted(folder.glob("*.json.gz"))
        games, pas, events = [], [], []
        for i, path in enumerate(files, 1):
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                g, p, e = extract_game(json.load(fh))
            games.append(g); pas.extend(p); events.extend(e)
            if i % 500 == 0:
                print(f"extract {season} {i}/{len(files)}", flush=True)
        dest = OUT / "extract" / str(season)
        dest.mkdir(parents=True, exist_ok=True)
        pd.DataFrame(games).to_parquet(dest / "games.parquet", index=False)
        pd.DataFrame(pas).to_parquet(dest / "plate_appearances.parquet", index=False)
        pd.DataFrame(events).to_parquet(dest / "events.parquet", index=False)
        summary[str(season)] = {"games": len(games), "plateAppearances": len(pas), "events": len(events)}
        print(f"extract {season}: {summary[str(season)]}", flush=True)
    manifest = {"path": str((OUT / "extract").relative_to(DATA)), "bySeason": summary,
                "source": "https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live"}
    update_manifest("mlbStatsApi", manifest)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cmd", choices=["schedule", "feeds", "extract", "all"])
    parser.add_argument("--seasons", default="2025-2026", type=seasons_arg)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--rate", type=float, default=5.0)
    args = parser.parse_args()
    if args.cmd in ("schedule", "all"):
        for season in args.seasons:
            fetch_schedule(season)
    if args.cmd in ("feeds", "all"):
        fetch_feeds(args.seasons, args.workers, args.rate)
    if args.cmd in ("extract", "all"):
        extract(args.seasons)


if __name__ == "__main__":
    main()
