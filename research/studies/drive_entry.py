"""Comeback drive: does buying the trailing team once it has the ball in scoring position, and selling when the drive
ends, make money after fees and spread? And the opposite claim on the same setups: does buying the LEADER make money?
Pre-registered studies of comeback-drive@1, comeback-drive-hold@1 and drive-fade@1 (lib/decision/catalog.ts). The bot
measures them in shadow (never traded) until a row from this study names their version.

Usage (on the PC, research venv active):
  python research/studies/drive_entry.py nfl                       # NFL history: aligned prices + nflverse play-by-play
  python research/studies/drive_entry.py live --league cfb [--dest D:/lake] [--clock countdown|elapsed]  (default countdown, verified Sep 27)
                                                                   # books the runner recorded with the feed's drive state
Writes research/studies/results/drive-entry-<source>.json, including the evidence row to add to a pack
(scripts/evidence-pack.ts add <pack.json> <results.json>).

Pre-registered before any result. The thresholds match the specs' params in lib/decision/catalog.ts; keep them equal.
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
drive-fade@1 (the opposite claim, lib/decision/catalog.ts): the team with the ball trails, is inside the opponent's 30
on 1st-3rd down, in regulation, and its ask is at most 30c; buy the OTHER team (the leader) at its ask if that ask is at
most 95c and the spread at most 2c, LAG seconds after the setup is first seen. One entry per drive; held to the final.
  fade        : those entries, held to settlement (the primary exit), with selling at the drive's end as the alternative.
  leader-any  : control for the mechanism. Random tradable moments (about one per 5 minutes) when one team leads and
                the trailing team's ask is at most 30c, OUTSIDE fade setups: buy the leader and hold. If this does as
                well as `fade`, the edge (if any) is the plain favourite-longshot bias, not the salience of the drive.
Verdicts (research/studies/lifecycle.py, shared by every study): games are split at the median first observation into
discovery and holdout; "lead" only if both halves are positive after costs with the spec's minimum sample; "dropped"
if either half is not positive; no row with too few trades. A study alone never makes a row "proven"; that takes the
forward paper test. Rows name the exact version (comeback-drive@1, comeback-drive-hold@1, drive-fade@1).
Holding (comeback-drive-hold@1, which the bot checks at every drive's end): additionally, a "lead" needs holding to
beat selling at the drive's end on the same trades (paired); when holding is positive but worse, no row (the bot keeps
selling). Do not change a rule after seeing results. A changed rule is a new strategy version with its own run.
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
from lifecycle import evidence_row as version_row, halves, interval, split_games, verdict  # noqa: E402


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


@dataclass(frozen=True)
class FadeRule:
    """drive-fade@1 (lib/decision/catalog.ts). Keep equal to the spec's params."""
    max_longshot: float = 0.30
    max_leader: float = 0.95
    max_yards: int = 30
    max_down: int = 3


FADE = FadeRule()
# Minimum trades before a verdict: the specs' minSample.trades (lib/decision/catalog.ts).
MIN_TRADES = {"comeback-drive": 30, "comeback-drive-hold": 30, "drive-fade": 60}
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


def fade_mask(g: pd.DataFrame, rule: FadeRule = FADE) -> np.ndarray:
    """drive-fade@1 setup rows: a trailing team with the ball in scoring position, priced as a longshot."""
    poss = g.poss.to_numpy()
    behind = np.where(poss == "yes", g.no_score - g.yes_score, np.where(poss == "no", g.yes_score - g.no_score, np.nan))
    ask, bid = g.yes_ask.to_numpy(float), g.yes_bid.to_numpy(float)
    longshot = np.where(poss == "yes", ask, 1 - bid)
    leader_ask = np.where(poss == "yes", 1 - bid, ask)
    q, down = g.quarter.to_numpy(float), g.down.to_numpy(float)
    return (np.isin(poss, ["yes", "no"]) & (behind > 0) & (q >= 1) & (q <= 4) & (g.yards.to_numpy(float) <= rule.max_yards)
            & (down >= 1) & (down <= rule.max_down) & (longshot <= rule.max_longshot + EPS) & (leader_ask <= rule.max_leader + EPS))


def fade_entries(g: pd.DataFrame, rule: FadeRule = FADE, lag: float = LAG) -> list[tuple[int, str]]:
    """(row, leader side) of each drive-fade entry, one per drive."""
    setup, keys = fade_mask(g, rule), drive_keys(g)
    t, spread = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float)
    out, traded, seen = [], set(), {}
    for j in range(len(g)):
        if not setup[j] or keys[j] in traded:
            continue
        first = seen.setdefault(keys[j], t[j])
        if t[j] >= first + lag and spread[j] <= ENTRY_SPREAD + EPS:
            out.append((j, "no" if g.poss.iloc[j] == "yes" else "yes"))
            traded.add(keys[j])
    return out


