"""Does buying in-game price drops (Astra's local-move-v1 thesis) make money after costs?

Usage: research/.venv/Scripts/python research/studies/drop_reversion.py nfl [mlb ...]

Historical prices are irregular (often 15-60 s apart), unlike the runner's ~2.5 s live books, so this
tests the *thesis* at data resolution rather than replaying the exact code (Step 7 does that):
each live game is forward-filled onto a 15 s grid, per side (home, and away as the complement), and
  dip_recovery : peak-to-now mid drop over 3 min >= 2 sigma of prior 20-min noise, spread <= 2c,
                 bid rising on the latest step and still below the pre-drop bid (Astra-like)
  dip          : same drop, no recovery confirmation
  momentum     : rise of >= 2 sigma (buy strength)
  random       : control, one random tradable point per side every ~5 min
Entry = ask one grid step (15 s) after the signal ("lag") or at the signal step ("nolag", optimistic);
the entry step must itself be executable (spread <= 2c).
Exit = bid at the first executable quote (spread <= 5c) at least 1/2/5/10 minutes later; if the book never
becomes executable again the position is held to settlement. Returns include taker fees on every fill
(lib/trading/money.ts formula; no exit fee at settlement). "beforeFees" still pays the spread.
A 2-minute per-side cooldown prevents overlapping trades. CIs resample whole games.
Writes research/studies/results/drop-reversion-<sport>.json.
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd

from common import EXECUTABLE_SPREAD, RESULTS, fee, fmt, load, mean_ci

STEP = 15  # seconds
LOOKBACK = 12  # steps = 3 min
NOISE = 80  # steps = 20 min
HORIZONS = {"1m": 4, "2m": 8, "5m": 20, "10m": 40}
COOLDOWN = 8
VOL_FLOOR = 0.0025


def grid(game: pd.DataFrame) -> pd.DataFrame:
    live = game[game.phase == "live"]
    if len(live) < 20:
        return pd.DataFrame()
    last = live.groupby("ts").tail(1).set_index("ts")[["home_ask", "home_bid", "spread"]]
    idx = np.arange(last.index.min(), last.index.max() + 1, STEP)
    return last.reindex(last.index.union(idx)).ffill().loc[idx].reset_index(names="ts")


def side_frames(g: pd.DataFrame) -> list[pd.DataFrame]:
    home = pd.DataFrame({"ts": g.ts, "ask": g.home_ask, "bid": g.home_bid, "spread": g.spread, "side": "home"})
    away = pd.DataFrame({"ts": g.ts, "ask": 1 - g.home_bid, "bid": 1 - g.home_ask, "spread": g.spread, "side": "away"})
    return [home, away]


def signals(s: pd.DataFrame, rng: np.random.Generator) -> dict[str, np.ndarray]:
    mid = ((s.ask + s.bid) / 2).values
    bid = s.bid.values
    ms = pd.Series(mid)
    peak = ms.shift(1).rolling(LOOKBACK, min_periods=LOOKBACK).max().values
    trough = ms.shift(1).rolling(LOOKBACK, min_periods=LOOKBACK).min().values
    peak_bid = pd.Series(bid).shift(1).rolling(LOOKBACK, min_periods=LOOKBACK).max().values
    vol = ms.diff().shift(LOOKBACK).rolling(NOISE, min_periods=NOISE // 2).std().values
    scale = np.maximum(vol, VOL_FLOOR) * np.sqrt(LOOKBACK)
    drop_z, rise_z = (peak - mid) / scale, (mid - trough) / scale
    tradable = (s.spread.values <= 0.02 + 1e-9) & (s.ask.values > 0.03) & (s.ask.values < 0.97)
    rising = np.r_[False, bid[1:] > bid[:-1] + 1e-9]
    out = {
        "dip_recovery": tradable & (drop_z >= 2) & rising & (bid < peak_bid - 1e-9),
        "dip": tradable & (drop_z >= 2),
        "momentum": tradable & (rise_z >= 2),
        "random": tradable & (rng.random(len(s)) < 1 / 20),
    }
    return {k: cooldown(v) for k, v in out.items()}


def cooldown(mask: np.ndarray) -> np.ndarray:
    keep, next_ok = np.zeros_like(mask), 0
    for i in np.flatnonzero(mask):
        if i >= next_ok:
            keep[i], next_ok = True, i + COOLDOWN
    return keep


def analyze(sport: str) -> dict:
    df = load(sport)
    df = df[df.home_win.isin([0.0, 1.0])]
    rng = np.random.default_rng(11)
    trades = []
    for gid, game in df.groupby("game_id", sort=False):
        coef = float(game.fee_coefficient.dropna().iloc[0]) if game.fee_coefficient.notna().any() else 0.0695
        home_win = float(game.home_win.iloc[0])
        g = grid(game)
        if g.empty:
            continue
        for s in side_frames(g):
            sig = signals(s, rng)
            won = home_win if s.side.iloc[0] == "home" else 1 - home_win
            ask, bid, n = s.ask.values, s.bid.values, len(s)
            ok_exit = np.flatnonzero(s.spread.values <= EXECUTABLE_SPREAD + 1e-9)
            for name, mask in sig.items():
                for i in np.flatnonzero(mask):
                    for lag_name, lag in (("lag", 1), ("nolag", 0)):
                        e = i + lag
                        if e >= n or s.spread.values[e] > 0.02 + 1e-9:
                            continue
                        for h_name, h in HORIZONS.items():
                            if e + h >= n:
                                continue
                            j = np.searchsorted(ok_exit, e + h)
                            settled = j >= len(ok_exit)
                            exit_px = won if settled else bid[ok_exit[j]]
                            trades.append((gid, s.side.iloc[0], name, lag_name, h_name, ask[e], exit_px, settled, coef))
    t = pd.DataFrame(trades, columns=["game_id", "side", "signal", "latency", "horizon", "entry_ask", "exit_px", "settled", "coef"])
    cost = t.entry_ask + fee(t.entry_ask, t.coef)
    proceeds = t.exit_px - np.where(t.settled, 0.0, fee(t.exit_px, t.coef))
    t["net"] = (proceeds - cost) / cost
    t["gross_ret"] = (t.exit_px - t.entry_ask) / t.entry_ask
    res = {"sport": sport, "games": int(df.game_id.nunique()), "trades": len(t), "results": {}}
    for (sig, lat, hor), part in t.groupby(["signal", "latency", "horizon"]):
        res["results"][f"{sig}|{lat}|{hor}"] = {"net": mean_ci(part.net, part.game_id.values),
                                                "beforeFees": mean_ci(part.gross_ret, part.game_id.values),
                                                "winRate": float((part.net > 0).mean()), "avgEntry": float(part.entry_ask.mean()),
                                                "settledShare": float(part.settled.mean())}
    return res


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    for sport in sys.argv[1:] or ["nfl"]:
        res = analyze(sport)
        (RESULTS / f"drop-reversion-{sport}.json").write_text(json.dumps(res, indent=2))
        print(f"\n== {sport}: {res['games']} games, {res['trades']} simulated trades")
        for key, v in sorted(res["results"].items()):
            sig, lat, hor = key.split("|")
            if lat == "lag":
                print(f"  {sig:13s} {hor:>3s} net {fmt(v['net'])} | before fees {fmt(v['beforeFees'])} | win {v['winRate']:.2f}")


if __name__ == "__main__":
    main()
