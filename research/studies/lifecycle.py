"""Shared lifecycle rules for pre-registered strategy studies (docs/STRATEGY-ARCHITECTURE.md#lifecycle).

Every study that can write an evidence row uses these, so the kill rule is the same for all strategies:

  split    games are ordered by their first observation (not by any result) and cut at the median: the earlier half
           is discovery, the later half holdout. The rule was written before either half was looked at.
  verdict  "lead"     both halves have a positive mean return after costs, the whole sample has at least the spec's
                      minimum trades, and the holdout has at least a third of them. Paper forward testing only.
           "dropped"  enough trades, and either half is not positive. A strategy that only works in one half is noise.
           None       too few trades: no evidence row; the bot keeps measuring the version in shadow.
           A study never makes a row "proven"; only a matching forward paper test can (docs/DECISION-ENGINE.md).
  rows     name the exact version ("surprise-fade@1"), so a new version never inherits an old version's evidence.

Changing a rule after seeing a result means a new version (lib/decision/catalog.ts) with its own run.
"""
from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pandas as pd

from common import mean_ci


def split_games(starts: pd.Series) -> tuple[set, set]:
    """(discovery, holdout) game ids from each game's first observation time; ties go to discovery."""
    order = starts.sort_values(kind="stable")
    if order.empty:
        return set(), set()
    cut = order.iloc[(len(order) - 1) // 2]
    return set(order[order <= cut].index), set(order[order > cut].index)


def interval(trades: pd.DataFrame, column: str = "ret") -> dict:
    ok = trades[np.isfinite(trades[column].to_numpy(float))]
    return mean_ci(ok[column].to_numpy(float), ok.game.to_numpy())


def halves(trades: pd.DataFrame, discovery: set, holdout: set, column: str = "ret") -> dict:
    return {"discovery": interval(trades[trades.game.isin(discovery)], column), "holdout": interval(trades[trades.game.isin(holdout)], column)}


def verdict(pooled: dict, split: dict, min_trades: int, unit: str = "return") -> tuple[str | None, str]:
    """('lead' | 'dropped' | None, plain reason). See the module docstring. `unit`: "return" (per dollar) or "cents"."""
    show = (lambda x: f"{(x or 0) * 100:+.1f}%") if unit == "return" else (lambda x: f"{(x or 0):+.2f}c")
    disc, hold = split["discovery"], split["holdout"]
    need_holdout = max(1, min_trades // 3)
    if pooled["n"] < min_trades or hold["n"] < need_holdout:
        return None, f"{pooled['n']} trades ({hold['n']} in the holdout); the spec needs {min_trades} ({need_holdout} in the holdout) before a verdict."
    if disc["mean"] is not None and hold["mean"] is not None and disc["mean"] > 0 and hold["mean"] > 0:
        return "lead", f"Positive in discovery ({show(disc['mean'])}) and in the later holdout ({show(hold['mean'])}) after costs."
    worst = "holdout" if (hold["mean"] or 0) <= 0 else "discovery"
    return "dropped", f"Not positive in the {worst} half ({show(split[worst]['mean'])}) after costs."


def evidence_row(*, id: str, title: str, status: str, sport: str, phases: Iterable[str], styles: Iterable[str], strategy: str, version: str,
                 pooled: dict, sample: str, source: str, plain: str, conservative: dict | None = None, unit: str = "return") -> dict:
    """An evidence row (lib/decision/evidence.ts) naming one strategy version."""
    row = {"id": id, "title": title, "status": status, "sports": [sport.upper()], "phases": list(phases), "styles": list(styles),
           "strategies": [f"{strategy}@{version}"],
           "estimate": {"mean": round(pooled["mean"], 4), "lo": round(pooled["lo"], 4), "hi": round(pooled["hi"], 4), "unit": unit},
           "sample": sample, "source": source, "plain": plain}
    if conservative:
        row["conservative"] = conservative
    return row
