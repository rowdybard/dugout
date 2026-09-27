"""Can resting (maker) orders make money on Polymarket US before liquidity rewards? Markout study.

Usage: research/.venv/Scripts/python research/studies/maker_markout.py [mlb nfl cfb atp wta] [--since=2026-03-01]
Uses only the catalog and price history (no play-by-play). Only densely sampled games (median gap <= 5 s).

Simulation per game and side (YES bid, YES ask; the NO side is the mirror image):
  a resting order joins the best price; if the market improves away from it, it is moved to the new best
  (no fill). A fill is assumed when the price level is consumed:
    optimistic   the best bid drops below our bid (level consumed; we assume we were in the queue)
    conservative the opposite best price crosses through our price (ask <= our bid)
  After each fill the order rests again 5 s later. Markout = mid at +10 s / +60 s / +300 s (and at
  settlement) minus the fill price, for a bid (mirror for an ask), plus the maker rebate
  0.0125 * p * (1 - p) per contract (docs.polymarket.us/fees). Liquidity-program rewards are NOT included.
Phases: pregame (before scheduled start) and live (start to finish). Positive average markout means the spread
earned plus the rebate exceeds adverse selection at that horizon.
Writes research/studies/results/maker-markout.json.
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from common import DATA, RESULTS, mean_ci

FULL_GAME = {"moneyline", "football_team_full_game_winner", "baseball_team_full_game_winner", "tennis_match_winner"}
HORIZONS = (10, 60, 300)
REQUOTE = 5
REBATE = 0.0125


def simulate(ts, bid, ask, settle_yes, start_ts, end_ts, model):
    """Yield (phase, side, fill_px, markouts..., settle_markout) for the YES-side bid and ask."""
    mid = (bid + ask) / 2
    n = len(ts)
    out = []
    for side in ("bid", "ask"):
        rest_px, rest_from = None, ts[0]
        for i in range(1, n):
            t = ts[i]
            if rest_px is None:
                if t >= rest_from and ask[i] - bid[i] <= 0.05 + 1e-9:
                    rest_px = bid[i] if side == "bid" else ask[i]
                continue
            if side == "bid":
                filled = (bid[i] < rest_px - 1e-9) if model == "optimistic" else (ask[i] <= rest_px + 1e-9)
                improved = bid[i] > rest_px + 1e-9
            else:
                filled = (ask[i] > rest_px + 1e-9) if model == "optimistic" else (bid[i] >= rest_px - 1e-9)
                improved = ask[i] < rest_px - 1e-9
            if filled:
                px = rest_px
                sign = 1.0 if side == "bid" else -1.0
                rec = [("pregame" if t < start_ts else "live"), side, px]
                for h in HORIZONS:
                    j = np.searchsorted(ts, t + h, side="right") - 1
                    rec.append(sign * (mid[j] - px) + REBATE * px * (1 - px) if ts[j] <= end_ts else np.nan)
                rec.append(sign * (settle_yes - px) + REBATE * px * (1 - px))
                out.append(rec)
                rest_px, rest_from = None, t + REQUOTE
            elif improved:
                rest_px = bid[i] if side == "bid" else ask[i]
    return out


def analyze(league: str, catalog: pd.DataFrame, since: int) -> dict:
    cat = catalog[(catalog.league == league) & catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(FULL_GAME)
                  & catalog.long_settle.isin([0.0, 1.0]) & (catalog.start_ts >= since)]
    fills = {"optimistic": [], "conservative": []}
    games = 0
    for m in cat.itertuples():
        path = DATA / "pmus" / "history" / league / f"{m.market_slug}.parquet"
        if not path.exists():
            continue
        h = pd.read_parquet(path)
        if len(h) < 100:
            continue
        h = h.sort_values(["ts", "seq"]).groupby("ts").tail(1)
        h = h[(h.long > 0) & (h.long < 1) & (h.short > 0) & (h.short < 1)]
        if len(h) < 100 or h.ts.diff().median() > 5:
            continue
        end = m.finished_ts if pd.notna(m.finished_ts) else (m.market_end_ts if pd.notna(m.market_end_ts) else h.ts.max())
        h = h[h.ts <= end]
        ts, ask, bid = h.ts.values.astype(float), h.long.values.astype(float), 1 - h.short.values.astype(float)
        games += 1
        for model in fills:
            for rec in simulate(ts, bid, ask, float(m.long_settle), m.start_ts, end, model):
                fills[model].append([m.market_slug, *rec])
    res = {"league": league, "games": games, "models": {}}
    for model, rows in fills.items():
        df = pd.DataFrame(rows, columns=["slug", "phase", "side", "px", *[f"m{h}" for h in HORIZONS], "settle"])
        res["models"][model] = {}
        for phase, part in df.groupby("phase"):
            res["models"][model][phase] = {"fills": len(part), "fillsPerGame": len(part) / max(1, games),
                                           **{f"markout{h}s": mean_ci(part[f"m{h}"], part.slug.values) for h in HORIZONS},
                                           "toSettlement": mean_ci(part.settle, part.slug.values)}
    return res


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    since = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--since=")), "2026-03-01")
    since_ts = int(pd.Timestamp(since, tz="UTC").timestamp())
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
    results = {}
    for league in args or ["mlb", "nfl", "cfb"]:
        res = analyze(league, catalog, since_ts)
        results[league] = res
        print(f"\n== {league}: {res['games']} dense games")
        for model, phases in res["models"].items():
            for phase, v in phases.items():
                cents = lambda ci: f"{ci['mean'] * 100:+.2f}c [{ci['lo'] * 100:+.2f}, {ci['hi'] * 100:+.2f}]" if ci["n"] else "n/a"  # noqa: E731
                print(f"  {model:12s} {phase:7s} fills={v['fills']:6d} ({v['fillsPerGame']:.0f}/game) "
                      f"10s {cents(v['markout10s'])} 60s {cents(v['markout60s'])} 300s {cents(v['markout300s'])} settle {cents(v['toSettlement'])}")
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "maker-markout.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
