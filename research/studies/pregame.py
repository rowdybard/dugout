"""Pregame mispricing on Polymarket US: favourites/underdogs, home/away and line movement, held to settlement.

Usage: research/.venv/Scripts/python research/studies/pregame.py [nfl cfb mlb atp wta]
Needs only research/data/pmus/catalog.parquet and history/<league>/*.parquet (no play-by-play).

For each settled full-game market: long = YES ask-derived price, short = NO ask-derived price, so buying
YES costs `long` and buying NO costs `short`. Only executable quotes (long + short - 1 <= 5c) count.
  close  = last executable quote >= 5 min before scheduled start
  early  = last executable quote >= 6 h before start (line-movement reference)
Strategies (one trade per game, taker fee on entry, settlement pays $1 or $0; ties/voids skipped):
  favourite / underdog at close; home / away at close (team sports; long side is the away team)
  follow-move / fade-move: buy the side whose price rose >= 3c from early to close (or the other side)
  by price band of the side bought (favourite-longshot curve)
Writes research/studies/results/pregame.json.
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from common import DATA, RESULTS, fee, fmt, mean_ci

LEAGUES = ["nfl", "cfb", "mlb", "atp", "wta"]
FULL_GAME = {"moneyline", "football_team_full_game_winner", "baseball_team_full_game_winner", "tennis_match_winner"}


def quotes(path, start_ts):
    h = pd.read_parquet(path)
    if h.empty:
        return None
    h = h[(h.long > 0) & (h.long < 1) & (h.short > 0) & (h.short < 1) & (h.long + h.short - 1 <= 0.05)]
    pre = h[h.ts <= start_ts - 300].sort_values(["ts", "seq"])
    if pre.empty:
        return None
    close = pre.iloc[-1]
    early = pre[pre.ts <= start_ts - 6 * 3600]
    return close, (early.iloc[-1] if not early.empty else None)


def analyze(league: str, catalog: pd.DataFrame, since: int | None = None, until: int | None = None) -> dict:
    cat = catalog[(catalog.league == league) & catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(FULL_GAME)
                  & catalog.long_settle.isin([0.0, 1.0])]
    if since is not None:
        cat = cat[cat.start_ts >= since]
    if until is not None:
        cat = cat[cat.start_ts < until]
    rows = []
    for m in cat.itertuples():
        path = DATA / "pmus" / "history" / league / f"{m.market_slug}.parquet"
        if not path.exists() or pd.isna(m.start_ts):
            continue
        q = quotes(path, m.start_ts)
        if q is None:
            continue
        close, early = q
        coef = m.fee_coefficient if pd.notna(m.fee_coefficient) else 0.0695
        rows.append({"slug": m.market_slug, "long_won": float(m.long_settle), "long_ask": float(close.long),
                     "short_ask": float(close.short), "early_long": float(early.long) if early is not None else np.nan,
                     "early_short": float(early.short) if early is not None else np.nan, "coef": coef,
                     "long_is_away": m.long_ordering == "away"})
    g = pd.DataFrame(rows)
    out = {"league": league, "games": len(g), "strategies": {}, "bands": {}}
    if g.empty:
        return out

    def trade(name, buy_long_mask, valid=None):
        valid = np.ones(len(g), bool) if valid is None else valid
        sel = g[valid]
        bl = buy_long_mask[valid]
        ask = np.where(bl, sel.long_ask, sel.short_ask)
        won = np.where(bl, sel.long_won, 1 - sel.long_won)
        ret = (won - ask - fee(ask, sel.coef)) / (ask + fee(ask, sel.coef))
        out["strategies"][name] = {"n": int(len(sel)), "net": mean_ci(ret), "winRate": float(won.mean()) if len(sel) else None,
                                   "avgAsk": float(ask.mean()) if len(sel) else None}

    long_mid = (g.long_ask + 1 - g.short_ask) / 2
    trade("favourite", (long_mid >= 0.5).values)
    trade("underdog", (long_mid < 0.5).values)
    if g.long_is_away.any():
        trade("home", ~g.long_is_away.values, g.long_is_away.values)
        trade("away", g.long_is_away.values, g.long_is_away.values)
    early_mid = (g.early_long + 1 - g.early_short) / 2
    move = long_mid - early_mid
    moved = (move.abs() >= 0.03).values & np.isfinite(move.values)
    trade("follow_move", (move > 0).values, moved)
    trade("fade_move", (move < 0).values, moved)
    # Favourite-longshot curve: every side of every game by its own close ask.
    sides = pd.DataFrame({"ask": np.r_[g.long_ask, g.short_ask], "won": np.r_[g.long_won, 1 - g.long_won],
                          "coef": np.r_[g.coef, g.coef]})
    sides["band"] = pd.cut(sides.ask, [0, .15, .3, .45, .55, .7, .85, 1.0])
    for band, part in sides.groupby("band", observed=True):
        ret = (part.won - part.ask - fee(part.ask, part.coef)) / (part.ask + fee(part.ask, part.coef))
        out["bands"][str(band)] = {"n": len(part), "avgAsk": float(part.ask.mean()), "winRate": float(part.won.mean()), "net": mean_ci(ret)}
    return out


def main() -> None:
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
    args = [a for a in sys.argv[1:] if not a.startswith("--split=")]
    split = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--split=")), None)
    periods = [("all", None, None)]
    if split:  # e.g. --split=2026-08-01: discovery before, check after
        cut = int(pd.Timestamp(split, tz="UTC").timestamp())
        periods = [(f"before {split}", None, cut), (f"from {split}", cut, None)]
    results = {}
    for league in args or LEAGUES:
      for label, since, until in periods:
        res = analyze(league, catalog, since, until)
        results[f"{league}|{label}"] = res
        print(f"\n== {league} [{label}]: {res['games']} games with a pregame close")
        for k, v in res["strategies"].items():
            print(f"  {k:12s} net {fmt(v['net'])} win={v['winRate']:.3f} avgAsk={v['avgAsk']:.3f}")
        for k, v in res["bands"].items():
            print(f"  ask {k:12s} n={v['n']:5d} avgAsk={v['avgAsk']:.3f} win={v['winRate']:.3f} net {fmt(v['net'])}")
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "pregame.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
