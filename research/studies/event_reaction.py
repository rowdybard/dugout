"""Event reaction: after a SURPRISING score, is the team that was scored on too cheap? Pre-registered study of
surprise-fade@1 (lib/decision/catalog.ts, lib/decision/sports/football.ts), with the asymmetry control that separates
an overreaction to surprise from a plain live favourite-longshot effect.

Usage (on the PC, research venv active):
  python research/studies/event_reaction.py nfl [--all]              # NFL history: aligned prices + nflverse snaps
  python research/studies/event_reaction.py cfb [--all]              # college history: aligned prices + ESPN plays
  python research/studies/event_reaction.py live --league cfb [--dest D:/lake]
                                                                     # books the runner recorded, with the feed's score
Writes research/studies/results/event-reaction-<source>.json with the evidence row (if any) to add to a pack
(scripts/evidence-pack.ts add <pack.json> <results.json>).

Mechanism under test (Choi & Hui 2014, JEBO: in-play football betting overreacts to surprising goals and underreacts
to expected ones). Against it: Dugout's own NFL reaction study found 88% of a big play's move priced 30 s after the
snap and +0.4-0.8c of FOLLOW-THROUGH, not reversal (research/studies/report.md). Either result is informative.

Rule (surprise-fade@1; do not change it after seeing results; a changed rule is a new version):
  event    a scoring play: the first report of same-side score changes less than 150 s apart (a touchdown and its try
           are one play; lib/decision/events.ts SCORING_PLAY_MS). History: the scoring play's snap + 10 s.
           Live: the first recorded book showing the new score (the bot's own report time).
  pre      the scorer's midpoint on the last book at least 30 s before the event (PRE_EVENT_LOOKBACK_MS).
  entry    surprise if that price is at most 35c. Between 45 s and 180 s after the event, and before the next scoring
           play, on the first book where the scored-on team's midpoint has fallen at least 8c from its own pre price
           and its spread is at most 2c: buy the scored-on team at its ask. One entry per scoring play.
  exits    primary: hold to settlement. Alternatives (same entries): retrace-half (sell at the bid once the midpoint has
           recovered half of the fall, or at 15 minutes), time-5m, time-15m. Sales need a book with spread <= 5c;
           a position with no such book is held to settlement.
  costs    taker fee on the entry (and on the sale for the alternatives); the spread is paid.
Controls, same games:
  follow         the same entries, other side: buy the scorer (continuation).
  expected-fade  the same rule for EXPECTED scores (scorer at least 50c before). The mechanism predicts
                 surprise-fade > expected-fade; if they are equal, any edge is not about surprise.
  random         random tradable moments and sides held to the final, about one per 5 minutes (live-hold baseline).
Diagnostic (descriptive, not a verdict): the scorer's average price path from the pre price to +45 s, +180 s, +10 min
and +30 min after surprising and expected scores.
Verdict: research/studies/lifecycle.py with the spec's minimum of 80 trades. Row: strategies ["surprise-fade@1"].
History caveat: snap times are the field clock; the feed reports later. `--report-delay` shifts the event time (15 s,
30 s) as a sensitivity check that never changes the verdict run.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RESULTS, fmt, round_trip_return, settle_return  # noqa: E402
from lifecycle import evidence_row, halves, interval, split_games, verdict  # noqa: E402


@dataclass(frozen=True)
class Rule:
    """surprise-fade@1 params (lib/decision/catalog.ts). Keep equal."""
    min_after_s: float = 45
    max_after_s: float = 180
    max_scorer_price: float = 0.35
    min_move: float = 0.08
    max_spread: float = 0.02


RULE = Rule()
EXPECTED_MIN_SCORER = 0.50
PRE_LOOKBACK_S = 30
SCORING_PLAY_S = 150
SNAP_TO_SCORE_S = 10
EXIT_SPREAD = 0.05
RETRACE_CAP_S = 900
RANDOM_EVERY_S = 300
MIN_TRADES = 80
PATH = {"+45s": 45, "+180s": 180, "+10m": 600, "+30m": 1800}
EPS = 1e-9

# Books: game, t (s), yes_ask, yes_bid, fee, yes_win (1/0/0.5/NaN). Scores: game, t (s), side ('yes' | 'no'), points.
BOOKS = ["game", "t", "yes_ask", "yes_bid", "fee", "yes_win"]
SCORES = ["game", "t", "side", "points"]


def scoring_plays(scores: pd.DataFrame) -> pd.DataFrame:
    """Merge same-side score changes less than SCORING_PLAY_S apart into one play, timed from the first."""
    out = []
    for game, s in scores.sort_values(["game", "t"]).groupby("game", sort=True):
        current = None
        for r in s.itertuples(index=False):
            if current and r.side == current["side"] and r.t - current["last"] <= SCORING_PLAY_S:
                current["points"] += r.points
                current["last"] = r.t
                continue
            if current:
                out.append(current)
            current = {"game": game, "t": float(r.t), "side": r.side, "points": r.points, "last": float(r.t)}
        if current:
            out.append(current)
    return pd.DataFrame(out, columns=["game", "t", "side", "points", "last"])


def side_arrays(g: pd.DataFrame, side: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ask, bid = g.yes_ask.to_numpy(float), g.yes_bid.to_numpy(float)
    ask, bid = (ask, bid) if side == "yes" else (1 - bid, 1 - ask)
    return ask, bid, (ask + bid) / 2


def at_or_before(t: np.ndarray, when: float) -> int:
    return int(np.searchsorted(t, when, side="right") - 1)


def sell(g: pd.DataFrame, e: int, side: str, stop_at: float | None, retrace: float | None) -> float:
    """Sell `side` bought at row e at the bid on the first executable book at/after `stop_at`, or once the midpoint
    reaches `retrace`; settle if no executable book follows."""
    t, fee = g.t.to_numpy(float), g.fee.to_numpy(float)
    spread = (g.yes_ask - g.yes_bid).to_numpy(float)
    ask, bid, mid = side_arrays(g, side)
    for j in range(e + 1, len(g)):
        if spread[j] > EXIT_SPREAD + EPS or not 0 < bid[j] < 1:
            continue
        if (stop_at is not None and t[j] >= stop_at) or (retrace is not None and mid[j] >= retrace - EPS):
            return float(round_trip_return(ask[e], bid[j], fee[e]))
    won = g.yes_win.iloc[e] if side == "yes" else 1 - g.yes_win.iloc[e]
    return float(settle_return(ask[e], won, fee[e])) if np.isfinite(won) else np.nan


def entry_for(g: pd.DataFrame, play: dict, next_t: float, rule: Rule = RULE) -> tuple[int, float] | None:
    """(row, faded side's pre-event midpoint) of the entry for one scoring play, or None."""
    t, spread = g.t.to_numpy(float), (g.yes_ask - g.yes_bid).to_numpy(float)
    faded = "no" if play["side"] == "yes" else "yes"
    ask, _, mid = side_arrays(g, faded)
    pre = at_or_before(t, play["t"] - PRE_LOOKBACK_S)
    if pre < 0:
        return None
    for j in range(at_or_before(t, play["t"] + rule.min_after_s - EPS) + 1, len(g)):
        if t[j] > play["t"] + rule.max_after_s or t[j] >= next_t:
            return None
        if mid[pre] - mid[j] >= rule.min_move - EPS and spread[j] <= rule.max_spread + EPS and 0 < ask[j] < 1:
            return j, float(mid[pre])
    return None


def study(books: pd.DataFrame, scores: pd.DataFrame, rule: Rule = RULE, seed: int = 7, shift_s: float = 0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(trades, price paths). Trades: game, variant, side, t, entry, scorer_pre, ret (primary) and the alternatives."""
    rng, rows, paths = np.random.default_rng(seed), [], []
    plays = scoring_plays(scores).assign(t=lambda p: p.t + shift_s)
    for game, g in books.groupby("game", sort=True):
        g = g.sort_values("t").reset_index(drop=True)
        t = g.t.to_numpy(float)
        mine = plays[plays.game == game].sort_values("t").to_dict("records")
        for k, play in enumerate(mine):
            next_t = mine[k + 1]["t"] if k + 1 < len(mine) else np.inf
            pre = at_or_before(t, play["t"] - PRE_LOOKBACK_S)
            if pre < 0:
                continue
            scorer_pre = float(side_arrays(g, play["side"])[2][pre])
            kind = "surprise" if scorer_pre <= rule.max_scorer_price + EPS else "expected" if scorer_pre >= EXPECTED_MIN_SCORER - EPS else None
            _, _, scorer_mid = side_arrays(g, play["side"])
            paths.append({"game": game, "kind": kind or "middle", "scorer_pre": scorer_pre,
                          **{name: float(scorer_mid[i] - scorer_pre) if (i := at_or_before(t, play["t"] + off)) > pre and t[i] < next_t else np.nan
                             for name, off in PATH.items()}})
            if kind is None:
                continue
            hit = entry_for(g, play, next_t, rule)
            if not hit:
                continue
            e, faded_pre = hit
            faded = "no" if play["side"] == "yes" else "yes"
            plans = [("surprise-fade" if kind == "surprise" else "expected-fade", faded)] + ([("follow", play["side"])] if kind == "surprise" else [])
            for variant, side in plans:
                rows.append(trade(g, e, side, variant, scorer_pre, faded_pre if side == faded else None))
        spread = (g.yes_ask - g.yes_bid).to_numpy(float)
        ok = np.flatnonzero((spread <= rule.max_spread + EPS) & (g.yes_ask > 0.02) & (g.yes_ask < 0.98) & (g.yes_bid > 0.02) & (g.yes_bid < 0.98))
        if ok.size:
            count = max(1, int(round((t[-1] - t[0]) / RANDOM_EVERY_S)))
            for r in np.sort(rng.choice(ok, size=min(count, ok.size), replace=False)):
                rows.append(trade(g, int(r), "yes" if rng.random() < 0.5 else "no", "random", np.nan, None))
    columns = ["game", "variant", "side", "t", "entry", "scorer_pre", "ret", "retrace_half", "time_5m", "time_15m"]
    return pd.DataFrame(rows, columns=columns), pd.DataFrame(paths, columns=["game", "kind", "scorer_pre", *PATH])


def trade(g: pd.DataFrame, e: int, side: str, variant: str, scorer_pre: float, side_pre: float | None) -> dict:
    ask, _, mid = side_arrays(g, side)
    t0 = float(g.t.iloc[e])
    won = g.yes_win.iloc[e] if side == "yes" else 1 - g.yes_win.iloc[e]
    target = mid[e] + 0.5 * (side_pre - mid[e]) if side_pre is not None else None
    return {"game": g.game.iloc[e], "variant": variant, "side": side, "t": t0, "entry": float(ask[e]), "scorer_pre": scorer_pre,
            "ret": float(settle_return(ask[e], won, g.fee.iloc[e])) if np.isfinite(won) else np.nan,
            "retrace_half": sell(g, e, side, t0 + RETRACE_CAP_S, target) if target is not None else np.nan,
            "time_5m": sell(g, e, side, t0 + 300, None), "time_15m": sell(g, e, side, t0 + 900, None)}


def summarize(trades: pd.DataFrame, paths: pd.DataFrame, league: str, source: str, sensitivity: dict | None = None) -> dict:
    discovery, holdout = split_games(trades.groupby("game").t.min())
    out = {"league": league, "source": source, "rule": asdict(RULE), "games": int(trades.game.nunique()), "variants": {}, "split": {}, "exits": {}}
    for variant in ["surprise-fade", "follow", "expected-fade", "random"]:
        subset = trades[trades.variant == variant]
        out["variants"][variant] = interval(subset)
        out["split"][variant] = halves(subset, discovery, holdout)
    fade = trades[trades.variant == "surprise-fade"]
    out["exits"] = {"settlement": out["variants"]["surprise-fade"], **{name: interval(fade, name) for name in ["retrace_half", "time_5m", "time_15m"]}}
    out["path"] = {kind: {name: (float(p[name].mean()) if p[name].notna().any() else None) for name in PATH} | {"n": int(len(p))}
                   for kind, p in paths.groupby("kind")}
    out["sensitivity"] = sensitivity or {}
    status, reason = verdict(out["variants"]["surprise-fade"], out["split"]["surprise-fade"], MIN_TRADES)
    first, last = (pd.to_datetime(trades.t.min(), unit="s").date(), pd.to_datetime(trades.t.max(), unit="s").date()) if len(trades) else ("?", "?")
    out["evidence"] = None if status is None else evidence_row(
        id=f"{league.lower()}-live-surprise-fade-v1", title=f"{league.upper()} surprise fade (v1)", status=status, sport=league, phases=["live"],
        styles=["taker-hold"], strategy="surprise-fade", version="1", pooled=out["variants"]["surprise-fade"],
        sample=f"{out['variants']['surprise-fade']['n']} trades over {out['games']} {league.upper()} games, {first} to {last}",
        source=f"research/studies/results/event-reaction-{source}.json",
        plain=f"Buying the team scored on after a surprising score, held to the final: {reason}")
    out["note"] = reason
    return out


# ---- Sources --------------------------------------------------------------------------------------------------

def nfl_history(dense_only: bool = True, league: str = "nfl") -> tuple[pd.DataFrame, pd.DataFrame]:
    """Aligned prices (align_nfl.py or align_cfb.py; the away team is YES here) and scoring plays from pre-snap scores."""
    from common import load
    df = load(league)
    df = df[df.phase == "live"]
    if dense_only:
        gaps = df.groupby("game_id").ts.apply(lambda s: s.diff().median())
        df = df[df.game_id.isin(gaps[gaps <= 5].index)]
    books = pd.DataFrame({"game": df.game_id, "t": df.ts.astype(float), "yes_ask": 1 - df.home_bid, "yes_bid": 1 - df.home_ask,
                          "fee": df.fee_coefficient.fillna(0.0695), "yes_win": 1 - df.home_win})
    snaps = df.dropna(subset=["play_t"]).drop_duplicates(["game_id", "play_t"])
    snaps = pd.DataFrame({"game": snaps.game_id, "snap": (pd.to_datetime(snaps.play_t, utc=True) - pd.Timestamp(0, tz="UTC")).dt.total_seconds(),
                          "yes_pre": snaps.away_score_pre, "no_pre": snaps.home_score_pre})
    return books, scores_from_snaps(snaps)


def scores_from_snaps(snaps: pd.DataFrame) -> pd.DataFrame:
    """Score events from pre-snap scores (game, snap, yes_pre, no_pre): a play scored when the next snap's pre-snap score
    is higher for exactly one team; the event is that play's snap + SNAP_TO_SCORE_S. Corrections are ignored."""
    rows = []
    for game, s in snaps.sort_values(["game", "snap"]).groupby("game", sort=True):
        snap, ys, ns = s.snap.to_numpy(float), s.yes_pre.to_numpy(float), s.no_pre.to_numpy(float)
        for i in range(1, len(s)):
            dy, dn = ys[i] - ys[i - 1], ns[i] - ns[i - 1]
            if (dy > 0) != (dn > 0) and dy >= 0 and dn >= 0:
                rows.append({"game": game, "t": snap[i - 1] + SNAP_TO_SCORE_S, "side": "yes" if dy > 0 else "no", "points": dy + dn})
    return pd.DataFrame(rows, columns=SCORES)


def live_source(league: str, dest: str | None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Runner-recorded books (drive_entry.live_books): scores as the bot's feed reported them, at recording time."""
    from drive_entry import live_books
    frame = live_books(league, dest, None).sort_values(["game", "t"])
    rows = []
    for game, g in frame.groupby("game"):
        ys, ns, t = g.yes_score.to_numpy(float), g.no_score.to_numpy(float), g.t.to_numpy(float)
        for i in range(1, len(g)):
            dy, dn = ys[i] - ys[i - 1], ns[i] - ns[i - 1]
            if (dy > 0) != (dn > 0) and dy >= 0 and dn >= 0:
                rows.append({"game": game, "t": t[i], "side": "yes" if dy > 0 else "no", "points": dy + dn})
    return frame[BOOKS], pd.DataFrame(rows, columns=SCORES)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", choices=["nfl", "cfb", "live"], help="nfl or cfb: history with play-by-play; live: the runner's recordings")
    parser.add_argument("--league", choices=["nfl", "cfb"], default="cfb", help="live source only")
    parser.add_argument("--dest", help="lake folder instead of R2 (live source)")
    parser.add_argument("--all", action="store_true", help="NFL history: include sparsely sampled games (timing is then unreliable)")
    args = parser.parse_args()
    league = args.source if args.source != "live" else args.league
    books, scores = nfl_history(not args.all, args.source) if args.source != "live" else live_source(league, args.dest)
    trades, paths = study(books, scores)
    sensitivity = {}
    if args.source != "live":
        for shift in (15, 30):
            shifted, _ = study(books, scores, shift_s=shift)
            sensitivity[f"+{shift}s report delay"] = interval(shifted[shifted.variant == "surprise-fade"])
    name = args.source if args.source != "live" else f"live-{league}"
    summary = summarize(trades, paths, league, name, sensitivity)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"event-reaction-{name}.json"
    path.write_text(json.dumps(summary, indent=1, default=float) + "\n", encoding="utf-8")
    for variant, ci in summary["variants"].items():
        split = summary["split"][variant]
        print(f"{variant:14s} {fmt(ci)} | discovery {fmt(split['discovery'])} | holdout {fmt(split['holdout'])}")
    for exit_name, ci in summary["exits"].items():
        print(f"  exit {exit_name:12s} {fmt(ci)}")
    for kind, p in summary["path"].items():
        print(f"  path {kind:9s} n={p['n']} " + " ".join(f"{k} {v * 100:+.1f}c" if v is not None else f"{k} n/a" for k, v in p.items() if k != "n"))
    for label, ci in sensitivity.items():
        print(f"  sensitivity {label}: {fmt(ci)}")
    print(f"evidence surprise-fade@1: {summary['evidence']['status'] if summary['evidence'] else summary['note']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
