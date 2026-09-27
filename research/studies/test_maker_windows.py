"""Synthetic tests for maker_windows.py (no data files, no network). Run:
  python research/studies/test_maker_windows.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import maker_windows as mw  # noqa: E402


def test_calm_needs_thirty_seconds_of_quiet() -> None:
    t = np.arange(0.0, 100, 5)
    mid = np.where(t < 50, 0.5, 0.53)
    calm = mw.calm_mask(t, mid)
    assert not calm[0] and calm[6], calm          # nothing 30 s back at the start; flat by 30 s
    assert not calm[10] and not calm[15] and calm[17], calm  # the 3c jump at 50 s is recent until 80 s


def test_orders_rest_only_where_permitted_and_fill_conservatively() -> None:
    t = np.array([0, 5, 10, 15, 20, 25, 30, 90], float)
    bid = np.array([0.50, 0.50, 0.49, 0.50, 0.50, 0.49, 0.49, 0.49])
    ask = np.array([0.51, 0.51, 0.50, 0.51, 0.51, 0.49, 0.50, 0.50])
    ok = np.array([True, True, True, False, True, True, True, True])
    fills = mw.simulate(t, bid, ask, ok, 1.0, "conservative")
    bids = [f for f in fills if f[0] == "bid"]
    # Rests at 50c from t=0; at t=10 the ask reaches 50c (trades through): filled. Requote from 15 s; t=15 is not
    # permitted, so the next rest is 50c at t=20; at t=25 the ask is 49c: filled again.
    assert [f[1] for f in bids] == [10.0, 25.0] and [f[2] for f in bids] == [0.50, 0.50], bids
    rebate = 100 * 0.0125 * 0.25
    assert math.isclose(bids[0][4], 100 * (0.495 - 0.50) + rebate, abs_tol=1e-9), bids[0]  # mid at 70 s is the 30 s book (49.5c)
    assert math.isclose(bids[0][6], 100 * (1.0 - 0.50) + rebate, abs_tol=1e-9)
    # A permission gap cancels a resting order: no fill at a book that arrives after the pull.
    gap = mw.simulate(np.array([0, 5, 10], float), np.array([0.5, 0.5, 0.5]), np.array([0.51, 0.51, 0.5]), np.array([True, True, False]), 1.0, "conservative")
    assert not [f for f in gap if f[0] == "bid"], gap


def test_windows_from_snaps() -> None:
    t = np.arange(0.0, 400, 1.0)
    mid, spread = np.full(len(t), 0.5), np.full(len(t), 0.01)
    masks = mw.windows_from_snaps(t, mid, spread, snaps=np.array([100.0, 200.0, 300.0]), scores=np.array([210.0]))
    window = t[masks["window"]]
    assert window.min() == 215 and window.max() == 234, window  # the score at 210 s is reported at 215 s, for 20 s
    pulled = t[~masks["maker-quote"]]
    assert {105.0, 134.0, 205.0, 334.0} <= set(pulled) and 135 not in pulled and 104 not in pulled
    between = t[masks["between-snaps"]]
    assert 112 in between and 131 in between and 132 not in between and 111 not in between
    assert masks["always"].all()
    wide = mw.windows_from_snaps(t, mid, np.full(len(t), 0.04), np.array([100.0]), np.array([110.0]))
    assert not wide["window"].any() and wide["maker-quote"].any(), "3c limit for windows, 5c for maker-quote"


def test_windows_from_feed() -> None:
    t = np.arange(0.0, 100, 5)
    between = (t >= 40) & (t < 90)
    report = np.where(t < 40, 1000.0, np.where(t < 90, 2000.0, 3000.0))
    masks = mw.windows_from_feed(t, np.full(len(t), 0.5), np.full(len(t), 0.01), between, report)
    assert list(t[masks["window"]]) == [40, 45, 50, 55, 60], t[masks["window"]]
    assert not masks["maker-quote"][8] and masks["maker-quote"][14], "pulled 30 s after each new report"


def fills(n: int, conservative: float, optimistic: float, base: float, games: int = 60) -> pd.DataFrame:
    rows = []
    for i in range(n):
        game = f"g{i % games}"
        rows.append([game, "window", "optimistic", "bid", float(i), 0.5, 0.1, optimistic, 0.1, 1.0])
        rows.append([game, "window", "conservative", "bid", float(i), 0.5, 0.1, conservative, 0.1, 1.0])
        rows.append([game, "maker-quote", "conservative", "bid", float(i), 0.5, 0.1, base, 0.1, 1.0])
        rows.append([game, "maker-quote", "optimistic", "bid", float(i), 0.5, 0.1, base, 0.1, 1.0])
    return pd.DataFrame(rows, columns=["game", "variant", "model", "side", "t", "px", "m10", "m60", "m300", "settle"])


def test_verdict_needs_both_halves_and_a_paired_improvement() -> None:
    games = pd.Series({f"g{i}": float(i) for i in range(60)})
    lead = mw.summarize(fills(400, conservative=-0.2, optimistic=0.3, base=-0.8), games, "nfl", "test")
    row = lead["evidence"]
    assert row["status"] == "lead" and row["strategies"] == ["quiet-window-maker@1"] and row["styles"] == ["maker"], row
    assert row["estimate"]["unit"] == "cents" and math.isclose(row["conservative"]["mean"], -0.2) and lead["paired"]["conservative"]["mean"] > 0
    no_better = mw.summarize(fills(400, conservative=-0.9, optimistic=0.3, base=-0.8), games, "nfl", "test")
    assert no_better["evidence"] is None and "maker-quote@1" in no_better["note"]
    dropped = mw.summarize(fills(400, conservative=-0.9, optimistic=-0.1, base=-0.8), games, "nfl", "test")
    assert dropped["evidence"]["status"] == "dropped"
    few = mw.summarize(fills(100, conservative=-0.2, optimistic=0.3, base=-0.8), games, "nfl", "test")
    assert few["evidence"] is None and "300" in few["note"]


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"{len(tests)} passed")
