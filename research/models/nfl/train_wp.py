"""NFL live win-probability model (LightGBM + isotonic calibration) on nflverse play-by-play.

Usage: research/.venv/Scripts/python research/models/nfl/train_wp.py
Split (time-ordered, no shuffling): train 1999-2022, validate 2023-2024 (early stopping + calibration),
test 2025-2026 (the Polymarket US era; never used for any choice).
Benchmarks on the same plays: nflfastR's home_wp and vegas_home_wp columns.
Outputs:
  research/models/nfl/artifacts/wp_lgbm.txt         LightGBM model
  research/models/nfl/artifacts/wp_isotonic.json    calibration breakpoints
  research/models/nfl/artifacts/report.json         metrics
  research/data/models/nfl_wp_predictions.parquet   held-out predictions (for market comparisons)
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
from features import FEATURES, PBP_COLUMNS, build  # noqa: E402

DATA = HERE.parents[1] / "data"
ART = HERE / "artifacts"
TRAIN, VALID, TEST = range(1999, 2023), range(2023, 2025), range(2025, 2027)


def load() -> pd.DataFrame:
    frames = []
    for path in sorted((DATA / "nfl" / "pbp").glob("play_by_play_*.parquet")):
        pbp = pd.read_parquet(path)
        frames.append(build(pbp[[c for c in PBP_COLUMNS if c in pbp.columns]]))
    df = pd.concat(frames, ignore_index=True)
    # Train only on real snaps with a known situation; drop ties (settle at 0.5) and unfinished games.
    keep = df.play_type.notna() & df.game_seconds_remaining.notna() & df.home_win.isin([0.0, 1.0])
    return df[keep].reset_index(drop=True)


def metrics(y, p) -> dict:
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return {"n": int(len(y)), "brier": float(np.mean((p - y) ** 2)),
            "logloss": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))}


def main() -> None:
    df = load()
    tr, va, te = (df[df.season.isin(r)] for r in (TRAIN, VALID, TEST))
    print(f"plays: train {len(tr)}, valid {len(va)}, test {len(te)}", flush=True)
    constraints = [1 if f in ("score_diff", "spread_line", "spread_time", "spread_remaining", "diff_time_ratio") else 0 for f in FEATURES]
    params = {"objective": "binary", "learning_rate": 0.05, "num_leaves": 63, "min_data_in_leaf": 200,
              "feature_fraction": 0.9, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0,
              "monotone_constraints": constraints, "verbose": -1, "seed": 7}
    dtrain = lgb.Dataset(tr[FEATURES], tr.home_win)
    dvalid = lgb.Dataset(va[FEATURES], va.home_win, reference=dtrain)
    model = lgb.train(params, dtrain, 3000, valid_sets=[dvalid], callbacks=[lgb.early_stopping(100, verbose=False)])
    raw_va = model.predict(va[FEATURES], num_iteration=model.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999).fit(raw_va, va.home_win)
    predict = lambda x: iso.predict(model.predict(x[FEATURES], num_iteration=model.best_iteration))  # noqa: E731
    report = {"bestIteration": model.best_iteration, "features": FEATURES, "splits": {"train": "1999-2022", "valid": "2023-2024", "test": "2025-2026"}}
    for name, part in (("valid", va), ("test", te)):
        p = predict(part)
        row = {"ours": metrics(part.home_win.values, p)}
        for col in ("home_wp", "vegas_home_wp"):
            ok = part[col].notna()
            row[f"nflfastR_{col}"] = metrics(part.home_win.values[ok], part[col].values[ok])
            row[f"ours_on_same_{col}"] = metrics(part.home_win.values[ok], p[ok.values])
        report[name] = row
        print(name, json.dumps(row), flush=True)
    importance = dict(zip(FEATURES, model.feature_importance("gain").round(1).tolist()))
    report["featureGain"] = dict(sorted(importance.items(), key=lambda kv: -kv[1]))
    ART.mkdir(parents=True, exist_ok=True)
    model.save_model(str(ART / "wp_lgbm.txt"), num_iteration=model.best_iteration)
    (ART / "wp_isotonic.json").write_text(json.dumps({"x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()}))
    (ART / "report.json").write_text(json.dumps(report, indent=2))
    out = te[["game_id", "play_id", "t", "season", "week", "home_team", "away_team", "home_win", "home_wp", "vegas_home_wp", "wpa", *FEATURES]].copy()
    out["model_wp"] = predict(te)
    (DATA / "models").mkdir(parents=True, exist_ok=True)
    out.to_parquet(DATA / "models" / "nfl_wp_predictions.parquet", index=False)
    print("saved", ART)


if __name__ == "__main__":
    main()
