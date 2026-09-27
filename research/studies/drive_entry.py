"""Comeback drive: does buying the trailing team once it has the ball in scoring position, and selling when the drive
ends, make money after fees and spread? This is the owner's idea, and the bot paper-trades it as `comeback-drive`
(lib/decision/sports/football.ts).

Usage (on the PC, research venv active):
  python research/studies/drive_entry.py nfl                       # NFL history: aligned prices + nflverse play-by-play
  python research/studies/drive_entry.py live --league cfb [--dest D:/lake] [--clock countdown|elapsed]
                                                                   # books the runner recorded with the feed's drive state
Writes research/studies/results/drive-entry-<source>.json, including the evidence row to add to a pack
(scripts/evidence-pack.ts add <pack.json> <results.json>).

Pre-registered before any result. The thresholds match COMEBACK_DRIVE in lib/decision/sports/football.ts; keep them equal.
  entry : the team with the ball trails by 3-24, is inside the opponent's 30, on 1st-3rd down, with 5+ minutes of
          game time left. Buy that side at the ask on the first executable book (spread <= 2c) at least LAG seconds
          after the setup is first seen, while the setup still holds. One entry per drive.
  exit  : sell at the bid on the first executable book (spread <= 5c) once the drive ends (possession, score or half
          changes), at a 35% net loss, or 12 minutes after entry. Held to settlement if no executable book follows.
  costs : taker fees on both fills (lib/trading/money.ts); the spread is paid.
Controls, on the same games with the same exits:
  random   : random tradable moments and sides, about one per 5 minutes of live data.
  opposite : the other side (the leader, without the ball) at the drive entries' moments.
  hold     : the drive entries held to settlement instead of sold (is holding longer better?).
Kill rule: status "lead" only if the drive entries' mean return is positive, otherwise "dropped". A study alone never
makes a row "proven"; that takes the forward paper test. Do not change the rule after seeing results. A changed
rule is a new strategy version with its own run.
History caveat: the NFL table knows the game state as of the last snap (pre-snap), so a play's result shows up at the
next snap. Setups and drive ends are seen later than the live feed shows them.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RESULTS, fmt, mean_ci, round_trip_return, settle_return  # noqa: E402


@dataclass(frozen=True)
class Rule:
    min_deficit: int = 3
    max_deficit: int = 24
    max_yards: int = 30
    max_down: int = 3
    min_seconds: int = 300
    stop: float = 0.35
    max_hold_s: int = 12 * 60


RULE = Rule()
LAG = 15  # seconds between first seeing the setup and the entry fill (history is 15-60 s apart)
ENTRY_SPREAD = 0.02
EXIT_SPREAD = 0.05
QUARTER = 900
RANDOM_EVERY_S = 300
EPS = 1e-9

# Standard frame, one row per book or price observation, sorted by game then t:
#   game, t (s), yes_ask, yes_bid, fee, poss ('yes' | 'no' | ''), yes_score, no_score, quarter (1-4, 5+ = OT),
#   down, yards (to the end zone for the team with the ball), secs_left (NaN if unknown), yes_win (1/0/0.5/NaN)
COLUMNS = ["game", "t", "yes_ask", "yes_bid", "fee", "poss", "yes_score", "no_score", "quarter", "down", "yards", "secs_left", "yes_win"]


def setup_mask(g: pd.DataFrame, rule: Rule = RULE) -> np.ndarray:
    poss = g.poss.to_numpy()
    deficit = np.where(poss == "yes", g.no_score - g.yes_score, np.where(poss == "no", g.yes_score - g.no_score, np.nan))
    q = g.quarter.to_numpy(float)
    # Before the fourth quarter at least (4 - q) full quarters remain, whatever the clock shows (as the bot does).
    whole = np.where((q >= 1) & (q <= 4), (4 - q) * QUARTER, -1)
    enough = (q >= 1) & (q <= 4) & ((whole >= rule.min_seconds) | (g.secs_left.to_numpy(float) >= rule.min_seconds))
    down = g.down.to_numpy(float)
    return (np.isin(poss, ["yes", "no"]) & (deficit >= rule.min_deficit) & (deficit <= rule.max_deficit)
            & (g.yards.to_numpy(float) <= rule.max_yards) & (down >= 1) & (down <= rule.max_down) & enough)


def drive_keys(g: pd.DataFrame) -> np.ndarray:
    """Drive number per row. A drive lasts while the team with the ball, the score and the half are unchanged; the
    same team with the ball at the same score after the other team had it is a new drive. Rows with no team on the
    ball (timeouts, quarter breaks, unknown reports) keep the last one, as the bot keeps its last verified report."""
    poss = g.poss.replace("", np.nan).ffill().fillna("")
    half = np.where(g.quarter <= 2, 1, np.where(g.quarter <= 4, 2, 3))
    keys = list(zip(poss, g.yes_score, g.no_score, half))
    return np.cumsum([0] + [int(keys[i] != keys[i - 1]) for i in range(1, len(keys))]) if keys else np.zeros(0, int)


def side_book(g: pd.DataFrame, side: str) -> tuple[np.ndarray, np.ndarray]:
    ask, bid = g.yes_ask.to_numpy(float), g.yes_bid.to_numpy(float)
    return (ask, bid) if side == "yes" else (1 - bid, 1 - ask)


def exit_trade(g: pd.DataFrame, keys: np.ndarray, e: int, side: str, rule: Rule = RULE) -> dict:
    """Sell `side` bought at row e: at the drive end, the stop or the time limit; else settle."""
    t, spread, fee = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float), g.fee.to_numpy(float)
    ask, bid = side_book(g, side)
    won = g.yes_win.iloc[e] if side == "yes" else 1 - g.yes_win.iloc[e]
    ended = False
    for j in range(e + 1, len(g)):
        ended = ended or keys[j] != keys[e]
        if spread[j] > EXIT_SPREAD + EPS or not 0 < bid[j] < 1:
            continue
        r = float(round_trip_return(ask[e], bid[j], fee[e]))
        reason = "drive_end" if ended else "stop" if r <= -rule.stop + EPS else "time" if t[j] - t[e] >= rule.max_hold_s else None
        if reason:
            return {"exit": reason, "ret": r, "held_s": t[j] - t[e]}
    return {"exit": "settled", "ret": float(settle_return(ask[e], won, fee[e])) if np.isfinite(won) else np.nan, "held_s": t[-1] - t[e] if len(t) else 0.0}


def entries(g: pd.DataFrame, rule: Rule = RULE, lag: float = LAG) -> list[tuple[int, str]]:
    """(row, side) of each comeback-drive entry, one per drive."""
    setup, keys = setup_mask(g, rule), drive_keys(g)
    t, spread = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float)
    out, traded, i, n = [], set(), 0, len(g)
    while i < n:
        if not setup[i] or keys[i] in traded:
            i += 1
            continue
        key, side, seen, j = keys[i], g.poss.iloc[i], t[i], i
        ask, _ = side_book(g, side)
        while j < n and keys[j] == key:
            if t[j] >= seen + lag and setup[j] and spread[j] <= ENTRY_SPREAD + EPS and 0.02 < ask[j] < 0.98:
                out.append((j, side))
                traded.add(key)
                break
            j += 1
        i = j + 1 if j < n and keys[j] == key else j  # after an entry, or where the drive ended
    return out


def random_entries(g: pd.DataFrame, rng: np.random.Generator) -> list[tuple[int, str]]:
    t, spread = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float)
    tradable = np.flatnonzero((spread <= ENTRY_SPREAD + EPS) & (g.yes_ask > 0.02) & (g.yes_ask < 0.98) & (g.yes_bid > 0.02) & (g.yes_bid < 0.98))
    if tradable.size == 0:
        return []
    count = max(1, int(round((t[-1] - t[0]) / RANDOM_EVERY_S)))
    rows = np.sort(rng.choice(tradable, size=min(count, tradable.size), replace=False))
    return [(int(r), "yes" if rng.random() < 0.5 else "no") for r in rows]


def study(frame: pd.DataFrame, rule: Rule = RULE, seed: int = 7) -> pd.DataFrame:
    """Every trade of every variant: game, variant, side, t, entry price, exit, return, hold-to-settlement return."""
    rng, rows = np.random.default_rng(seed), []
    for game, g in frame.groupby("game", sort=True):
        g = g.sort_values("t").reset_index(drop=True)
        keys = drive_keys(g)
        drives = entries(g, rule)
        plans = [("drive", e, s) for e, s in drives] + [("opposite", e, "no" if s == "yes" else "yes") for e, s in drives] \
            + [("random", e, s) for e, s in random_entries(g, rng)]
        for variant, e, side in plans:
            ask, bid = side_book(g, side)
            if variant == "opposite" and ((g.yes_ask - g.yes_bid).iloc[e] > ENTRY_SPREAD + EPS or not 0.02 < ask[e] < 0.98):
                continue
            won = g.yes_win.iloc[e] if side == "yes" else 1 - g.yes_win.iloc[e]
            result = exit_trade(g, keys, e, side, rule)
            rows.append({"game": game, "variant": variant, "side": side, "t": float(g.t.iloc[e]), "entry": float(ask[e]), **result,
                         "hold_ret": float(settle_return(ask[e], won, g.fee.iloc[e])) if np.isfinite(won) else np.nan})
    return pd.DataFrame(rows, columns=["game", "variant", "side", "t", "entry", "exit", "ret", "held_s", "hold_ret"])


def summarize(trades: pd.DataFrame, league: str, source: str) -> dict:
    def ci(df: pd.DataFrame, column: str = "ret") -> dict:
        ok = df[np.isfinite(df[column])]
        return mean_ci(ok[column], ok.game.to_numpy())

    starts = trades.groupby("game").t.min().sort_values()
    cut = starts.iloc[len(starts) // 2] if len(starts) else 0
    early = set(starts[starts < cut].index)
    drive = trades[trades.variant == "drive"]
    out = {"league": league, "source": source, "rule": asdict(RULE), "lag_s": LAG, "games": int(trades.game.nunique()),
           "variants": {}, "split": {}, "exits": drive.exit.value_counts().to_dict(),
           "medianHeldMinutes": float(drive.held_s.median() / 60) if len(drive) else None}
    for variant in ["drive", "opposite", "random"]:
        subset = trades[trades.variant == variant]
        out["variants"][variant] = ci(subset)
        out["split"][variant] = {"discovery": ci(subset[subset.game.isin(early)]), "holdout": ci(subset[~subset.game.isin(early)])}
    out["variants"]["hold"] = ci(drive, "hold_ret")
    result = out["variants"]["drive"]
    out["evidence"] = evidence_row(result, league, source, out["games"], trades) if result["n"] >= 30 else None
    out["note"] = None if out["evidence"] else f"Only {result['n']} drive trades; at least 30 are needed before writing an evidence row."
    return out


def evidence_row(result: dict, league: str, source: str, games: int, trades: pd.DataFrame) -> dict:
    sport = league.upper()
    first, last = (pd.to_datetime(trades.t.min(), unit="s").date(), pd.to_datetime(trades.t.max(), unit="s").date())
    positive = result["mean"] > 0
    return {"id": f"{league.lower()}-live-comeback-drive", "title": f"{sport} comeback drives", "status": "lead" if positive else "dropped",
            "sports": [sport], "phases": ["live"], "styles": ["taker-scalp"], "strategies": ["comeback-drive"],
            "estimate": {"mean": round(result["mean"], 4), "lo": round(result["lo"], 4), "hi": round(result["hi"], 4), "unit": "return"},
            "sample": f"{result['n']} trades over {games} {sport} games, {first} to {last}",
            "source": f"research/studies/results/drive-entry-{source}.json",
            "plain": ("Buying the trailing team in scoring position and selling at the drive's end "
                      + (f"made {result['mean'] * 100:+.1f}% per trade after fees and spread. Unproven until the forward paper test agrees."
                         if positive else f"lost {result['mean'] * 100:.1f}% per trade after fees and spread."))}


# ---- Sources --------------------------------------------------------------------------------------------------

def nfl_history() -> pd.DataFrame:
    """research/data/aligned/nfl.parquet (align_nfl.py). NFL markets put the away team on YES (verified Sep 27, 2026)."""
    from common import load
    df = load("nfl")
    df = df[df.phase == "live"].copy()
    poss = np.where(df.posteam == df.away_team, "yes", np.where(df.posteam == df.home_team, "no", ""))
    return pd.DataFrame({"game": df.game_id, "t": df.ts.astype(float), "yes_ask": 1 - df.home_bid, "yes_bid": 1 - df.home_ask,
                         "fee": df.fee_coefficient.fillna(0.0695), "poss": poss, "yes_score": df.away_score_pre, "no_score": df.home_score_pre,
                         "quarter": df.qtr, "down": df.down, "yards": df.poss_yardline_100, "secs_left": df.game_seconds_remaining,
                         "yes_win": 1 - df.home_win})


def clock_seconds(period: str | None, clock: str | None, direction: str | None) -> float:
    """Game seconds left in regulation; NaN when the quarter or clock direction is unknown (as engine-plan.ts)."""
    q, c = re.fullmatch(r"Q([1-4])", period or ""), re.fullmatch(r"(\d{1,2}):([0-5]\d)", clock or "")
    if not q or not c or direction not in ("countdown", "elapsed"):
        return np.nan
    shown = int(c.group(1)) * 60 + int(c.group(2))
    if shown > QUARTER:
        return np.nan
    return (4 - int(q.group(1))) * QUARTER + (shown if direction == "countdown" else QUARTER - shown)


def quarter_of(period: str | None) -> float:
    if not period:
        return np.nan
    if re.fullmatch(r"Q[1-4]", period):
        return float(period[1])
    return 5.0 if re.fullmatch(r"OT\d*|\d+OT", period) else np.nan


def standardize_books(records: pd.DataFrame, settle: dict[str, float], clock: str | None) -> pd.DataFrame:
    """Rows as lib/datastore/recorder.ts writes them. Only rows that carry the team mapping are usable."""
    rows = []
    for r in records.itertuples(index=False):
        football = r.football if isinstance(r.football, dict) else None
        bids, asks = list(r.bids) if r.bids is not None else [], list(r.asks) if r.asks is not None else []
        if not football or not football.get("yesTeamId") or not bids or not asks or not r.live or r.ended:
            continue
        m = re.fullmatch(r"\s*(\d+)\s*-\s*(\d+)\s*", r.score or "")
        ordering = getattr(r, "yesOrdering", None)
        if not m or ordering not in ("away", "home"):
            continue
        away, home = int(m.group(1)), int(m.group(2))
        yes_score, no_score = (away, home) if ordering == "away" else (home, away)
        holder = football.get("possession")
        poss = "yes" if holder == football["yesTeamId"] else "no" if holder == football.get("noTeamId") else ""
        yard, field = football.get("yard"), football.get("fieldTeam")
        yards = np.nan if yard is None or not poss else (100 - yard if field == holder else yard)
        down = football.get("down")
        rows.append({"game": r.slug, "t": r.t / 1000, "yes_ask": float(asks[0][0]), "yes_bid": float(bids[0][0]), "fee": 0.0695,
                     "poss": poss, "yes_score": yes_score, "no_score": no_score, "quarter": quarter_of(r.period),
                     "down": np.nan if down is None else float(down), "yards": yards, "secs_left": clock_seconds(r.period, r.clock, clock),
                     "yes_win": settle.get(r.slug, np.nan)})
    return pd.DataFrame(rows, columns=COLUMNS)


def live_books(league: str, dest: str | None, clock: str | None) -> pd.DataFrame:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "datastore"))
    import lake
    lake.load_env()
    con = lake.connect_for_query(argparse.Namespace(local=False, dest=dest))
    if not con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'live_books'").fetchone()[0]:
        sys.exit("No live_books in the lake yet: the runner records them once it has the LAKE binding (services/runner/README.md).")
    records = con.execute("SELECT * FROM live_books WHERE league = ? ORDER BY slug, t", [league.lower()]).df()
    settle = {}
    if con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'pmus_catalog'").fetchone()[0]:
        settle = dict(con.execute("SELECT market_slug, long_settle FROM pmus_catalog WHERE long_settle IS NOT NULL").fetchall())
    return standardize_books(records, {k: float(v) for k, v in settle.items()}, clock)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", choices=["nfl", "live"])
    parser.add_argument("--league", choices=["nfl", "cfb"], default="nfl", help="live source only")
    parser.add_argument("--dest", help="lake folder instead of R2 (live source)")
    parser.add_argument("--clock", choices=["countdown", "elapsed"], help="how the feed's football clock runs, once verified (live source)")
    args = parser.parse_args()
    league = "nfl" if args.source == "nfl" else args.league
    frame = nfl_history() if args.source == "nfl" else live_books(league, args.dest, args.clock)
    trades = study(frame)
    name = "nfl" if args.source == "nfl" else f"live-{league}"
    summary = summarize(trades, league, name)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"drive-entry-{name}.json"
    path.write_text(json.dumps(summary, indent=1, default=float) + "\n", encoding="utf-8")
    for variant, ci in summary["variants"].items():
        print(f"{variant:9s} {fmt(ci)}")
    for variant, split in summary["split"].items():
        print(f"{variant:9s} discovery {fmt(split['discovery'])} | holdout {fmt(split['holdout'])}")
    print(f"exits: {summary['exits']}; median hold {summary['medianHeldMinutes']} min")
    print(f"evidence: {summary['evidence']['status'] if summary['evidence'] else summary['note']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