def leader_entries(g: pd.DataFrame, rng: np.random.Generator, rule: FadeRule = FADE) -> list[tuple[int, str]]:
    """Control: random moments outside fade setups when one team leads and the other is a longshot; buy the leader."""
    t, spread = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float)
    ask, bid = g.yes_ask.to_numpy(float), g.yes_bid.to_numpy(float)
    lead = np.sign((g.yes_score - g.no_score).to_numpy(float))
    leader_ask, trailer_ask = np.where(lead > 0, ask, 1 - bid), np.where(lead > 0, 1 - bid, ask)
    q = g.quarter.to_numpy(float)
    ok = np.flatnonzero((lead != 0) & (q >= 1) & (q <= 4) & ~fade_mask(g, rule) & (spread <= ENTRY_SPREAD + EPS)
                        & (trailer_ask <= rule.max_longshot + EPS) & (leader_ask <= rule.max_leader + EPS))
    if ok.size == 0:
        return []
    count = max(1, int(round((t[-1] - t[0]) / RANDOM_EVERY_S)))
    rows = np.sort(rng.choice(ok, size=min(count, ok.size), replace=False))
    return [(int(r), "yes" if lead[r] > 0 else "no") for r in rows]


def drive_end_sale(g: pd.DataFrame, keys: np.ndarray, e: int, side: str) -> float:
    """Return from selling at the bid on the first executable book after the drive ends; NaN if none follows."""
    ask, bid = side_book(g, side)
    spread, fee = (g.yes_ask - g.yes_bid).to_numpy(float), g.fee.to_numpy(float)
    for j in range(e + 1, len(g)):
        if keys[j] != keys[e] and spread[j] <= EXIT_SPREAD + EPS and 0 < bid[j] < 1:
            return float(round_trip_return(ask[e], bid[j], fee[e]))
    return np.nan


def study(frame: pd.DataFrame, rule: Rule = RULE, seed: int = 7) -> pd.DataFrame:
    """Every trade of every variant: game, variant, side, t, entry price, exit, return, hold-to-settlement return."""
    rng, rows = np.random.default_rng(seed), []
    for game, g in frame.groupby("game", sort=True):
        g = g.sort_values("t").reset_index(drop=True)
        keys = drive_keys(g)
        drives = entries(g, rule)
        plans = [("drive", e, s) for e, s in drives] + [("opposite", e, "no" if s == "yes" else "yes") for e, s in drives] \
            + [("random", e, s) for e, s in random_entries(g, rng)]
        holds = [("fade", e, s) for e, s in fade_entries(g)] + [("leader-any", e, s) for e, s in leader_entries(g, rng)]
        for variant, e, side in plans + holds:
            ask, bid = side_book(g, side)
            if variant == "opposite" and ((g.yes_ask - g.yes_bid).iloc[e] > ENTRY_SPREAD + EPS or not 0.02 < ask[e] < 0.98):
                continue
            won = g.yes_win.iloc[e] if side == "yes" else 1 - g.yes_win.iloc[e]
            hold = float(settle_return(ask[e], won, g.fee.iloc[e])) if np.isfinite(won) else np.nan
            # Hold variants exit at settlement (their primary exit); the others use comeback-drive@1's exits.
            result = {"exit": "settled", "ret": hold, "held_s": float(g.t.iloc[-1] - g.t.iloc[e])} if variant in ("fade", "leader-any") \
                else exit_trade(g, keys, e, side, rule)
            rows.append({"game": game, "variant": variant, "side": side, "t": float(g.t.iloc[e]), "entry": float(ask[e]), **result,
                         "hold_ret": hold, "drive_end_ret": drive_end_sale(g, keys, e, side) if variant == "fade" else np.nan})
    return pd.DataFrame(rows, columns=["game", "variant", "side", "t", "entry", "exit", "ret", "held_s", "hold_ret", "drive_end_ret"])


