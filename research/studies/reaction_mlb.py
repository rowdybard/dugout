"""How fast and how completely does the Polymarket US MLB price react to plate-appearance results?

Usage: research/.venv/Scripts/python research/studies/reaction_mlb.py
Needs research/data/aligned/mlb.parquet, the MLB extract, and the trained MLB model
(research/models/mlb/artifacts). Only densely sampled games (live median gap <= 5 s) are used.

For each PA, the result time T is the PA end timestamp from the Stats API (the Gameday operator's record,
normally seconds after the ball is in play). Information content dWP = model WP before the next PA minus
model WP before this PA. Market home mid is read at T-10 s, T+5/10/20/30/60/120 s:
  - slope of the market move on dWP (pass-through) and share of the eventual (T+120 s) move done by each horizon
  - pre-move: how much the market moved between T-10 s and T (it may know before the operator records it)
  - big PAs (|dWP| >= 5 points), by event type, and continuation after T+30 s
Writes research/studies/results/reaction-mlb.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from common import DATA, RESULTS, load

MODEL = Path(__file__).resolve().parents[1] / "models" / "mlb"
sys.path.insert(0, str(MODEL))
from features import FEATURES, build  # noqa: E402

OFFSETS = {"-30s": -30, "-10s": -10, "T": 0, "+5s": 5, "+10s": 10, "+20s": 20, "+30s": 30, "+60s": 60, "+120s": 120, "+300s": 300}


def price_at(ts, mid, when):
    idx = np.searchsorted(ts, when, side="right") - 1
    return np.where(idx >= 0, mid[np.clip(idx, 0, len(mid) - 1)], np.nan)


def slope(x, y):
    ok = np.isfinite(x) & np.isfinite(y)
    return float((x[ok] * y[ok]).sum() / (x[ok] ** 2).sum()) if ok.sum() >= 30 else None


def main() -> None:
    aligned = load("mlb")
    live = aligned[aligned.phase == "live"]
    dense = live.groupby("game_id").ts.apply(lambda s: s.diff().median()) <= 5
    aligned = aligned[aligned.game_id.isin(dense[dense].index) & aligned.executable]
    pks = set(aligned.gamePk.unique())
    print(f"dense-sampled games: {len(pks)}", flush=True)
    seasons = sorted(aligned.season.unique())
    games, pas, events = [], [], []
    for s in range(2021, int(max(seasons)) + 1):  # history before the test season feeds causal Elo/form
        folder = DATA / "mlb" / "extract" / str(s)
        if folder.exists():
            games.append(pd.read_parquet(folder / "games.parquet"))
            pas.append(pd.read_parquet(folder / "plate_appearances.parquet"))
            events.append(pd.read_parquet(folder / "events.parquet", columns=["gamePk", "atBatIndex", "isPitch"]))
    feats = build(pd.concat(games), pd.concat(pas), pd.concat(events))
    feats = feats[feats.gamePk.isin(pks)].copy()
    booster = lgb.Booster(model_file=str(MODEL / "artifacts" / "wp_lgbm.txt"))
    iso = json.loads((MODEL / "artifacts" / "wp_isotonic.json").read_text())
    feats["wp"] = np.interp(booster.predict(feats[FEATURES]), iso["x"], iso["y"])
    pa = pd.concat(pas)
    feats = feats.merge(pa[["gamePk", "atBatIndex", "endMs", "eventType"]], on=["gamePk", "atBatIndex"], how="left")
    feats = feats.sort_values(["gamePk", "atBatIndex"])
    final = feats.groupby("gamePk").home_win.first()
    feats["wp_next"] = feats.groupby("gamePk").wp.shift(-1)
    last = feats.wp_next.isna()
    feats.loc[last, "wp_next"] = feats.loc[last, "gamePk"].map(final)
    feats["dwp"] = feats.wp_next - feats.wp
    rows = []
    for pk, g in feats.dropna(subset=["endMs"]).groupby("gamePk"):
        m = aligned[aligned.gamePk == pk]
        ts, mid = m.ts.values.astype(float), m.home_mid.values
        T = g.endMs.values / 1000
        rec = {"gamePk": pk, "dwp": g.dwp.values, "eventType": g.eventType.values}
        for name, off in OFFSETS.items():
            rec[name] = price_at(ts, mid, T + off)
        rows.append(pd.DataFrame(rec))
    r = pd.concat(rows, ignore_index=True).dropna(subset=["-10s", "+120s"])
    out = {"games": int(r.gamePk.nunique()), "pas": len(r), "all": {}, "bigPAs": {}, "byEvent": {}, "continuation": {}}
    for label, part in (("all", r), ("bigPAs", r[r.dwp.abs() >= .05])):
        final_move = part["+120s"] - part["-10s"]
        res = {"n": len(part)}
        for h in ["-30s", "T", "+5s", "+10s", "+20s", "+30s", "+60s", "+120s", "+300s"]:
            move = part[h] - part["-10s"]
            share = np.where(final_move.abs() > .005, move / final_move, np.nan)
            res[h] = {"slopeVsModel": slope(part.dwp.values, move.values),
                      "medianShareOfT+120Move": float(np.nanmedian(share)) if np.isfinite(share).any() else None}
        out[label] = res
    for ev, part in r[r.dwp.abs() >= .03].groupby("eventType"):
        if len(part) >= 50:
            out["byEvent"][ev] = {"n": len(part), "slopeAtT+10s": slope(part.dwp.values, (part["+10s"] - part["-10s"]).values),
                                  "slopeAtT+60s": slope(part.dwp.values, (part["+60s"] - part["-10s"]).values)}
    big = r[r.dwp.abs() >= .05]
    sign = np.sign(big.dwp)
    for a, b in (("-10s", "T"), ("T", "+10s"), ("+10s", "+30s"), ("+30s", "+120s"), ("+120s", "+300s")):
        out["continuation"][f"{a}->{b}"] = float(np.nanmean((big[b] - big[a]) * sign))
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "reaction-mlb.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
