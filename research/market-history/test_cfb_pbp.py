"""Synthetic tests for fetch_cfb_pbp.py and align_cfb.py (no data files, no network). Run:
  python research/market-history/test_cfb_pbp.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import align_cfb as al  # noqa: E402
import fetch_cfb_pbp as fp  # noqa: E402


def event(eid: str, away: tuple[str, str, str], home: tuple[str, str, str]) -> dict:
    """Scoreboard event shaped like ESPN's: (abbreviation, location, displayName) per team."""
    team = lambda t: {"abbreviation": t[0], "location": t[1], "displayName": t[2], "shortDisplayName": t[1], "name": t[2].split()[-1]}  # noqa: E731
    return {"id": eid, "name": f"{away[2]} at {home[2]}", "competitions": [{"competitors": [
        {"homeAway": "home", "team": team(home)}, {"homeAway": "away", "team": team(away)}]}]}


TEX = ("TEX", "Texas", "Texas Longhorns")
TENN = ("TENN", "Tennessee", "Tennessee Volunteers")
TXST = ("TXST", "Texas State", "Texas State Bobcats")


def test_markets_match_espn_games_by_both_teams_and_venue() -> None:
    board = [event("1", TEX, TENN), event("2", TXST, ("UTSA", "UTSA", "UTSA Roadrunners"))]
    market = {"long_team": "Texas Longhorns", "short_team": "Tennessee Volunteers", "long_ordering": "away", "long_abbr": "tex", "short_abbr": "tenn"}
    found, note = fp.match_market(market, board)
    assert found["id"] == "1" and "away" in note
    # The market says YES is home: Texas is away in this game, so it does not match.
    assert fp.match_market({**market, "long_ordering": "home", "short_ordering": "away"}, board)[0] is None
    # Texas State is not Texas: "Texas State Bobcats" vs "Texas Longhorns" overlap too little.
    assert fp.name_score(["Texas State Bobcats"], board[0]["competitions"][0]["competitors"][1]["team"]) < fp.MIN_NAME_SCORE
    assert fp.match_market({"long_team": "Texas State Bobcats", "short_team": "UTSA Roadrunners", "long_ordering": "away"}, board)[0]["id"] == "2"
    assert fp.match_market({"long_team": "Nowhere", "short_team": "Tennessee Volunteers", "long_ordering": "away"}, board)[0] is None
    # Two identical candidates are ambiguous, never guessed.
    assert fp.match_market(market, [event("1", TEX, TENN), event("3", TEX, TENN)]) == (None, "ambiguous: two ESPN games match equally")
    # Polymarket's own format: school, mascot, its abbreviations; ESPN says "New Mexico St" and "WKU".
    espn = [event("9", ("WKU", "Western Kentucky", "Western Kentucky Hilltoppers"), ("NMSU", "New Mexico St", "New Mexico State Aggies")),
            event("8", ("TAMU", "Texas A&M", "Texas A&M Aggies"), ("UK", "Kentucky", "Kentucky Wildcats"))]
    espn[0]["competitions"][0]["competitors"][0]["team"]["name"] = "Aggies"
    espn[0]["competitions"][0]["competitors"][1]["team"]["name"] = "Hilltoppers"
    pm = {"long_team": "Western Kentucky", "long_name": "Hilltoppers", "long_abbr": "wkent", "long_ordering": "away",
          "short_team": "NM State", "short_name": "Aggies", "short_abbr": "nmxst", "short_ordering": "home"}
    assert fp.match_market(pm, espn)[0]["id"] == "9"
    assert fp.words("San José State") == fp.words("San Jose St") and fp.words("Hawai'i") == {"hawaii"}
    assert fp.eastern_date(1_790_000_000) == "20260921" and fp.eastern_date(1_790_035_000) == "20260921", "late kickoffs keep the US Eastern date"


def summary() -> dict:
    play = lambda pid, seq, wall, period, clock, away, home, team, down, ytg, kind="Rush", scoring=False: {  # noqa: E731
        "id": pid, "sequenceNumber": str(seq), "wallclock": wall, "period": {"number": period}, "clock": {"displayValue": clock},
        "awayScore": away, "homeScore": home, "scoringPlay": scoring, "type": {"text": kind},
        "start": {"down": down, "distance": 10, "yardsToEndzone": ytg, "team": {"id": team}}}
    return {"header": {"competitions": [{"competitors": [{"id": "2633", "homeAway": "home"}, {"id": "251", "homeAway": "away"}]}]},
            "winprobability": [{"playId": "p1", "homeWinPercentage": 0.30}, {"playId": "p2", "homeWinPercentage": 0.25}],
            "drives": {"previous": [{"plays": [
                play("p1", 1, "2026-09-26T16:08:13Z", 1, "15:00", 0, 0, "251", 0, 65, "Kickoff"),
                play("p2", 2, "2026-09-26T16:09:00Z", 1, "14:55", 0, 0, "251", 1, 75),
                play("p3", 3, None, 1, "14:30", 0, 0, "251", 2, 70),
                play("p4", 4, "2026-09-26T16:12:00Z", 1, "12:10", 7, 0, "251", 1, 8, "Passing Touchdown", True)]}]}}


def test_plays_carry_time_state_and_possession() -> None:
    rows = fp.plays_of(summary(), "401")
    assert len(rows) == 3, "a play without a wall-clock time cannot be lined up"
    first, td = rows[0], rows[2]
    assert first["poss"] == "away" and first["down"] is None and first["espn_home_wp"] == 0.30, first
    assert td["t"] == fp.epoch("2026-09-26T16:12:00Z") and td["down"] == 1 and td["yards_to_endzone"] == 8 and td["scoring"] and td["away_after"] == 7


def test_prices_join_the_presnap_state_of_the_latest_play() -> None:
    plays = pd.DataFrame(fp.plays_of(summary(), "401"))
    t0 = fp.epoch("2026-09-26T16:00:00Z")
    ts = np.array([t0, t0 + 540, t0 + 725, t0 + 800, t0 + 2000])
    prices = pd.DataFrame({"ts": ts, "seq": 0, "long": [0.40, 0.41, 0.52, 0.53, 0.55], "short": [0.61, 0.60, 0.49, 0.48, 0.46]})
    out = al.align_game(prices, plays, long_is_home=False, home_win=0.0)
    assert list(out.phase) == ["pregame", "live", "live", "live", "postgame"], list(out.phase)
    # YES (long) is the away team: home ask = NO ask, home bid = 1 - YES ask.
    assert math.isclose(out.home_ask.iloc[0], 0.61) and math.isclose(out.home_bid.iloc[0], 0.60)
    at_td = out.iloc[2]  # 5 s after the touchdown snap: its pre-snap state, not yet its score
    assert at_td.posteam == "AWAY" and at_td.away_score_pre == 0 and at_td.poss_yardline_100 == 8 and at_td.down == 1 and at_td.qtr == 1
    assert at_td.game_seconds_remaining == 3 * 900 + 12 * 60 + 10 and math.isclose(at_td.secs_since_snap, 5)
    assert str(out.play_t.dtype).startswith("datetime64") and out.home_win.iloc[0] == 0.0
    assert math.isnan(al.seconds_left(5, "10:00")) and al.seconds_left(4, "0:30") == 30


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"{len(tests)} passed")
