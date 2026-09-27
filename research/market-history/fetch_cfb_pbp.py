"""College football play-by-play with wall-clock times, from ESPN's public game feed (no key), for every settled CFB
market in the Polymarket US catalog. This is what lets college studies use what actually happened in each game
instead of prices alone.

Usage (on the PC, research venv active):
  python research/market-history/fetch_cfb_pbp.py            # resumable; cached responses are reused
Needs research/data/pmus/catalog.parquet (fetch_polymarket_us.py). Writes:
  research/data/cfb/espn/scoreboard/<YYYYMMDD>-<group>.json    raw daily FBS (80) and FCS (81) scoreboards (cache)
  research/data/cfb/espn/summary/<event>.json.gz              raw game feeds (cache)
  research/data/cfb/espn/plays.parquet                        one row per play (below)
  research/data/cfb/espn/matches.csv, unmatched.csv           which market is which ESPN game, and what did not match

Plays (verified on the live feed, Sep 27, 2026): each play has `wallclock` (UTC), period, clock, the score AFTER the play
(awayScore, homeScore), the start state (down, distance, yardsToEndzone, the team with the ball) and ESPN's home win
probability. Plays without a wall-clock time are dropped (they cannot be lined up with prices).
Matching: the market's two teams against the ESPN game's teams on the same US Eastern date (team names compared by
words; the abbreviation counts too), with home and away agreeing with the market's team ordering. Ambiguous or weak
matches are left unmatched and listed, never guessed.
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, RateLimiter, get_json, update_manifest  # noqa: E402

SITE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football"
OUT = DATA / "cfb" / "espn"
EASTERN = ZoneInfo("America/New_York")
FULL_GAME = {"moneyline", "football_team_full_game_winner"}
MIN_NAME_SCORE = 0.5
GROUPS = ("80", "81")  # ESPN's FBS and FCS scoreboards
STOP = {"the", "of", "university", "college"}


# ---- Matching -----------------------------------------------------------------------------------------------------

def words(name: str | None) -> set[str]:
    plain = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()  # "San José" -> "San Jose"
    text = re.sub(r"[^a-z0-9 ]", " ", plain.lower().replace("&", " and ").replace("'", "").replace("\u2019", ""))
    return {"state" if w == "st" else w for w in text.split() if w and w not in STOP}


def name_score(names: list[str | None], team: dict) -> float:
    """Best word overlap between the market's names for a side (school, mascot, abbreviation) and an ESPN team's
    (display name, school, short name, mascot); an exact abbreviation match scores 1. Polymarket names the school
    ("Western Kentucky") and the mascot ("Hilltoppers"), with its own abbreviations ("wkent")."""
    variants = [team.get("displayName"), team.get("location"), team.get("shortDisplayName"), team.get("name")]
    abbr = (team.get("abbreviation") or "").lower()
    best = 0.0
    for name in names:
        if not name:
            continue
        if abbr and name.strip().lower() == abbr:
            return 1.0
        a = words(name)
        for variant in variants:
            b = words(variant)
            if a and b:
                # Word overlap only: "Texas" is contained in "Texas State Bobcats", so containment is not a match.
                best = max(best, len(a & b) / len(a | b))
    return best


def eastern_date(start_ts: float) -> str:
    return datetime.fromtimestamp(start_ts, timezone.utc).astimezone(EASTERN).strftime("%Y%m%d")


def match_market(market: dict, events: list[dict]) -> tuple[dict | None, str]:
    """(ESPN event, reason). market: long/short names, abbreviations, orderings."""
    scored = []
    for event in events:
        comp = (event.get("competitions") or [{}])[0]
        teams = {c.get("homeAway"): c.get("team", {}) for c in comp.get("competitors", [])}
        if set(teams) != {"home", "away"}:
            continue
        for long_side in ("away", "home"):
            short_side = "home" if long_side == "away" else "away"
            if market.get("long_ordering") in ("away", "home") and market["long_ordering"] != long_side:
                continue
            s1 = name_score([market.get("long_team"), market.get("long_name"), market.get("long_abbr"), f"{market.get('long_team') or ''} {market.get('long_name') or ''}"], teams[long_side])
            s2 = name_score([market.get("short_team"), market.get("short_name"), market.get("short_abbr"), f"{market.get('short_team') or ''} {market.get('short_name') or ''}"], teams[short_side])
            if min(s1, s2) >= MIN_NAME_SCORE:
                scored.append((min(s1, s2) + max(s1, s2), event, long_side))
    if not scored:
        return None, "no ESPN game with both teams on that date"
    scored.sort(key=lambda x: -x[0])
    if len(scored) > 1 and scored[1][0] >= scored[0][0] - 1e-9 and scored[1][1].get("id") != scored[0][1].get("id"):
        return None, "ambiguous: two ESPN games match equally"
    return scored[0][1], f"long side is {scored[0][2]}"


# ---- Plays ----------------------------------------------------------------------------------------------------------

def epoch(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def plays_of(summary: dict, event_id: str) -> list[dict]:
    comp = summary["header"]["competitions"][0]
    side = {str(c["id"]): c["homeAway"] for c in comp["competitors"]}
    wp = {str(w.get("playId")): w.get("homeWinPercentage") for w in summary.get("winprobability") or []}
    drives = (summary.get("drives") or {})
    rows = []
    for drive in [*(drives.get("previous") or []), *([drives["current"]] if drives.get("current") else [])]:
        for play in drive.get("plays") or []:
            t = epoch(play.get("wallclock"))
            if t is None:
                continue
            start = play.get("start") or {}
            down = start.get("down")
            rows.append({"event_id": str(event_id), "play_id": str(play.get("id")), "seq": int(play.get("sequenceNumber") or 0), "t": t,
                         "period": (play.get("period") or {}).get("number"), "clock": (play.get("clock") or {}).get("displayValue"),
                         "away_after": play.get("awayScore"), "home_after": play.get("homeScore"),
                         "down": down if isinstance(down, int) and 1 <= down <= 4 else None, "distance": start.get("distance"),
                         "yards_to_endzone": start.get("yardsToEndzone"), "poss": side.get(str((start.get("team") or {}).get("id"))),
                         "type": ((play.get("type") or {}).get("text")), "scoring": bool(play.get("scoringPlay")),
                         "espn_home_wp": wp.get(str(play.get("id")))})
    return rows


# ---- Fetching -------------------------------------------------------------------------------------------------------

def cached_json(path: Path, url: str, limiter: RateLimiter, params: dict | None = None, gz: bool = False):
    if path.exists():
        with (gzip.open(path, "rt", encoding="utf-8") if gz else open(path, encoding="utf-8")) as fh:
            return json.load(fh)
    data = get_json(url, params=params, limiter=limiter)
    if data is None:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    with (gzip.open(path, "wt", encoding="utf-8") if gz else open(path, "w", encoding="utf-8")) as fh:
        json.dump(data, fh)
    return data


def main() -> None:
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
    cat = catalog[(catalog.league == "cfb") & catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(FULL_GAME)
                  & catalog.long_settle.isin([0.0, 1.0]) & catalog.start_ts.notna()]
    limiter = RateLimiter(3.0)
    today = datetime.now(timezone.utc).astimezone(EASTERN).strftime("%Y%m%d")
    matches, unmatched, plays = [], [], []
    boards: dict[str, list[dict]] = {}
    for m in cat.sort_values("start_ts").to_dict("records"):
        day = eastern_date(float(m["start_ts"]))
        events = []
        for d in (day,):
            if d not in boards:
                path = OUT / "scoreboard" / f"{d}.json"  # today's boards change; refetched below
                boards[d] = []
                for group in GROUPS:  # FBS and FCS are listed separately
                    gpath = path.with_name(f"{d}-{group}.json")
                    if d >= today and gpath.exists():
                        gpath.unlink()
                    boards[d] += (cached_json(gpath, SITE + "/scoreboard", limiter, {"dates": d, "groups": group, "limit": "400"}) or {}).get("events") or []
            events += boards[d]
        event, reason = match_market(m, events)
        if event is None:
            unmatched.append({"market_slug": m["market_slug"], "date": day, "long": m.get("long_team"), "short": m.get("short_team"), "reason": reason})
            continue
        summary = cached_json(OUT / "summary" / f"{event['id']}.json.gz", SITE + "/summary", limiter, {"event": event["id"]}, gz=True)
        if not summary:
            unmatched.append({"market_slug": m["market_slug"], "date": day, "long": m.get("long_team"), "short": m.get("short_team"), "reason": "no game feed"})
            continue
        rows = plays_of(summary, event["id"])
        matches.append({"market_slug": m["market_slug"], "event_id": str(event["id"]), "espn_name": event.get("name"), "plays": len(rows), "note": reason})
        for row in rows:
            row["market_slug"] = m["market_slug"]
        plays += rows
        if len(matches) % 25 == 0:
            print(f"{len(matches)} games matched, {len(unmatched)} unmatched, {len(plays)} plays", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(plays).to_parquet(OUT / "plays.parquet", index=False)
    pd.DataFrame(matches).to_csv(OUT / "matches.csv", index=False)
    pd.DataFrame(unmatched).to_csv(OUT / "unmatched.csv", index=False)
    update_manifest("cfbEspnPlays", {"path": str((OUT / "plays.parquet").relative_to(DATA)), "games": len(matches), "unmatched": len(unmatched), "plays": len(plays)})
    print(f"done: {len(matches)} games with plays, {len(unmatched)} unmatched (see unmatched.csv), {len(plays)} plays -> {OUT / 'plays.parquet'}")


if __name__ == "__main__":
    main()
