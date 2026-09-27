"""Does a win-probability model beat the Polymarket US NFL price, and can that be traded after costs?

Usage: research/.venv/Scripts/python research/studies/fair_value_nfl.py
Uses the trained model in research/models/nfl/artifacts and research/data/aligned/nfl.parquet.

State at each price observation is the pre-snap state of the latest snap (conservative: the model
never sees a play result before the next snap, while the market may already have priced it).
1. Accuracy: Brier of market mid vs our model vs nflfastR vegas WP at the same live moments.
2. Strategy: the first time in a game that edge = model - ask - entry fee >= threshold on either side,
   buy at the ask (spread <= 2c) and hold to settlement. One position per game per threshold.
   Also a "blend" variant using the average of our model and nflfastR vegas WP.
Writes research/studies/results/fair-value-nfl.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import RESULTS, fee, fmt, load, mean_ci, settle_return

MODEL = Path(__file__).resolve().parents[1] / "models" / "nfl" / "artifacts"
sys.path.insert(0, str(MODEL.parent))
from features import FEATURES  # noqa: E402

THRESHOLDS = [0.02, 0.04, 0.06, 0.08, 0.10]


def predict(df: pd.DataFrame) -> np.ndarray:
    booster = lgb.Booster(model_file=str(MODEL / "wp_lgbm.txt"))
    iso = json.loads((MODEL / "wp_isotonic.json").read_text())
    return np.interp(booster.predict(df[FEATURES]), iso["x"], iso["y"])


def main() -> None:
    df = load("nfl")
    df = df[(df.phase == "live") & df.executable & df.home_win.isin([0.0, 1.0]) & df.game_seconds_remaining.notna()].copy()
    df["model_wp"] = predict(df)
    df["blend_wp"] = np.where(df.vegas_home_wp.notna(), (df.model_wp + df.vegas_home_wp) / 2, df.model_wp)
    y = df.home_win.values
    acc = {}
    for name, p in (("market_mid", df.home_mid), ("ours", df.model_wp), ("nflfastR_vegas", df.vegas_home_wp), ("blend", df.blend_wp)):
        ok = p.notna().values
        acc[name] = {"n": int(ok.sum()), "brier": float(np.mean((p.values[ok] - y[ok]) ** 2))}
    # Per-game equal weighting via 1 sample per game-minute to reduce autocorrelation effects.
    df["minute"] = (df.ts // 60)
    per_min = df.groupby(["game_id", "minute"]).tail(1)
    yb = per_min.home_win.values
    acc["perMinute"] = {name: float(np.mean((per_min[col].values - yb) ** 2)) for name, col in
                        (("market_mid", "home_mid"), ("ours", "model_wp"), ("blend", "blend_wp"))}
    strat = {}
    for model_col in ("model_wp", "blend_wp"):
        for thr in THRESHOLDS:
            trades = []
            for gid, g in df[df.spread <= 0.02 + 1e-9].groupby("game_id", sort=False):
                coef = float(g.fee_coefficient.iloc[0]) if pd.notna(g.fee_coefficient.iloc[0]) else 0.0695
                away_ask = 1 - g.home_bid
                edge_home = g[model_col] - g.home_ask - fee(g.home_ask, coef)
                edge_away = (1 - g[model_col]) - away_ask - fee(away_ask, coef)
                hit = np.flatnonzero((edge_home >= thr).values | (edge_away >= thr).values)
                if not hit.size:
                    continue
                i = hit[0]
                home_side = edge_home.values[i] >= edge_away.values[i]
                ask = g.home_ask.values[i] if home_side else away_ask.values[i]
                won = g.home_win.values[i] if home_side else 1 - g.home_win.values[i]
                trades.append((gid, ask, won, coef, float(max(edge_home.values[i], edge_away.values[i])), g.qtr.values[i]))
            t = pd.DataFrame(trades, columns=["game_id", "ask", "won", "coef", "edge", "qtr"])
            if t.empty:
                continue
            ret = settle_return(t.ask, t.won, t.coef)
            strat[f"{model_col}|{thr}"] = {"trades": len(t), "net": mean_ci(ret), "avgAsk": float(t.ask.mean()),
                                           "winRate": float(t.won.mean()), "avgModelEdge": float(t.edge.mean()),
                                           "profitPerContract": float((t.won - t.ask - fee(t.ask, t.coef)).mean())}
    out = {"games": int(df.game_id.nunique()), "liveRows": len(df), "accuracy": acc, "strategy": strat}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "fair-value-nfl.json").write_text(json.dumps(out, indent=2))
    print(f"games {out['games']}, live executable rows {len(df)}")
    for k, v in acc.items():
        print(" ", k, v)
    for k, v in strat.items():
        print(f"  {k:16s} trades={v['trades']:3d} net {fmt(v['net'])} win={v['winRate']:.2f} avgAsk={v['avgAsk']:.2f} modelEdge={v['avgModelEdge']:.3f} $/contract={v['profitPerContract']:+.3f}")


if __name__ == "__main__":
    main()
