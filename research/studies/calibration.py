"""Is the Polymarket US price itself biased? Calibration by game phase and price band.

Usage: research/.venv/Scripts/python research/studies/calibration.py nfl [mlb ...]
For each game it samples the market at fixed checkpoints (last pregame quote, then every live
10% of observed game time) so long games do not dominate. It reports:
  - Brier score of the market mid vs outcomes, and a logistic fit outcome ~ logit(mid)
    (slope < 1 = overconfident prices / favourite bias, slope > 1 = underconfident)
  - outcome frequency vs price band, and the hold-to-settlement return of buying at the ask in each
    band after the entry fee (positive = that band is systematically cheap)
Writes research/studies/results/calibration-<sport>.json and prints a summary.
"""
from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from common import RESULTS, fmt, load, mean_ci, settle_return

BANDS = [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1.0]


def checkpoints(df: pd.DataFrame) -> pd.DataFrame:
    """Checkpoints use executable quotes only (spread <= EXECUTABLE_SPREAD); placeholders are skipped."""
    rows = []
    for gid, g in df[df.executable].groupby("game_id", sort=False):
        pre = g[g.phase == "pregame"]
        if not pre.empty:
            rows.append(pre.iloc[-1].to_dict() | {"checkpoint": "pregame_close"})
        live = g[g.phase == "live"]
        if len(live) < 10:
            continue
        span = (live.ts.iloc[-1] - live.ts.iloc[0])
        for k in range(1, 10):
            target = live.ts.iloc[0] + span * k / 10
            row = live.iloc[int(np.searchsorted(live.ts.values, target))]
            rows.append(row.to_dict() | {"checkpoint": f"live_{k * 10:02d}"})
    return pd.DataFrame(rows)


def analyze(sport: str) -> dict:
    df = load(sport)
    df = df[df.home_win.isin([0.0, 1.0])]
    cp = checkpoints(df)
    out = {"sport": sport, "games": int(df.game_id.nunique()), "checkpointRows": len(cp), "byCheckpoint": {}, "byBand": {}}
    for name, part in [("all", cp), ("pregame", cp[cp.checkpoint == "pregame_close"]), ("live", cp[cp.checkpoint != "pregame_close"])]:
        if len(part) < 30:
            continue
        mid = part.home_mid.clip(.005, .995).values
        y = part.home_win.values
        logit = np.log(mid / (1 - mid)).reshape(-1, 1)
        lr = LogisticRegression(C=1e6).fit(logit, y)
        out["byCheckpoint"][name] = {"n": len(part), "brier": float(np.mean((mid - y) ** 2)),
                                     "baseBrier": float(np.mean((y.mean() - y) ** 2)),
                                     "slope": float(lr.coef_[0][0]), "intercept": float(lr.intercept_[0])}
    # Price bands, both sides: buying home at home_ask, or away at (1 - home_bid).
    sides = pd.concat([
        pd.DataFrame({"game_id": cp.game_id, "ask": cp.home_ask, "won": cp.home_win, "coef": cp.fee_coefficient}),
        pd.DataFrame({"game_id": cp.game_id, "ask": 1 - cp.home_bid, "won": 1 - cp.home_win, "coef": cp.fee_coefficient}),
    ])
    sides["band"] = pd.cut(sides.ask, BANDS, include_lowest=True)
    for band, part in sides.groupby("band", observed=True):
        ret = settle_return(part.ask, part.won, part.coef.fillna(.0695))
        out["byBand"][str(band)] = {"n": len(part), "avgAsk": float(part.ask.mean()), "winRate": float(part.won.mean()),
                                    "holdReturn": mean_ci(ret, part.game_id.values)}
    return out


def main() -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    for sport in sys.argv[1:] or ["nfl"]:
        res = analyze(sport)
        (RESULTS / f"calibration-{sport}.json").write_text(json.dumps(res, indent=2))
        print(f"\n== {sport}: {res['games']} games, {res['checkpointRows']} checkpoints")
        for k, v in res["byCheckpoint"].items():
            print(f"  {k:8s} n={v['n']:5d} brier={v['brier']:.4f} (base {v['baseBrier']:.4f}) slope={v['slope']:.2f} int={v['intercept']:+.2f}")
        for band, v in res["byBand"].items():
            print(f"  ask {band:12s} n={v['n']:5d} avgAsk={v['avgAsk']:.3f} win={v['winRate']:.3f} hold {fmt(v['holdReturn'])}")


if __name__ == "__main__":
    main()
