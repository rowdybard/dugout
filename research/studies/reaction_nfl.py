"""How fast and how accurately does the Polymarket US NFL price react to plays?

Usage: research/.venv/Scripts/python research/studies/reaction_nfl.py
Needs research/data/aligned/nfl.parquet and research/data/nfl/pbp.

For every play in a priced game: snap time T (nflverse time_of_day) and the information content of the
play, dWP = vegas_home_wp(next play) - vegas_home_wp(this play) (nflfastR's spread-aware model).
The market's home mid (last observation at or before each time) is read at T-5s and at T+15/30/60/120 s,
at the next snap, and 60 s after it. Outputs:
  - slope of market move on dWP per horizon (1.0 = fully priced; <1 = under-reaction so far)
  - share of the eventual move (next snap + 60 s) already done at each horizon (speed)
  - big plays only (|dWP| >= 5 points) and by play type
  - reversal check: does the move from T to next snap partially reverse over the next 2-5 min?
Writes research/studies/results/reaction-nfl.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from common import DATA, RESULTS, load

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "models" / "nfl"))
from features import PBP_COLUMNS, build  # noqa: E402

OFFSETS = {"pre": -5, "+15s": 15, "+30s": 30, "+60s": 60, "+120s": 120}


def price_at(ts: np.ndarray, mid: np.ndarray, when: np.ndarray) -> np.ndarray:
    idx = np.searchsorted(ts, when, side="right") - 1
    out = np.where(idx >= 0, mid[np.clip(idx, 0, len(mid) - 1)], np.nan)
    return out


def slope(x, y) -> float | None:
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 30:
        return None
    x, y = x[ok], y[ok]
    return float((x * y).sum() / (x * x).sum())  # through the origin: pure pass-through ratio


def main() -> None:
    aligned = load("nfl")
    seasons = sorted(aligned.season.unique())
    plays = []
    for season in seasons:
        raw = pd.read_parquet(DATA / "nfl" / "pbp" / f"play_by_play_{int(season)}.parquet")
        p = build(raw[[c for c in PBP_COLUMNS if c in raw.columns]])
        plays.append(p[p.game_id.isin(aligned.game_id.unique())])
    plays = pd.concat(plays).dropna(subset=["t"]).sort_values(["game_id", "t"])
    plays["next_t"] = plays.groupby("game_id").t.shift(-1)
    plays["next_wp"] = plays.groupby("game_id").vegas_home_wp.shift(-1)
    plays["dwp"] = plays.next_wp - plays.vegas_home_wp
    plays = plays.dropna(subset=["dwp", "next_t"])
    rows = []
    for gid, g in plays.groupby("game_id"):
        m = aligned[aligned.game_id == gid]
        ts, mid = m.ts.values.astype(float), m.home_mid.values
        snap = g.t.astype("int64").values / 1e9
        nxt = g.next_t.astype("int64").values / 1e9
        rec = {"game_id": gid, "dwp": g.dwp.values, "play_type": g.play_type.values, "gap": nxt - snap}
        for name, off in OFFSETS.items():
            rec[name] = price_at(ts, mid, snap + off)
        rec["next_snap"] = price_at(ts, mid, nxt)
        rec["next+60s"] = price_at(ts, mid, nxt + 60)
        rec["next+180s"] = price_at(ts, mid, nxt + 180)
        rec["next+300s"] = price_at(ts, mid, nxt + 300)
        rows.append(pd.DataFrame(rec))
    r = pd.concat(rows, ignore_index=True).dropna(subset=["pre"])
    horizons = ["+15s", "+30s", "+60s", "+120s", "next_snap", "next+60s"]
    out = {"plays": len(r), "games": int(r.game_id.nunique()), "all": {}, "bigPlays": {}, "byPlayType": {}, "reversal": {}}
    for label, part in (("all", r), ("bigPlays", r[r.dwp.abs() >= .05])):
        final = part["next+60s"] - part.pre
        for h in horizons:
            move = part[h] - part.pre
            done = np.where(final.abs() > .005, move / final, np.nan)
            out[label][h] = {"slopeVsModel": slope(part.dwp.values, move.values), "medianShareOfFinalMove": float(np.nanmedian(done)) if np.isfinite(done).any() else None}
        out[label]["n"] = len(part)
    for pt, part in r[r.dwp.abs() >= .03].groupby("play_type"):
        if len(part) >= 30:
            out["byPlayType"][pt] = {"n": len(part), "slopeAtNextSnap": slope(part.dwp.values, (part.next_snap - part.pre).values),
                                     "slopeAt+60s": slope(part.dwp.values, (part["+60s"] - part.pre).values)}
    big = r[r.dwp.abs() >= .05]
    first = (big.next_snap - big.pre) * np.sign(big.dwp)
    for later in ("next+60s", "next+180s", "next+300s"):
        after = (big[later] - big.next_snap) * np.sign(big.dwp)
        out["reversal"][later] = {"n": int(np.isfinite(after).sum()), "meanFirstMove": float(np.nanmean(first)),
                                  "meanFollowThrough": float(np.nanmean(after))}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "reaction-nfl.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
