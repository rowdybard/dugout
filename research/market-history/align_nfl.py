"""Join Polymarket US NFL price history to nflverse play-by-play by wall-clock time.

Usage: research/.venv/Scripts/python research/market-history/align_nfl.py
Output: research/data/aligned/nfl.parquet, one row per Polymarket price observation, with:
  home-team executable prices (home_ask, home_bid = 1 - opposite ask, spread),
  the pre-snap state of the most recent snapped play (never a result that was not yet known),
  nflfastR's own home WP at that play, the closing pregame line, and the final outcome.

Conventions verified Sep 27, 2026: NFL markets put the away team on the long (YES) side; team
codes match nflverse except lar -> LA. nflverse time_of_day is a UTC ISO timestamp per snap.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "models" / "nfl"))
from common import DATA, update_manifest  # noqa: E402
from features import FEATURES, PBP_COLUMNS, build  # noqa: E402

PM = DATA / "pmus"
NFL = DATA / "nfl"
OUT = DATA / "aligned"
CODE = {"LAR": "LA"}
# Pre-snap state only (see research/models/nfl/features.py); nflverse home_score/away_score are FINAL scores.
STATE_COLS = ["play_id", "qtr", "posteam", "home_score_pre", "away_score_pre", "home_wp", "vegas_home_wp", "wpa",
              "play_type", "desc", *FEATURES]


def home_prices(prices: pd.DataFrame, long_is_home: bool) -> pd.DataFrame:
    """long = YES ask-derived price, short = NO ask-derived price."""
    yes_ask, no_ask = prices["long"].astype(float), prices["short"].astype(float)
    out = pd.DataFrame({"ts": prices.ts, "seq": prices.seq})
    out["home_ask"] = yes_ask if long_is_home else no_ask
    out["home_bid"] = (1 - no_ask) if long_is_home else (1 - yes_ask)
    out["spread"] = yes_ask + no_ask - 1
    out["home_mid"] = (out.home_ask + out.home_bid) / 2
    return out


def main() -> None:
    catalog = pd.read_parquet(PM / "catalog.parquet")
    markets = catalog[catalog.league == "nfl"].copy()
    markets["away"] = markets.long_abbr.str.upper().replace(CODE)
    markets["home"] = markets.short_abbr.str.upper().replace(CODE)
    schedule = pd.read_parquet(NFL / "schedules" / "games.parquet")
    schedule["gameday"] = pd.to_datetime(schedule.gameday)
    pbp_cache: dict[int, pd.DataFrame] = {}
    frames, unmatched = [], []
    for m in markets.itertuples():
        start = pd.to_datetime(m.start_ts, unit="s", utc=True)
        # nflverse gameday is the US Eastern date; the UTC start can roll into the next day.
        cand = schedule[(schedule.home_team == m.home) & (schedule.away_team == m.away)
                        & ((schedule.gameday - start.tz_localize(None).normalize()).abs() <= pd.Timedelta(days=1))]
        hist_path = PM / "history" / "nfl" / f"{m.market_slug}.parquet"
        if cand.empty or not hist_path.exists():
            unmatched.append({"market": m.market_slug, "reason": "no schedule match" if cand.empty else "no history"})
            continue
        game = cand.iloc[0]
        season = int(game.season)
        if season not in pbp_cache:
            path = NFL / "pbp" / f"play_by_play_{season}.parquet"
            if path.exists():
                raw = pd.read_parquet(path)
                pbp_cache[season] = build(raw[[c for c in PBP_COLUMNS if c in raw.columns]])
            else:
                pbp_cache[season] = pd.DataFrame(columns=["game_id", "time_of_day"])
        plays = pbp_cache[season]
        plays = plays[plays.game_id == game.game_id].dropna(subset=["time_of_day"])
        plays = plays[["game_id", "time_of_day", *STATE_COLS]].copy()
        prices = pd.read_parquet(hist_path)
        if prices.empty:
            unmatched.append({"market": m.market_slug, "reason": "empty history"})
            continue
        px = home_prices(prices, long_is_home=False).sort_values(["ts", "seq"])
        px["t"] = pd.to_datetime(px.ts, unit="s", utc=True)
        if not plays.empty:
            plays["t"] = pd.to_datetime(plays.time_of_day, utc=True, format="ISO8601")
            plays = plays.sort_values("t")
            px = pd.merge_asof(px, plays.drop(columns=["game_id", "time_of_day"]).rename(columns={"t": "play_t"}),
                               left_on="t", right_on="play_t", direction="backward")
            px["secs_since_snap"] = (px.t - px.play_t).dt.total_seconds()
            first_snap = plays.t.iloc[0]
            px["phase"] = np.where(px.t < first_snap, "pregame", "live")
            last_snap = plays.t.iloc[-1]
            px.loc[px.t > last_snap + pd.Timedelta(minutes=5), "phase"] = "postgame"
        else:
            px["phase"] = "no_pbp"
        px["market_slug"], px["game_id"], px["season"] = m.market_slug, game.game_id, season
        px["week"], px["season_type"] = game.week, game.game_type
        px["home_team"], px["away_team"] = m.home, m.away
        px["spread_line"], px["total_line"] = game.spread_line, game.total_line
        px["home_moneyline"], px["away_moneyline"] = game.home_moneyline, game.away_moneyline
        px["fee_coefficient"] = m.fee_coefficient
        home_win = np.nan if pd.isna(game.result) else float(game.result > 0) if game.result != 0 else 0.5
        if np.isnan(home_win) and pd.notna(m.long_settle):
            home_win = 1 - float(m.long_settle)
        px["home_win"] = home_win
        frames.append(px)
    aligned = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    OUT.mkdir(parents=True, exist_ok=True)
    aligned.to_parquet(OUT / "nfl.parquet", index=False)
    pd.DataFrame(unmatched).to_csv(OUT / "nfl_unmatched.csv", index=False)
    games = aligned.game_id.nunique() if not aligned.empty else 0
    live = int((aligned.phase == "live").sum()) if not aligned.empty else 0
    update_manifest("alignedNfl", {"path": "aligned/nfl.parquet", "games": games, "rows": len(aligned),
                                   "liveRows": live, "unmatchedMarkets": len(unmatched)})
    print(f"aligned NFL: {games} games, {len(aligned)} price rows ({live} live), {len(unmatched)} unmatched")


if __name__ == "__main__":
    main()