def summarize(trades: pd.DataFrame, league: str, source: str) -> dict:
    discovery, holdout = split_games(trades.groupby("game").t.min())
    drive, fade = trades[trades.variant == "drive"], trades[trades.variant == "fade"]
    out = {"league": league, "source": source, "rule": asdict(RULE), "fadeRule": asdict(FADE), "lag_s": LAG, "games": int(trades.game.nunique()),
           "variants": {}, "split": {}, "exits": drive.exit.value_counts().to_dict(),
           "medianHeldMinutes": float(drive.held_s.median() / 60) if len(drive) else None}
    for variant in ["drive", "opposite", "random", "fade", "leader-any"]:
        subset = trades[trades.variant == variant]
        out["variants"][variant] = interval(subset)
        out["split"][variant] = halves(subset, discovery, holdout)
    out["variants"]["hold"] = interval(drive, "hold_ret")
    out["split"]["hold"] = halves(drive, discovery, holdout, "hold_ret")
    out["variants"]["fade-sell-at-drive-end"] = interval(fade, "drive_end_ret")
    paired = drive[np.isfinite(drive.ret) & np.isfinite(drive.hold_ret)]
    out["holdMinusSell"] = mean_ci((paired.hold_ret - paired.ret).to_numpy(), paired.game.to_numpy())
    out["fadeMinusLeaderAny"] = {"fade": out["variants"]["fade"], "leaderAny": out["variants"]["leader-any"],
                                 "note": "Not paired (different moments); compare the intervals. The drive's salience matters only if fade is clearly better."}
    sample = sample_text(trades, league, out["games"])
    path = f"research/studies/results/drive-entry-{source}.json"

    status, reason = verdict(out["variants"]["drive"], out["split"]["drive"], MIN_TRADES["comeback-drive"])
    out["evidence"], out["note"] = (None, reason) if status is None else (version_row(
        id=f"{league.lower()}-live-comeback-drive-v1", title=f"{league.upper()} comeback drives (v1)", status=status, sport=league, phases=["live"],
        styles=["taker-scalp"], strategy="comeback-drive", version="1", pooled=out["variants"]["drive"], sample=sample, source=path,
        plain=f"Buying the trailing team in scoring position and selling at the drive's end: {reason}"), reason)

    out["evidenceHold"], out["holdNote"] = hold_row(out["variants"]["hold"], out["split"]["hold"], out["holdMinusSell"], league, path, sample)

    status, reason = verdict(out["variants"]["fade"], out["split"]["fade"], MIN_TRADES["drive-fade"])
    out["evidenceFade"], out["fadeNote"] = (None, reason) if status is None else (version_row(
        id=f"{league.lower()}-live-drive-fade-v1", title=f"{league.upper()} drive fade (v1)", status=status, sport=league, phases=["live"],
        styles=["taker-hold"], strategy="drive-fade", version="1", pooled=out["variants"]["fade"], sample=sample,
        source=path, plain=f"Buying the leader while a trailing longshot drives, held to the final: {reason}"), reason)
    return out


def sample_text(trades: pd.DataFrame, league: str, games: int) -> str:
    first, last = (pd.to_datetime(trades.t.min(), unit="s").date(), pd.to_datetime(trades.t.max(), unit="s").date()) if len(trades) else ("?", "?")
    return f"{games} {league.upper()} games, {first} to {last}"


def hold_row(hold: dict, split: dict, gain: dict, league: str, path: str, sample: str) -> tuple[dict | None, str | None]:
    """The evidence the bot reads at a drive's end (comeback-drive-hold@1). See the module docstring."""
    status, reason = verdict(hold, split, MIN_TRADES["comeback-drive-hold"])
    if status is None:
        return None, reason
    if status == "lead" and not (gain["n"] and gain["mean"] > 0):
        return None, "Holding to the final made money but less than selling at the drive's end, so the bot keeps selling."
    return version_row(id=f"{league.lower()}-live-comeback-drive-hold-v1", title=f"{league.upper()} comeback drives held to the final (v1)",
                       status=status, sport=league, phases=["live"], styles=["taker-hold"], strategy="comeback-drive-hold", version="1",
                       pooled=hold, sample=sample, source=path,
                       plain=f"Holding the drive entries to the final: {reason}" + (f" Holding beat selling by {gain['mean'] * 100:+.1f} points." if status == "lead" else "")), None


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


def live_records(league: str, dest: str | None) -> tuple[pd.DataFrame, dict[str, float]]:
    """Raw recorded books for a league (lib/datastore/recorder.ts rows) and settlements by slug."""
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
    return records, {k: float(v) for k, v in settle.items()}


def live_books(league: str, dest: str | None, clock: str | None) -> pd.DataFrame:
    records, settle = live_records(league, dest)
    return standardize_books(records, settle, clock)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", choices=["nfl", "live"])
    parser.add_argument("--league", choices=["nfl", "cfb"], default="nfl", help="live source only")
    parser.add_argument("--dest", help="lake folder instead of R2 (live source)")
    parser.add_argument("--clock", choices=["countdown", "elapsed"], default="countdown", help="how the feed's football clock runs (live source; verified countdown on Sep 27, 2026)")
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
    print(f"hold - sell (paired): {fmt(summary['holdMinusSell'])}")
    print(f"fade sold at the drive's end instead: {fmt(summary['variants']['fade-sell-at-drive-end'])}")
    print(f"evidence comeback-drive@1: {summary['evidence']['status'] if summary['evidence'] else summary['note']}")
    print(f"evidence comeback-drive-hold@1: {summary['evidenceHold']['status'] if summary['evidenceHold'] else summary['holdNote']}")
    print(f"evidence drive-fade@1: {summary['evidenceFade']['status'] if summary['evidenceFade'] else summary['fadeNote']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
