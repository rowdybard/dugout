"""Sportsbook closing line as fair value: does Polymarket US deviate from it, and does trading the gap pay?

Usage: research/.venv/Scripts/python research/studies/cross_venue_nfl.py
Sportsbook side: nflverse schedules home_moneyline / away_moneyline (closing consensus), de-vigged
proportionally. Polymarket side: last executable quote >= 5 min before start (as in pregame.py).
Reports:
  1. Historical sportsbook calibration of the home side (2006-2024 closing lines): is home overpriced there too?
  2. Polymarket close vs sportsbook fair value on the same games: mean gap on the home side
  3. Strategy: buy the Polymarket side whose ask + fee is below sportsbook fair value by >= threshold, hold
     to settlement. One trade per game. Also split before/after 2026-08-01.
Caveat: nflverse lines are recorded near kickoff; a live bot would compare against the line available at
entry time, so part of any gap here could be information that arrived late. Writes results/cross-venue-nfl.json.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from common import DATA, RESULTS, fee, fmt, mean_ci
from pregame import FULL_GAME, quotes

CODE = {"LAR": "LA"}
CUT = int(pd.Timestamp("2026-08-01", tz="UTC").timestamp())


def implied(ml):
    ml = np.asarray(ml, float)
    return np.where(ml < 0, -ml / (-ml + 100), 100 / (ml + 100))


def main() -> None:
    games = pd.read_parquet(DATA / "nfl" / "schedules" / "games.parquet")
    games = games.dropna(subset=["home_moneyline", "away_moneyline"])
    h, a = implied(games.home_moneyline), implied(games.away_moneyline)
    games["book_home"] = h / (h + a)
    games["home_win"] = np.where(games.result > 0, 1.0, np.where(games.result < 0, 0.0, np.nan))
    out = {"historicalBookHome": {}}
    hist = games[(games.season <= 2024) & games.home_win.notna()]
    for label, part in (("2006-2024", hist), ("2016-2024", hist[hist.season >= 2016])):
        out["historicalBookHome"][label] = {"n": len(part), "avgBookHome": float(part.book_home.mean()),
                                            "homeWinRate": float(part.home_win.mean())}
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
    cat = catalog[(catalog.league == "nfl") & catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(FULL_GAME)
                  & catalog.long_settle.isin([0.0, 1.0])].copy()
    cat["away"] = cat.long_abbr.str.upper().replace(CODE)
    cat["home"] = cat.short_abbr.str.upper().replace(CODE)
    games["gameday"] = pd.to_datetime(games.gameday)
    rows = []
    for m in cat.itertuples():
        start = pd.to_datetime(m.start_ts, unit="s")
        cand = games[(games.home_team == m.home) & (games.away_team == m.away) & ((games.gameday - start.normalize()).abs() <= pd.Timedelta(days=1))]
        path = DATA / "pmus" / "history" / "nfl" / f"{m.market_slug}.parquet"
        if cand.empty or not path.exists():
            continue
        q = quotes(path, m.start_ts)
        if q is None:
            continue
        close, _ = q
        g = cand.iloc[0]
        coef = m.fee_coefficient if pd.notna(m.fee_coefficient) else 0.0695
        # long = away YES ask; short = home (NO) ask.
        rows.append({"slug": m.market_slug, "start_ts": m.start_ts, "book_home": g.book_home, "home_ask": float(close.short),
                     "away_ask": float(close.long), "home_won": 1 - float(m.long_settle), "coef": coef})
    d = pd.DataFrame(rows)
    d["pm_home_mid"] = (d.home_ask + 1 - d.away_ask) / 2
    d["gap"] = d.pm_home_mid - d.book_home
    out["polymarketVsBook"] = {"games": len(d), "meanHomeGap": float(d.gap.mean()), "gapCI": mean_ci(d.gap),
                               "pmBrier": float(((d.pm_home_mid - d.home_won) ** 2).mean()),
                               "bookBrier": float(((d.book_home - d.home_won) ** 2).mean())}
    out["strategy"] = {}
    for thr in (0.0, 0.01, 0.02, 0.03, 0.05):
        for label, part in (("all", d), ("before 2026-08-01", d[d.start_ts < CUT]), ("from 2026-08-01", d[d.start_ts >= CUT])):
            edge_home = part.book_home - part.home_ask - fee(part.home_ask, part.coef)
            edge_away = (1 - part.book_home) - part.away_ask - fee(part.away_ask, part.coef)
            buy_home = edge_home >= edge_away
            edge = np.where(buy_home, edge_home, edge_away)
            take = edge >= thr
            ask = np.where(buy_home, part.home_ask, part.away_ask)[take]
            won = np.where(buy_home, part.home_won, 1 - part.home_won)[take]
            coef = part.coef.values[take]
            ret = (won - ask - fee(ask, coef)) / (ask + fee(ask, coef))
            out["strategy"][f"{thr}|{label}"] = {"n": int(take.sum()), "net": mean_ci(ret), "avgEdge": float(edge[take].mean()) if take.any() else None,
                                                 "homeShare": float(buy_home[take].mean()) if take.any() else None}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "cross-venue-nfl.json").write_text(json.dumps(out, indent=2))
    print(json.dumps({k: v for k, v in out.items() if k != "strategy"}, indent=1))
    for k, v in out["strategy"].items():
        print(f"  thr {k:24s} net {fmt(v['net'])} avgEdge={v['avgEdge']} homeShare={v['homeShare']}")


if __name__ == "__main__":
    main()
