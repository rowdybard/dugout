"""MLB: does the live win-probability model beat the Polymarket US price at the same moments?

Usage: research/.venv/Scripts/python research/studies/fair_value_mlb.py
Joins held-out 2026 model predictions (research/data/models/mlb_wp_predictions.parquet, one per PA start)
to the market's last executable home mid at or before that PA start. The model sees only the pre-PA state.
1. Brier: market vs full model vs state-only model (one sample per PA)
2. Strategy: at PA starts where model - ask - fee >= threshold (either side), buy and hold to settlement;
   first signal per game only. Writes research/studies/results/fair-value-mlb.json.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from common import DATA, RESULTS, fee, fmt, load, mean_ci, settle_return


def main() -> None:
    pred = pd.read_parquet(DATA / "models" / "mlb_wp_predictions.parquet")
    mk = load("mlb")
    mk = mk[mk.executable & (mk.phase == "live")][["gamePk", "ts", "home_ask", "home_bid", "home_mid", "spread", "fee_coefficient"]]
    rows = []
    for pk, p in pred.groupby("gamePk"):
        m = mk[mk.gamePk == pk]
        if m.empty:
            continue
        p = p.dropna(subset=["startMs"]).sort_values("startMs")
        idx = np.searchsorted(m.ts.values, p.startMs.values / 1000, side="right") - 1
        ok = idx >= 0
        sel = m.iloc[idx[ok]]
        part = p[ok].reset_index(drop=True)
        rows.append(pd.concat([part[["gamePk", "atBatIndex", "home_win", "model_wp", "state_wp", "inning"]],
                               sel[["home_ask", "home_bid", "home_mid", "spread", "fee_coefficient"]].reset_index(drop=True)], axis=1))
    d = pd.concat(rows, ignore_index=True)
    d = d[d.home_win.isin([0.0, 1.0])]
    y = d.home_win.values
    acc = {name: float(np.mean((d[col].values - y) ** 2)) for name, col in
           (("market_mid", "home_mid"), ("model_full", "model_wp"), ("model_state_only", "state_wp"))}
    acc["n"] = len(d)
    acc["games"] = int(d.gamePk.nunique())
    d["blend"] = (d.model_wp + d.home_mid) / 2
    acc["blend_model_market"] = float(np.mean((d.blend.values - y) ** 2))
    strat = {}
    for thr in (0.02, 0.04, 0.06, 0.08):
        trades = []
        for pk, g in d[d.spread <= 0.02 + 1e-9].groupby("gamePk", sort=False):
            coef = g.fee_coefficient.fillna(0.0695).values
            away_ask = 1 - g.home_bid.values
            eh = g.model_wp.values - g.home_ask.values - fee(g.home_ask.values, coef)
            ea = (1 - g.model_wp.values) - away_ask - fee(away_ask, coef)
            hit = np.flatnonzero((eh >= thr) | (ea >= thr))
            if not hit.size:
                continue
            i = hit[0]
            home = eh[i] >= ea[i]
            trades.append((pk, g.home_ask.values[i] if home else away_ask[i],
                           g.home_win.values[i] if home else 1 - g.home_win.values[i], coef[i], g.inning.values[i]))
        t = pd.DataFrame(trades, columns=["gamePk", "ask", "won", "coef", "inning"])
        if not t.empty:
            strat[str(thr)] = {"trades": len(t), "net": mean_ci(settle_return(t.ask, t.won, t.coef)),
                               "winRate": float(t.won.mean()), "avgAsk": float(t.ask.mean()), "medianInning": float(t.inning.median())}
    out = {"accuracy": acc, "strategy": strat}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "fair-value-mlb.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(acc, indent=1))
    for k, v in strat.items():
        print(f"  thr {k}: trades={v['trades']} net {fmt(v['net'])} win={v['winRate']:.2f} avgAsk={v['avgAsk']:.2f} inning~{v['medianInning']}")


if __name__ == "__main__":
    main()
