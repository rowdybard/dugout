"""Shared helpers for strategy-lab studies (see docs/STRATEGY-LAB-HANDOFF.md, Step 4).

Aligned tables (research/data/aligned/<sport>.parquet) share these columns:
  game_id, market_slug, t (UTC), ts, seq, home_ask, home_bid, home_mid, spread, phase, home_win, fee_coefficient
Costs follow lib/trading/money.ts: taker fee per contract = coefficient * p * (1 - p) per fill.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
ALIGNED = DATA / "aligned"
RESULTS = ROOT / "studies" / "results"


def load(sport: str) -> pd.DataFrame:
    df = pd.read_parquet(ALIGNED / f"{sport}.parquet")
    df = df[(df.home_ask > 0) & (df.home_ask < 1) & (df.home_bid > 0) & (df.home_bid < 1) & (df.spread >= 0)]
    return df.sort_values(["game_id", "ts", "seq"]).reset_index(drop=True)


def fee(price, coefficient=0.0695):
    price = np.asarray(price, dtype=float)
    return coefficient * price * (1 - price)


def round_trip_return(entry_ask, exit_bid, coefficient=0.0695):
    """Net return per $ spent buying at entry_ask and selling at exit_bid, with taker fees on both fills."""
    entry_ask, exit_bid = np.asarray(entry_ask, float), np.asarray(exit_bid, float)
    cost = entry_ask + fee(entry_ask, coefficient)
    proceeds = exit_bid - fee(exit_bid, coefficient)
    return (proceeds - cost) / cost


def settle_return(entry_ask, won, coefficient=0.0695):
    """Net return per $ spent buying at entry_ask and holding to settlement (no exit fee)."""
    entry_ask, won = np.asarray(entry_ask, float), np.asarray(won, float)
    cost = entry_ask + fee(entry_ask, coefficient)
    return (won - cost) / cost


def mean_ci(values, clusters=None, n_boot=2000, seed=7) -> dict:
    """Mean with a 95% bootstrap CI; resamples whole games when clusters are given (trades in one game correlate)."""
    values = np.asarray(values, float)
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"n": 0, "mean": None, "lo": None, "hi": None}
    rng = np.random.default_rng(seed)
    if clusters is None:
        boots = [rng.choice(values, values.size).mean() for _ in range(n_boot)]
    else:
        clusters = np.asarray(clusters)[: values.size]
        groups = [values[clusters == c] for c in np.unique(clusters)]
        boots = [np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))]).mean() for _ in range(n_boot)]
    lo, hi = np.percentile(boots, [2.5, 97.5])
    return {"n": int(values.size), "mean": float(values.mean()), "lo": float(lo), "hi": float(hi)}


def fmt(ci: dict, pct: bool = True) -> str:
    if not ci["n"]:
        return "n=0"
    k = 100 if pct else 1
    unit = "%" if pct else ""
    return f"{ci['mean'] * k:+.2f}{unit} [{ci['lo'] * k:+.2f}, {ci['hi'] * k:+.2f}] (n={ci['n']})"
