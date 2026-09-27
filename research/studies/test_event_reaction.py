"""Synthetic tests for event_reaction.py and lifecycle.py (no data files, no network). Run:
  python research/studies/test_event_reaction.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import event_reaction as er  # noqa: E402
import lifecycle  # noqa: E402
from common import round_trip_return, settle_return  # noqa: E402

DAY = 86_400.0


def books(path: list[tuple[float, float]], name: str = "g1", yes_win: float = 1.0, start: float = 0.0, end: float = 1800.0) -> pd.DataFrame:
    """A book every 5 s from `start`; YES midpoint follows `path` [(seconds, mid), ...] stepwise; spread 1c."""
    times = np.arange(0.0, end + 1, 5.0)
    marks = sorted(path)
    mids = np.array([next(m for s, m in reversed(marks) if s <= x) for x in times])
    return pd.DataFrame({"game": name, "t": start + times, "yes_ask": mids + 0.005, "yes_bid": mids - 0.005, "fee": 0.0695, "yes_win": yes_win})


def scores(rows: list[tuple[float, str, int]], name: str = "g1", start: float = 0.0) -> pd.DataFrame:
    return pd.DataFrame([{"game": name, "t": start + t, "side": side, "points": points} for t, side, points in rows], columns=er.SCORES)


# YES 70c; NO (a 30c underdog) scores at 600 s and YES falls to 58c (a 12c move).
SURPRISE = [(0, 0.70), (600, 0.58)]


def only(trades: pd.DataFrame, variant: str) -> pd.DataFrame:
    return trades[trades.variant == variant].reset_index(drop=True)


def test_surprise_entry_waits_then_buys_the_team_scored_on() -> None:
    trades, _ = er.study(books(SURPRISE), scores([(600, "no", 6)]))
    fade = only(trades, "surprise-fade")
    assert len(fade) == 1, trades
    row = fade.iloc[0]
    assert row.t == 645 and row.side == "yes" and math.isclose(row.entry, 0.585) and math.isclose(row.scorer_pre, 0.30), row
    assert math.isclose(row.ret, float(settle_return(0.585, 1.0)), rel_tol=1e-12)
    follow = only(trades, "follow").iloc[0]
    assert follow.side == "no" and math.isclose(follow.entry, 1 - 0.575) and follow.ret < 0, follow
    assert only(trades, "expected-fade").empty


def test_no_entry_without_surprise_move_or_window() -> None:
    # The scorer was a 40c side: neither surprising (<= 35c) nor expected (>= 50c).
    trades, _ = er.study(books([(0, 0.60), (600, 0.48)]), scores([(600, "no", 6)]))
    assert only(trades, "surprise-fade").empty and only(trades, "expected-fade").empty
    # A 6c move is not an overreaction candidate.
    trades, _ = er.study(books([(0, 0.70), (600, 0.64)]), scores([(600, "no", 6)]))
    assert only(trades, "surprise-fade").empty
    # The move only arrives after the 180 s window.
    trades, _ = er.study(books([(0, 0.70), (800, 0.58)]), scores([(600, "no", 6)]))
    assert only(trades, "surprise-fade").empty
    # Another scoring play (by YES) before the move qualifies ends the window.
    trades, _ = er.study(books([(0, 0.70), (600, 0.66), (660, 0.58)]), scores([(600, "no", 6), (640, "yes", 3)]))
    assert only(trades, "surprise-fade").empty
    # No book 30 s before the score (joined late): no pre-event price, no trade.
    trades, _ = er.study(books(SURPRISE), scores([(20, "no", 6)]))
    assert only(trades, "surprise-fade").empty


def test_expected_scores_are_the_control() -> None:
    # YES was 30c: NO (70c) scoring is expected. The same timing and move rule, recorded as expected-fade.
    trades, paths = er.study(books([(0, 0.30), (600, 0.18)]), scores([(600, "no", 7)]))
    assert len(only(trades, "expected-fade")) == 1 and only(trades, "surprise-fade").empty and only(trades, "follow").empty
    assert set(paths.kind) == {"expected"} and math.isclose(paths["+45s"].iloc[0], 0.12, abs_tol=1e-9)


def test_touchdown_and_try_are_one_scoring_play() -> None:
    plays = er.scoring_plays(scores([(600, "no", 6), (660, "no", 1), (900, "no", 3), (950, "yes", 7)]))
    assert list(plays.t) == [600, 900, 950] and list(plays.points) == [7, 3, 7], plays
    # The try 60 s later does not restart the window or add a second entry.
    trades, _ = er.study(books([(0, 0.70), (600, 0.66), (700, 0.58)]), scores([(600, "no", 6), (660, "no", 1)]))
    fade = only(trades, "surprise-fade")
    assert len(fade) == 1 and fade.t.iloc[0] == 700, fade


def test_alternative_exits() -> None:
    # After the entry at 58c (645 s) the midpoint recovers to 64c (half of the 12c fall) at 1000 s.
    trades, _ = er.study(books([(0, 0.70), (600, 0.58), (1000, 0.64)]), scores([(600, "no", 6)]))
    row = only(trades, "surprise-fade").iloc[0]
    assert math.isclose(row.retrace_half, float(round_trip_return(0.585, 0.635)), rel_tol=1e-12), row
    assert math.isclose(row.time_5m, float(round_trip_return(0.585, 0.575)), rel_tol=1e-12), row
    assert math.isclose(row.time_15m, float(round_trip_return(0.585, 0.635)), rel_tol=1e-12), row


def test_snaps_become_score_events() -> None:
    snaps = pd.DataFrame({"game": "g", "snap": [100.0, 140.0, 180.0, 200.0, 260.0], "yes_pre": [0, 0, 6, 7, 7], "no_pre": [0, 0, 0, 0, 3]})
    events = er.scores_from_snaps(snaps)
    assert list(events.t) == [150.0, 190.0, 210.0] and list(events.side) == ["yes", "yes", "no"] and list(events.points) == [6, 1, 3], events


def test_lifecycle_verdicts() -> None:
    starts = pd.Series({"a": 3.0, "b": 1.0, "c": 2.0, "d": 4.0})
    assert lifecycle.split_games(starts) == ({"b", "c"}, {"a", "d"})
    ci = lambda n, m: {"n": n, "mean": m, "lo": m - 0.1, "hi": m + 0.1}  # noqa: E731
    assert lifecycle.verdict(ci(100, 0.05), {"discovery": ci(50, 0.04), "holdout": ci(50, 0.06)}, 80)[0] == "lead"
    assert lifecycle.verdict(ci(100, 0.05), {"discovery": ci(50, 0.12), "holdout": ci(50, -0.01)}, 80)[0] == "dropped"
    assert lifecycle.verdict(ci(100, -0.05), {"discovery": ci(50, -0.04), "holdout": ci(50, -0.06)}, 80)[0] == "dropped"
    status, reason = lifecycle.verdict(ci(100, 0.05), {"discovery": ci(90, 0.04), "holdout": ci(10, 0.06)}, 80)
    assert status is None and "holdout" in reason
    assert lifecycle.verdict(ci(40, 0.05), {"discovery": ci(20, 0.04), "holdout": ci(20, 0.06)}, 80)[0] is None


def test_evidence_row_names_the_version() -> None:
    frames = [books(SURPRISE, name=f"g{i}", start=DAY * i) for i in range(90)]
    events = pd.concat([scores([(600, "no", 6)], name=f"g{i}", start=DAY * i) for i in range(90)])
    trades, paths = er.study(pd.concat(frames), events)
    summary = er.summarize(trades, paths, "cfb", "test")
    row = summary["evidence"]
    assert row["status"] == "lead" and row["strategies"] == ["surprise-fade@1"] and row["styles"] == ["taker-hold"], row
    assert row["sports"] == ["CFB"] and summary["variants"]["surprise-fade"]["n"] == 90
    assert set(summary["exits"]) == {"settlement", "retrace_half", "time_5m", "time_15m"}
    losing = er.summarize(*er.study(pd.concat([books(SURPRISE, name=f"g{i}", start=DAY * i, yes_win=0.0) for i in range(90)]), events), "cfb", "test")
    assert losing["evidence"]["status"] == "dropped"
    few = er.summarize(*er.study(pd.concat(frames[:30]), events), "cfb", "test")
    assert few["evidence"] is None and "80" in few["note"]


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"{len(tests)} passed")
