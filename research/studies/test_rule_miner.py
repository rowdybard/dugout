"""Synthetic tests for rule_miner.py (no data files, no network). Run:
  python research/studies/test_rule_miner.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rule_miner as rm  # noqa: E402
from common import settle_return  # noqa: E402

DAY = 86_400.0


def game(i: int, fav_yes: bool, yes_ordering: str, yes_won: float, fav_ask: float = 0.75, live_minutes: int = 30) -> rm.Game:
    """Quotes every 5 minutes from 6 h before the start to `live_minutes` after it; the favourite's ask is constant."""
    start = 1_700_000_000 + DAY * i
    ts = np.arange(start - 6 * 3600, start + live_minutes * 60 + 1, 300.0)
    dog_ask = round(1 - fav_ask + 0.01, 2)
    yes_ask, no_ask = (fav_ask, dog_ask) if fav_yes else (dog_ask, fav_ask)
    return rm.Game(slug=f"aec-cfb-g{i:04d}", start=start, yes_won=yes_won, fee=0.0695, yes_ordering=yes_ordering,
                   quotes=pd.DataFrame({"ts": ts, "yes_ask": yes_ask, "no_ask": no_ask}))


def slate(n: int, home_edge: bool, seed: int = 3) -> list[rm.Game]:
    """Favourites at 75c. With `home_edge`, home favourites win 97% (a planted mispricing); otherwise every favourite
    wins at its price (no edge)."""
    rng = np.random.default_rng(seed)
    games = []
    for i in range(n):
        fav_yes, yes_ordering = bool(rng.random() < 0.5), "away" if rng.random() < 0.5 else "home"
        fav_home = (yes_ordering == "home") == fav_yes
        p = 0.97 if home_edge and fav_home else 0.74
        fav_won = float(rng.random() < p)
        games.append(game(i, fav_yes, yes_ordering, fav_won if fav_yes else 1 - fav_won))
    return games


def test_rows_use_the_bots_feature_definitions() -> None:
    rows = rm.build_rows([game(0, fav_yes=True, yes_ordering="away", yes_won=1.0)])
    pre = rows[(rows.phase == "pregame") & (rows.side == "yes")]
    live = rows[(rows.phase == "live") & (rows.side == "no")]
    # Live moments run to 34 min: quotes end at 30 min and stay usable for 5 minutes.
    assert len(pre) == 36 and len(rows[rows.phase == "live"]) == 2 * 18, (len(pre), len(rows))
    first = pre.iloc[0]
    assert first.price == 0.75 and math.isclose(first.spread, 0.01) and first.minutesToStart == 360 and first.venue == "away"
    assert math.isclose(first.ret, float(settle_return(0.75, 1.0)))
    one = live.iloc[1]
    # NO (home) is the 26c side; at the close its midpoint was 25.5c; no move since.
    assert one.venue == "home" and one.price == 0.26 and math.isclose(one.pregamePrice, 0.255) and abs(one.moveSincePregame) < 1e-9
    assert one.minutesToStart == -2 and one.ret == float(settle_return(0.26, 0.0))
    # Stale quotes (over 5 minutes old) and wide spreads give no rows.
    sparse = game(1, True, "away", 1.0)
    sparse.quotes = sparse.quotes.iloc[::3]
    assert len(rm.build_rows([sparse])) < len(rm.build_rows([game(1, True, "away", 1.0)]))
    wide = game(2, True, "away", 1.0, fav_ask=0.75)
    wide.quotes = wide.quotes.assign(no_ask=0.35)
    assert rm.build_rows([wide]).empty


def test_bands_match_the_engine_conditions() -> None:
    values = np.array([-30.0, -29.999, 0.0, 0.001, np.nan])
    assert list(rm.band_mask(values, -30, 0)) == [False, True, True, False, False], "lo < x <= hi"
    assert rm.conditions_json([("minutesToStart", "0-30 min in", -30, 0), ("venue", "home", None, None), ("pregamePrice", "pregame >80c", 0.8, None)]) == [
        {"feature": "minutesToStart", "op": "gt", "value": -30}, {"feature": "minutesToStart", "op": "lte", "value": 0},
        {"feature": "venue", "op": "eq", "value": "home"}, {"feature": "pregamePrice", "op": "gt", "value": 0.8}]
    assert len(rm.price_ranges()) == 1 + 10 + 9 + 8
    live = rm.conditions_of("live")
    assert [] in live and len(live) == 1 + 19 + 141


def test_one_entry_per_game_first_moment_yes_first() -> None:
    rows = rm.build_rows([game(0, True, "away", 1.0), game(1, False, "home", 0.0)])
    trades = rm.first_per_game(rows, np.ones(len(rows), bool))
    assert len(trades) == 2 and list(trades.side) == ["yes", "yes"] and list(trades.minutesToStart) == [360, 360]


def test_a_planted_edge_survives_and_luck_does_not() -> None:
    result = rm.mine(rm.build_rows(slate(420, home_edge=True)), null_runs=2)
    assert result["survivors"], result["watch"]
    text = " | ".join(s["rule"] for s in result["survivors"])
    assert "home" in text and "70-80c" in text, text
    row = result["evidence"][0]
    assert row["status"] == "lead" and row["strategies"] == ["mined-rule@1"] and row["sports"] == ["CFB"] and row["styles"] == ["taker-hold"]
    assert row["id"].startswith("cfb-mined-") and row["estimate"]["mean"] > 0
    assert {"feature": "venue", "op": "eq", "value": "home"} in row.get("conditions", []), row
    assert all(n["survivors"] == 0 for n in result["null"]["perRun"]), result["null"]
    fair = rm.mine(rm.build_rows(slate(420, home_edge=False, seed=5)), null_runs=0)
    assert fair["survivors"] == [] and fair["evidence"] == [], [s["rule"] for s in fair["survivors"]]


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for fn in tests:
        fn()
        print(f"ok {fn.__name__}")
    print(f"{len(tests)} passed")
