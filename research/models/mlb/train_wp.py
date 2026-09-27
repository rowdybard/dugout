"""MLB live win-probability model (LightGBM + isotonic) on Stats API plate appearances.

Usage: research/.venv/Scripts/python research/models/mlb/train_wp.py
Split (time-ordered): train 2021-2024, validate 2025 (early stopping + calibration + feature choices),
test 2026 (the Polymarket US MLB era; not used for any choice).
Also fits a state-only model (no team/pitcher/batter information) to show what the extra layers add.
Outputs research/models/mlb/artifacts/{wp_lgbm.txt, wp_isotonic.json, report.json} and
research/data/models/mlb_wp_predictions.parquet (held-out 2026 rows for market comparisons).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from features import FEATURES, build  # noqa: E402

DATA = HERE.parents[1] / "data"
ART = HERE / "artifacts"
TRAIN, VALID, TEST = range(2021, 2025), [2025], [2026]
STATE_ONLY = ["inning", "is_top", "outs", "on1", "on2", "on3", "score_diff", "abs_score_diff", "extra",
              "outs_remaining_home", "outs_remaining_away"]


def load() -> pd.DataFrame:
    parts = {"games": [], "pas": [], "events": []}
    for folder in sorted((DATA / "mlb" / "extract").glob("20*")):
        parts["games"].append(pd.read_parquet(folder / "games.parquet"))
        parts["pas"].append(pd.read_parquet(folder / "plate_appearances.parquet"))
        parts["events"].append(pd.read_parquet(folder / "events.parquet", columns=["gamePk", "atBatIndex", "isPitch"]))
    games, pas, events = (pd.concat(v, ignore_index=True) for v in parts.values())
    df = build(games, pas, events)
    return df[df.home_win.isin([0.0, 1.0])].reset_index(drop=True)


def metrics(y, p) -> dict:
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return {"n": int(len(y)), "brier": float(np.mean((p - y) ** 2)),
            "logloss": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))}


def fit(tr, va, feats):
    mono = [1 if f in ("score_diff", "elo_diff") else 0 for f in feats]
    params = {"objective": "binary", "learning_rate": 0.03, "num_leaves": 31, "min_data_in_leaf": 300,
              "feature_fraction": 0.9, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 2.0,
              "monotone_constraints": mono, "verbose": -1, "seed": 7}
    dtr = lgb.Dataset(tr[feats], tr.home_win)
    dva = lgb.Dataset(va[feats], va.home_win, reference=dtr)
    model = lgb.train(params, dtr, 4000, valid_sets=[dva], callbacks=[lgb.early_stopping(150, verbose=False)])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999).fit(
        model.predict(va[feats], num_iteration=model.best_iteration), va.home_win)
    return model, iso, (lambda x: iso.predict(model.predict(x[feats], num_iteration=model.best_iteration)))


def main() -> None:
    df = load()
    tr, va, te = (df[df.season.isin(r)] for r in (TRAIN, VALID, TEST))
    print(f"PAs: train {len(tr)}, valid {len(va)}, test {len(te)}", flush=True)
    report = {"splits": {"train": "2021-2024", "valid": "2025", "test": "2026"}, "features": FEATURES}
    model, iso, predict = fit(tr, va, FEATURES)
    _, _, predict_state = fit(tr, va, STATE_ONLY)
    for name, part in (("valid", va), ("test", te)):
        if part.empty:
            continue
        y = part.home_win.values
        report[name] = {"full": metrics(y, predict(part)), "stateOnly": metrics(y, predict_state(part)),
                        "eloOnlyPregame": metrics(y, 1 / (1 + 10 ** (-part.elo_diff.fillna(30).values / 400))),
                        "constant": metrics(y, np.full(len(y), tr.home_win.mean()))}
        print(name, json.dumps(report[name]), flush=True)
    report["bestIteration"] = model.best_iteration
    report["featureGain"] = dict(sorted(zip(FEATURES, model.feature_importance("gain").round(1).tolist()), key=lambda kv: -kv[1]))
    ART.mkdir(parents=True, exist_ok=True)
    model.save_model(str(ART / "wp_lgbm.txt"), num_iteration=model.best_iteration)
    (ART / "wp_isotonic.json").write_text(json.dumps({"x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()}))
    (ART / "report.json").write_text(json.dumps(report, indent=2))
    if not te.empty:
        out = te[["gamePk", "atBatIndex", "startMs", "season", "home_win", *FEATURES]].copy()
        out["model_wp"] = predict(te)
        out["state_wp"] = predict_state(te)
        (DATA / "models").mkdir(parents=True, exist_ok=True)
        out.to_parquet(DATA / "models" / "mlb_wp_predictions.parquet", index=False)
    print("saved", ART)


if __name__ == "__main__":
    main()
