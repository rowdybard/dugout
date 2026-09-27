"""Synthetic tests for drive_entry.py (no data files, no network). Run:
  python research/studies/test_drive_entry.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drive_entry as d  # noqa: E402
from common import round_trip_return, settle_return  # noqa: E402


def game(rows: list[dict], name: str = "g1", yes_win: float = 0.0, start: float = 1_000_000.0) -> pd.DataFrame:
    """Rows 15 s apart from `start`; each dict overrides the defaults (YES trails 0-17 with the ball at the 25, Q2, 1st down)."""
    base = {"yes_ask": 0.21, "yes_bid": 0.20, "fee": 0.0695, "poss": "yes", "yes_score": 0, "no_score": 17, "quarter": 2,
            "down": 1.0, "yards": 25.0, "secs_left": np.nan, "yes_win": yes_win}
    return pd.DataFrame([{**base, **row, "game": name, "t": start + 15 * i} for i, row in enumerate(rows)], columns=d.COLUMNS)


DAY = 86_400.0


def only(trades: pd.DataFrame, variant: str = "drive") -> pd.DataFrame:
    return trades[trades.variant == variant].reset_index(drop=True)


def test_touchdown_exit_after_lag_and_timeout() -> None:
    g = game([{}, {"down": 2, "yards": 20}, {"poss": "", "down": np.nan}, {"down": 3, "yards": 12},
              {"yes_score": 6, "down": np.nan, "yes_ask": 0.31, "yes_bid": 0.30}, {"yes_score": 7, "poss": "no", "down": 1, "yards": 75}])
    trades = only(d.study(g))
    assert len(trades) == 1, trades
    row = trades.iloc[0]
    # Seen at t0; entry needs 15 s, so row 1 (2nd down at the 20). The timeout row does not end the drive.
    assert row.t == 1_000_015 and row.side == "yes" and row.entry == 0.21, row
    assert row.exit == "drive_end" and math.isclose(row.ret, float(round_trip_return(0.21, 0.30)), rel_tol=1e-12), row
    assert math.isclose(row.hold_ret, float(settle_return(0.21, 0.0)), rel_tol=1e-12)


def test_no_setup_cases() -> None:
    for override in [{"poss": "no"}, {"yards": 31}, {"down": 4}, {"no_score": 2}, {"no_score": 25}, {"quarter": 4}, {"quarter": 5},
                     {"yes_ask": 0.24, "yes_bid": 0.21}]:
        trades = only(d.study(game([override] * 6)))
        assert trades.empty, (override, trades)
    # Fourth quarter with a known clock and enough time is a setup.
    assert len(only(d.study(game([{"quarter": 4, "secs_left": 400}] * 6)))) == 1
    assert only(d.study(game([{"quarter": 4, "secs_left": 200}] * 6))).empty


def test_stop_time_and_one_entry_per_drive() -> None:
    stop = only(d.study(game([{}, {}, {"yes_ask": 0.13, "yes_bid": 0.12}, {}])))
    assert list(stop.exit) == ["stop"], stop
    long_drive = game([{}] * 60)  # 15 minutes of the same drive
    trades = only(d.study(long_drive))
    assert list(trades.exit) == ["time"] and trades.held_s.iloc[0] >= 12 * 60, trades
    # The opponent gets the ball, then the same team drives again at the same score: a new drive may be traded.
    again = game([{}, {}, {"down": 2}, {"poss": "no", "down": 1, "yards": 70}, {"poss": "no", "down": 2}, {}, {}, {"down": 2}, {"poss": "no"}])
    trades = only(d.study(again))
    assert len(trades) == 2 and list(trades.exit) == ["drive_end", "drive_end"], trades


def test_settles_when_no_executable_book_follows() -> None:
    g = game([{}, {}, {"poss": "no", "yes_ask": 0.9, "yes_bid": 0.1}], yes_win=1.0)
    trades = only(d.study(g))
    assert list(trades.exit) == ["settled"] and math.isclose(trades.ret.iloc[0], float(settle_return(0.21, 1.0)), rel_tol=1e-12), trades


def test_controls_and_the_evidence_row() -> None:
    winners = pd.concat([game([{}, {}, {"down": 2}, {"yes_score": 6, "yes_ask": 0.31, "yes_bid": 0.30}], name=f"w{i}", start=DAY * i) for i in range(40)])
    trades = d.study(winners)
    assert len(only(trades)) == 40 and len(only(trades, "opposite")) == 40 and len(only(trades, "random")) > 0
    opposite = only(trades, "opposite").iloc[0]
    assert opposite.side == "no" and math.isclose(opposite.entry, 0.80) and opposite.ret < 0, opposite
    summary = d.summarize(trades, "nfl", "test")
    row = summary["evidence"]
    assert row["status"] == "lead" and row["strategies"] == ["comeback-drive@1"] and row["styles"] == ["taker-scalp"], row
    assert row["estimate"]["mean"] > 0 and summary["variants"]["drive"]["n"] == 40
    assert set(summary["split"]["drive"]) == {"discovery", "holdout"}
    losers = pd.concat([game([{}, {}, {"down": 2}, {"poss": "no", "yes_ask": 0.13, "yes_bid": 0.12}], name=f"l{i}", start=DAY * i) for i in range(40)])
    assert d.summarize(d.study(losers), "nfl", "test")["evidence"]["status"] == "dropped"
    few = d.summarize(d.study(game([{}, {}, {"down": 2}, {"poss": "no"}])), "nfl", "test")
    assert few["evidence"] is None and "30" in few["note"]
    # Positive in the earlier games only: the holdout kills it.
    early = [game([{}, {}, {"down": 2}, {"yes_score": 6, "yes_ask": 0.31, "yes_bid": 0.30}], name=f"e{i}", start=DAY * i) for i in range(20)]
    late = [game([{}, {}, {"down": 2}, {"poss": "no", "yes_ask": 0.13, "yes_bid": 0.12}], name=f"x{i}", start=DAY * (20 + i)) for i in range(20)]
    split = d.summarize(d.study(pd.concat(early + late)), "nfl", "test")
    assert split["split"]["drive"]["discovery"]["mean"] > 0 and split["split"]["drive"]["holdout"]["mean"] < 0
    assert split["evidence"]["status"] == "dropped" and "holdout" in split["note"], split["note"]


def test_hold_row_only_when_holding_makes_money_and_beats_selling() -> None:
    touchdown = [{}, {}, {"down": 2}, {"yes_score": 6, "yes_ask": 0.31, "yes_bid": 0.30}]
    won = d.summarize(d.study(pd.concat([game(touchdown, name=f"w{i}", yes_win=1.0, start=DAY * i) for i in range(40)])), "nfl", "test")
    row = won["evidenceHold"]
    assert row["status"] == "lead" and row["strategies"] == ["comeback-drive-hold@1"] and row["styles"] == ["taker-hold"], row
    assert won["holdMinusSell"]["mean"] > 0
    lost = d.summarize(d.study(pd.concat([game(touchdown, name=f"l{i}", yes_win=0.0, start=DAY * i) for i in range(40)])), "nfl", "test")
    assert lost["evidenceHold"]["status"] == "dropped"
    # Holding makes money on average but less than selling at a high price: no row, the bot keeps selling.
    rich = [{}, {}, {"down": 2}, {"yes_score": 6, "yes_ask": 0.91, "yes_bid": 0.90}]
    mixed = pd.concat([game(rich, name=f"m{i}", yes_win=float(i % 2), start=DAY * i) for i in range(40)])
    middle = d.summarize(d.study(mixed), "nfl", "test")
    assert middle["variants"]["hold"]["mean"] > 0 and middle["holdMinusSell"]["mean"] < 0
    assert middle["evidenceHold"] is None and "keeps selling" in middle["holdNote"]


def test_drive_fade_buys_the_leader_once_per_drive_and_holds() -> None:
    # YES (trailing 0-17, 21c) drives inside the 30: buy NO (the leader) at 1 - 0.20 = 80c after the lag, hold.
    g = game([{}, {}, {"down": 2}, {"poss": "no", "down": 1, "yards": 70}], yes_win=0.0)
    fade = only(d.study(g), "fade")
    assert len(fade) == 1 and fade.side.iloc[0] == "no" and math.isclose(fade.entry.iloc[0], 0.80), fade
    assert fade.t.iloc[0] == 1_000_015 and fade.exit.iloc[0] == "settled"
    assert math.isclose(fade.ret.iloc[0], float(settle_return(0.80, 1.0)), rel_tol=1e-12)
    # The alternative exit sells the leader at its bid (1 - yes_ask) once the drive ends.
    assert math.isclose(fade.drive_end_ret.iloc[0], float(round_trip_return(0.80, 0.79)), rel_tol=1e-12)
    # Not a longshot (31c), the leader too expensive (96c), the team with the ball leading, 4th down, overtime: no fade.
    for override in [{"yes_ask": 0.32, "yes_bid": 0.31}, {"yes_ask": 0.05, "yes_bid": 0.04}, {"yes_score": 20}, {"down": 4}, {"quarter": 5}]:
        assert only(d.study(game([override] * 4)), "fade").empty, override


def test_leader_control_stays_outside_fade_setups() -> None:
    # The leader (NO) has the ball at midfield: not a fade setup, but YES is a longshot, so the control may buy NO.
    g = game([{"poss": "no", "yards": 50}] * 40, yes_win=0.0)
    control = only(d.study(g), "leader-any")
    assert len(control) >= 1 and set(control.side) == {"no"} and set(control.exit) == {"settled"}, control
    assert only(d.study(g), "fade").empty
    # Every row is a fade setup: the control never picks one.
    assert only(d.study(game([{}] * 40)), "leader-any").empty


def test_drive_fade_evidence_names_the_version() -> None:
    rows = [{}, {}, {"down": 2}, {"poss": "no", "down": 1, "yards": 70}]
    held = d.summarize(d.study(pd.concat([game(rows, name=f"f{i}", yes_win=0.0, start=DAY * i) for i in range(70)])), "nfl", "test")
    row = held["evidenceFade"]
    assert row["status"] == "lead" and row["strategies"] == ["drive-fade@1"] and row["styles"] == ["taker-hold"], row
    few = d.summarize(d.study(pd.concat([game(rows, name=f"f{i}", yes_win=0.0, start=DAY * i) for i in range(40)])), "nfl", "test")
    assert few["evidenceFade"] is None and "60" in few["fadeNote"]


def test_live_book_records() -> None:
    assert d.clock_seconds("Q4", "5:00", None) != d.clock_seconds("Q4", "5:00", None)  # NaN: direction unverified
    assert d.clock_seconds("Q4", "5:00", "countdown") == 300 and d.clock_seconds("Q4", "5:00", "elapsed") == 600
    assert d.quarter_of("Q3") == 3 and d.quarter_of("OT") == 5 and np.isnan(d.quarter_of("HT"))
    record = {"t": 1_000_000_000, "slug": "aec-cfb-a-b", "live": True, "ended": False, "score": "0-17", "period": "Q2", "clock": "8:00",
              "bids": [[0.2, 100.0]], "asks": [[0.21, 50.0]], "yesOrdering": "away",
              "football": {"possession": "1", "down": 2, "yardsToGo": 6, "fieldTeam": "2", "yard": 21, "yesTeamId": "1", "noTeamId": "2"}}
    old = {**record, "football": {k: v for k, v in record["football"].items() if k not in ("yesTeamId", "noTeamId")}}
    home = {**record, "yesOrdering": "home", "football": {**record["football"], "fieldTeam": "1", "yard": 40}}
    frame = d.standardize_books(pd.DataFrame([record, old, home]), {"aec-cfb-a-b": 0.0}, None)
    assert len(frame) == 2, frame  # records without the team mapping are unusable
    first, second = frame.iloc[0], frame.iloc[1]
    assert first.poss == "yes" and first.yes_score == 0 and first.no_score == 17 and first.yards == 21 and first.down == 2 and first.t == 1_000_000
    assert second.yes_score == 17 and second.no_score == 0 and second.yards == 60 and second.yes_win == 0.0


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"{len(tests)} passed")
