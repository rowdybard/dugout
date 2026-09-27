"""Join Polymarket US college football prices to ESPN play-by-play by wall-clock time.

Usage (on the PC, after fetch_cfb_pbp.py): python research/market-history/align_cfb.py
Output: research/data/aligned/cfb.parquet, one row per price observation, in the same layout as aligned/nfl.parquet so
every football study can read either league:
  game_id, market_slug, ts, seq, home_ask, home_bid, spread, home_mid, phase, home_win, fee_coefficient,
  play_t, secs_since_snap, qtr, posteam ('AWAY'/'HOME'), away_team='AWAY', home_team='HOME', away_score_pre,
  home_score_pre, down, poss_yardline_100, game_seconds_remaining, play_type, espn_home_wp
Game state is the PRE-SNAP state of the most recent play at or before the price (the score before that play, its
starting down and field position), never a result that was not yet known. The market's own team ordering says which
side is home. Phases: pregame before the first play, live until 5 minutes after the last, then postgame.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, update_manifest  # noqa: E402

QUARTER = 900


def seconds_left(period, clock) -> float:
    """Regulation seconds left from ESPN's countdown clock; NaN in overtime or when unreadable."""
    m = re.fullmatch(r"(\d{1,2}):([0-5]\d)", str(clock or ""))
    if not m or not isinstance(period, (int, np.integer)) or not 1 <= int(period) <= 4:
        return np.nan
    return (4 - int(period)) * QUARTER + int(m.group(1)) * 60 + int(m.group(2))


def presnap(plays: pd.DataFrame) -> pd.DataFrame:
    """One game's plays with the score before each play (the previous play's score after it)."""
    p = plays.sort_values(["t", "seq"]).reset_index(drop=True)
    p["away_score_pre"] = p.away_after.shift(1).fillna(0).astype(float)
    p["home_score_pre"] = p.home_after.shift(1).fillna(0).astype(float)
    p["game_seconds_remaining"] = [seconds_left(a, b) for a, b in zip(p.period, p.clock)]
    return p


def home_prices(prices: pd.DataFrame, long_is_home: bool) -> pd.DataFrame:
    """long = YES ask, short = NO ask (fetch_polymarket_us.py)."""
    yes_ask, no_ask = prices["long"].astype(float), prices["short"].astype(float)
    out = pd.DataFrame({"ts": prices.ts.astype(float), "seq": prices.seq})
    out["home_ask"] = yes_ask if long_is_home else no_ask
    out["home_bid"] = (1 - no_ask) if long_is_home else (1 - yes_ask)
    out["spread"] = yes_ask + no_ask - 1
    out["home_mid"] = (out.home_ask + out.home_bid) / 2
    return out


def align_game(prices: pd.DataFrame, plays: pd.DataFrame, long_is_home: bool, home_win: float) -> pd.DataFrame:
    px = home_prices(prices, long_is_home).sort_values(["ts", "seq"]).reset_index(drop=True)
    p = presnap(plays)
    state = pd.DataFrame({"play_t": p.t.astype(float), "qtr": p.period, "posteam": p.poss.map({"away": "AWAY", "home": "HOME"}),
                          "away_score_pre": p.away_score_pre, "home_score_pre": p.home_score_pre, "down": p.down.astype(float),
                          "poss_yardline_100": p.yards_to_endzone.astype(float), "game_seconds_remaining": p.game_seconds_remaining,
                          "play_type": p.type, "espn_home_wp": p.espn_home_wp.astype(float)})
    out = pd.merge_asof(px, state, left_on="ts", right_on="play_t", direction="backward")
    out["secs_since_snap"] = out.ts - out.play_t
    first, last = state.play_t.min(), state.play_t.max()
    out["play_t"] = pd.to_datetime(out.play_t, unit="s", utc=True)  # as in aligned/nfl.parquet
    out["phase"] = np.where(out.ts < first, "pregame", np.where(out.ts > last + 300, "postgame", "live"))
    out["away_team"], out["home_team"], out["home_win"] = "AWAY", "HOME", home_win
    return out


def main() -> None:
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet").set_index("market_slug")
    plays = pd.read_parquet(DATA / "cfb" / "espn" / "plays.parquet")
    frames, skipped = [], []
    for slug, game_plays in plays.groupby("market_slug"):
        m = catalog.loc[slug]
        path = DATA / "pmus" / "history" / "cfb" / f"{slug}.parquet"
        if not path.exists() or m.long_ordering not in ("away", "home"):
            skipped.append({"market_slug": slug, "reason": "no history" if not path.exists() else "team ordering unknown"})
            continue
        prices = pd.read_parquet(path)
        prices = prices[(prices.long > 0) & (prices.long < 1) & (prices.short > 0) & (prices.short < 1)]
        if prices.empty:
            skipped.append({"market_slug": slug, "reason": "empty history"})
            continue
        long_is_home = m.long_ordering == "home"
        home_win = float(m.long_settle) if long_is_home else 1 - float(m.long_settle)
        out = align_game(prices, game_plays, long_is_home, home_win)
        out["game_id"], out["market_slug"] = str(game_plays.event_id.iloc[0]), slug
        out["fee_coefficient"] = m.fee_coefficient if pd.notna(m.fee_coefficient) else 0.0695
        frames.append(out)
    aligned = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    (DATA / "aligned").mkdir(parents=True, exist_ok=True)
    aligned.to_parquet(DATA / "aligned" / "cfb.parquet", index=False)
    pd.DataFrame(skipped).to_csv(DATA / "aligned" / "cfb_skipped.csv", index=False)
    games = aligned.game_id.nunique() if not aligned.empty else 0
    live = int((aligned.phase == "live").sum()) if not aligned.empty else 0
    update_manifest("alignedCfb", {"path": "aligned/cfb.parquet", "games": games, "rows": len(aligned), "liveRows": live, "skipped": len(skipped)})
    print(f"aligned CFB: {games} games, {len(aligned)} price rows ({live} live), {len(skipped)} skipped")


if __name__ == "__main__":
    main()
