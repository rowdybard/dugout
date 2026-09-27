"""Join Polymarket US MLB full-game prices to MLB Stats API game state by wall-clock time.

Usage: research/.venv/Scripts/python research/market-history/align_mlb.py
Needs fetch_polymarket_us.py (catalog + history) and fetch_mlb.py extract for the matching seasons.
Output: research/data/aligned/mlb.parquet, one row per Polymarket price observation, with home-team
executable prices and the game state known at that moment:
  - PA start  -> pre-PA state (inning, half, outs, bases, score)
  - pitch end -> same PA state plus the count and the pitcher's running pitch count
  - PA end    -> post-PA state (result known)
Runner moves inside a PA (steals, wild pitches) appear at the PA end. MLB markets put the away team on
the long (YES) side; codes match Stats API abbreviations after upper-casing. Doubleheaders are
matched by the closest scheduled start.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, update_manifest  # noqa: E402
from align_nfl import home_prices  # noqa: E402
from fetch_polymarket_us import is_full_game  # noqa: E402

PM, MLB, OUT = DATA / "pmus", DATA / "mlb", DATA / "aligned"
STATE = ["inning", "isTop", "outs", "on1", "on2", "on3", "homeScore", "awayScore", "balls", "strikes",
         "pitcherId", "batterId", "pitcherPitchCount", "stateKind", "eventType"]


def timeline(pas: pd.DataFrame, events: pd.DataFrame) -> pd.DataFrame:
    pre = pd.DataFrame({"ms": pas.startMs, "inning": pas.inning, "isTop": pas.isTop, "outs": pas.outsPre,
                        "on1": pas.on1Pre, "on2": pas.on2Pre, "on3": pas.on3Pre, "homeScore": pas.homeScorePre,
                        "awayScore": pas.awayScorePre, "balls": 0, "strikes": 0, "pitcherId": pas.pitcherId,
                        "batterId": pas.batterId, "pitcherPitchCount": np.nan, "stateKind": "pa_start", "eventType": None})
    post = pd.DataFrame({"ms": pas.endMs, "inning": pas.inning, "isTop": pas.isTop, "outs": pas.outsPost,
                         "on1": pas.on1Post, "on2": pas.on2Post, "on3": pas.on3Post, "homeScore": pas.homeScorePost,
                         "awayScore": pas.awayScorePost, "balls": np.nan, "strikes": np.nan, "pitcherId": pas.pitcherId,
                         "batterId": pas.batterId, "pitcherPitchCount": pas.pitcherPitchCount, "stateKind": "pa_end",
                         "eventType": pas.eventType})
    pitches = events[events.isPitch].merge(pas[["atBatIndex", "outsPre", "on1Pre", "on2Pre", "on3Pre", "homeScorePre", "awayScorePre"]],
                                           on="atBatIndex", how="left")
    mid = pd.DataFrame({"ms": pitches.endMs, "inning": pitches.inning, "isTop": pitches.isTop, "outs": pitches.outsPre,
                        "on1": pitches.on1Pre, "on2": pitches.on2Pre, "on3": pitches.on3Pre, "homeScore": pitches.homeScorePre,
                        "awayScore": pitches.awayScorePre, "balls": pitches.balls, "strikes": pitches.strikes,
                        "pitcherId": pitches.pitcherId, "batterId": pitches.batterId,
                        "pitcherPitchCount": pitches.pitcherPitchCount, "stateKind": "pitch", "eventType": pitches.eventType})
    order = {"pa_start": 0, "pitch": 1, "pa_end": 2}
    tl = pd.concat([pre, mid, post], ignore_index=True).dropna(subset=["ms"])
    tl["k"] = tl.stateKind.map(order)
    return tl.sort_values(["ms", "k"]).drop(columns="k")


def main() -> None:
    catalog = pd.read_parquet(PM / "catalog.parquet")
    markets = catalog[(catalog.league == "mlb") & is_full_game(catalog)].copy()
    markets["away"], markets["home"] = markets.long_abbr.str.upper(), markets.short_abbr.str.upper()
    seasons = sorted({int(pd.to_datetime(s, unit="s").year) for s in markets.start_ts.dropna()})
    games, pas, events = {}, {}, {}
    for season in seasons:
        folder = MLB / "extract" / str(season)
        if folder.exists():
            games[season] = pd.read_parquet(folder / "games.parquet")
            pas[season] = pd.read_parquet(folder / "plate_appearances.parquet")
            events[season] = pd.read_parquet(folder / "events.parquet")
    frames, unmatched = [], []
    for m in markets.itertuples():
        season = int(pd.to_datetime(m.start_ts, unit="s").year)
        hist = PM / "history" / "mlb" / f"{m.market_slug}.parquet"
        if season not in games or not hist.exists():
            unmatched.append({"market": m.market_slug, "reason": "no extract" if season not in games else "no history"})
            continue
        g = games[season]
        cand = g[(g.homeAbbr == m.home) & (g.awayAbbr == m.away)].copy()
        cand["gap"] = (cand.startMs / 1000 - m.start_ts).abs()
        cand = cand[cand.gap <= 12 * 3600].sort_values("gap")
        if cand.empty:
            unmatched.append({"market": m.market_slug, "reason": "no game match"})
            continue
        game = cand.iloc[0]
        prices = pd.read_parquet(hist)
        if prices.empty:
            unmatched.append({"market": m.market_slug, "reason": "empty history"})
            continue
        px = home_prices(prices, long_is_home=False).sort_values(["ts", "seq"])
        px["ms"] = px.ts * 1000
        p, e = pas[season], events[season]
        tl = timeline(p[p.gamePk == game.gamePk], e[e.gamePk == game.gamePk])
        if tl.empty:
            px["phase"] = "no_pbp"
        else:
            px = pd.merge_asof(px, tl.rename(columns={"ms": "state_ms"}), left_on="ms", right_on="state_ms", direction="backward")
            px["secs_since_event"] = (px.ms - px.state_ms) / 1000
            first, last = tl.ms.iloc[0], tl.ms.iloc[-1]
            px["phase"] = np.where(px.ms < first, "pregame", np.where(px.ms > last + 300_000, "postgame", "live"))
        px["game_id"], px["gamePk"], px["season"], px["market_slug"] = f"mlb-{game.gamePk}", game.gamePk, season, m.market_slug
        px["home_team"], px["away_team"] = m.home, m.away
        px["homeProbableId"], px["awayProbableId"] = game.homeProbableId, game.awayProbableId
        px["fee_coefficient"] = m.fee_coefficient
        px["home_win"] = float(game.homeWin) if pd.notna(game.get("homeWin")) else (1 - float(m.long_settle) if pd.notna(m.long_settle) else np.nan)
        px["t"] = pd.to_datetime(px.ts, unit="s", utc=True)
        frames.append(px)
    aligned = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    OUT.mkdir(parents=True, exist_ok=True)
    aligned.to_parquet(OUT / "mlb.parquet", index=False)
    pd.DataFrame(unmatched).to_csv(OUT / "mlb_unmatched.csv", index=False)
    n_games = aligned.game_id.nunique() if not aligned.empty else 0
    live = int((aligned.phase == "live").sum()) if not aligned.empty else 0
    update_manifest("alignedMlb", {"path": "aligned/mlb.parquet", "games": n_games, "rows": len(aligned),
                                   "liveRows": live, "unmatchedMarkets": len(unmatched)})
    print(f"aligned MLB: {n_games} games, {len(aligned)} price rows ({live} live), {len(unmatched)} unmatched")


if __name__ == "__main__":
    main()
