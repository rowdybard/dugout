"""Quiet windows: do resting orders placed only while the ball is dead avoid the informed flow that makes NFL live
quoting lose? Pre-registered study of quiet-window-maker@1 (lib/decision/catalog.ts), paired by game against the bot's
current quoting rule (maker-quote@1) and against always-on quoting.

Usage (on the PC, research venv active):
  python research/studies/maker_windows.py nfl [--all]               # NFL history: aligned prices + nflverse snaps
  python research/studies/maker_windows.py live --league cfb [--dest D:/lake]
                                                                     # books the runner recorded with the feed's state
Writes research/studies/results/maker-windows-<source>.json with the evidence row (if any).

Mechanism (Glosten & Milgrom 1985; Lee, Mucklow & Ready 1993): a quote loses to traders who know the next price.
In football that information arrives with each snap; while the ball is dead there is little to know, so a quote resting
only then should face less adverse selection. Against it: dead-ball fills may be rare, and NFL feed latency may leave
too little of each window. Dugout's markout study found NFL live maker flow toxic (-0.40c per contract at 60 s).

Fills and markouts follow maker_markout.py: the YES bid and YES ask (the NO bid) each rest at the best price and move
with it; conservative fill = the opposite best price trades through ours, optimistic fill = our level is consumed.
After a fill the order rests again 5 s later. Markout per contract = mid at +10/60/300 s (and settlement) minus the fill
price (mirrored for the ask) plus the maker rebate 0.0125 * p * (1 - p). Liquidity rewards are NOT included.
Variants, same games and books:
  window        quiet-window-maker@1: rest only within 20 s of the start of a dead-ball report, while the spread is
                at most 3c and the midpoint moved less than 2c over the last 30 s; pulled otherwise.
                History: a dead-ball report follows each scoring play, at its snap + 10 s + REPORT_DELAY (the feed marks
                "between plays" after scores; kick types are not supplied). Live: the feed's between-plays flag.
  maker-quote   maker-quote@1 as the bot runs it live: spread at most 5c, pulled for 30 s after each game report.
  always        spread at most 5c, never pulled (maker_markout.py's live rule).
  between-snaps DIAGNOSTIC for a possible new version, never a verdict: every gap between snaps, from the end of the
                play (snap + 7 s + REPORT_DELAY) for up to 20 s or until the next snap is reported.
Verdict (lifecycle.py; spec minimum 300 fills): on the window variant's OPTIMISTIC 60-s markout (as the existing maker
rows), split into discovery and holdout games. A "lead" additionally needs the CONSERVATIVE 60-s markout to beat
maker-quote@1's on the same games (paired, mean difference above zero); otherwise no row, since the bot already has a
quoting rule and this one is only worth running if it is better. Rows name quiet-window-maker@1; units are cents.
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
from common import RESULTS, mean_ci  # noqa: E402
from lifecycle import evidence_row, split_games, verdict  # noqa: E402


@dataclass(frozen=True)
class Rule:
    """quiet-window-maker@1 params (lib/decision/catalog.ts). Keep equal."""
    max_window_s: float = 20
    max_spread: float = 0.03
    pull_on_move: float = 0.02


RULE = Rule()
BASE_SPREAD = 0.05       # maker-quote@1 maxQuoteSpread
BASE_PULL_S = 30         # maker-quote@1 pullMsFootball
REPORT_DELAY = 5         # seconds from the field to the bot's feed (assumed; the live source needs none)
SNAP_TO_SCORE = 10
PLAY_S = 7
CALM_S = 30
HORIZONS = (10, 60, 300)
REQUOTE = 5
REBATE = 0.0125
MIN_FILLS = 300
EPS = 1e-9
VARIANTS = ["window", "maker-quote", "always", "between-snaps"]

# Books: game, t (s), yes_ask, yes_bid, yes_win, and one boolean column per variant: may an order rest at this book?


def calm_mask(t: np.ndarray, mid: np.ndarray, move: float = RULE.pull_on_move) -> np.ndarray:
    """|midpoint now - midpoint 30 s ago| below `move` (unknown at the start of the series: not calm)."""
    j = np.searchsorted(t, t - CALM_S, side="right") - 1
    ok = j >= 0
    out = np.zeros(len(t), bool)
    out[ok] = np.abs(mid[ok] - mid[j[ok]]) < move - EPS
    return out


def in_windows(t: np.ndarray, starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
    """Rows inside any [start, end) window."""
    out = np.zeros(len(t), bool)
    for a, b in zip(starts, ends):
        out |= (t >= a) & (t < b)
    return out


def simulate(t: np.ndarray, bid: np.ndarray, ask: np.ndarray, ok: np.ndarray, settle: float, model: str) -> list[list]:
    """Fills of a YES bid and a YES ask resting only on rows where `ok`. Returns [side, t, px, m10, m60, m300, settle]."""
    mid, end, out = (bid + ask) / 2, t[-1] if len(t) else 0, []
    for side in ("bid", "ask"):
        rest, rest_from = None, t[0] if len(t) else 0
        for i in range(len(t)):
            if not ok[i]:
                rest = None
                continue
            if rest is None:
                if t[i] >= rest_from:
                    rest = bid[i] if side == "bid" else ask[i]
                continue
            if side == "bid":
                filled = (bid[i] < rest - EPS) if model == "optimistic" else (ask[i] <= rest + EPS)
                improved = bid[i] > rest + EPS
            else:
                filled = (ask[i] > rest + EPS) if model == "optimistic" else (bid[i] >= rest - EPS)
                improved = ask[i] < rest - EPS
            if filled:
                sign, rebate = (1.0 if side == "bid" else -1.0), REBATE * rest * (1 - rest)
                marks = []
                for h in HORIZONS:
                    j = np.searchsorted(t, t[i] + h, side="right") - 1
                    marks.append(100 * (sign * (mid[j] - rest) + rebate) if t[i] + h <= end else np.nan)
                out.append([side, float(t[i]), float(rest), *marks, 100 * (sign * (settle - rest) + rebate) if np.isfinite(settle) else np.nan])
                rest, rest_from = None, t[i] + REQUOTE
            elif improved:
                rest = bid[i] if side == "bid" else ask[i]
    return out


def study(books: pd.DataFrame) -> pd.DataFrame:
    """Every fill of every variant under both fill models (markouts in cents per contract)."""
    rows = []
    for game, g in books.groupby("game", sort=True):
        g = g.sort_values("t")
        t, bid, ask = g.t.to_numpy(float), g.yes_bid.to_numpy(float), g.yes_ask.to_numpy(float)
        settle = float(g.yes_win.iloc[0]) if pd.notna(g.yes_win.iloc[0]) else np.nan
        for variant in VARIANTS:
            ok = g[variant].to_numpy(bool)
            for model in ("conservative", "optimistic"):
                rows += [[game, variant, model, *fill] for fill in simulate(t, bid, ask, ok, settle, model)]
    return pd.DataFrame(rows, columns=["game", "variant", "model", "side", "t", "px", *[f"m{h}" for h in HORIZONS], "settle"])


def summarize(fills: pd.DataFrame, games: pd.Series, league: str, source: str) -> dict:
    """`games`: each game's first observation time (the discovery/holdout split uses every game, not only those with fills)."""
    discovery, holdout = split_games(games)
    out = {"league": league, "source": source, "rule": asdict(RULE), "reportDelay": REPORT_DELAY, "games": int(len(games)), "variants": {}}
    for variant in VARIANTS:
        out["variants"][variant] = {}
        for model in ("conservative", "optimistic"):
            f = fills[(fills.variant == variant) & (fills.model == model)]
            out["variants"][variant][model] = {"fills": int(len(f)), "fillsPerGame": len(f) / max(1, len(games)),
                                               **{f"markout{h}s": mean_ci(f[f"m{h}"].to_numpy(), f.game.to_numpy()) for h in HORIZONS},
                                               "toSettlement": mean_ci(f.settle.to_numpy(), f.game.to_numpy())}
    out["paired"] = {model: paired(fills, "window", "maker-quote", model) for model in ("conservative", "optimistic")}
    window = fills[(fills.variant == "window") & (fills.model == "optimistic")]
    pooled = mean_ci(window.m60.to_numpy(), window.game.to_numpy())
    split = {"discovery": mean_ci(window[window.game.isin(discovery)].m60.to_numpy(), window[window.game.isin(discovery)].game.to_numpy()),
             "holdout": mean_ci(window[window.game.isin(holdout)].m60.to_numpy(), window[window.game.isin(holdout)].game.to_numpy())}
    out["split"] = {"window": split}
    status, reason = verdict(pooled, split, MIN_FILLS, unit="cents")
    better = out["paired"]["conservative"]
    if status == "lead" and not (better["n"] and better["mean"] > 0):
        status, reason = None, f"{reason} But conservative fills did no better than maker-quote@1's on the same games ({better['mean'] or 0:+.2f}c), so no row."
    cons = out["variants"]["window"]["conservative"]["markout60s"]
    out["evidence"] = None if status is None else evidence_row(
        id=f"{league.lower()}-live-quiet-window-maker-v1", title=f"{league.upper()} dead-ball resting orders (v1)", status=status, sport=league,
        phases=["live"], styles=["maker"], strategy="quiet-window-maker", version="1", pooled=pooled, unit="cents",
        conservative={"mean": round(cons["mean"], 4), "lo": round(cons["lo"], 4), "hi": round(cons["hi"], 4), "unit": "cents"} if cons["n"] else None,
        sample=f"{len(window)} fills over {out['games']} {league.upper()} games", source=f"research/studies/results/maker-windows-{source}.json",
        plain=f"Resting orders only while the ball is dead: {reason}")
    out["note"] = reason
    return out


def paired(fills: pd.DataFrame, a: str, b: str, model: str) -> dict:
    """Per-game mean 60-s markout of variant a minus variant b, over games where both filled; clustered CI by game."""
    per = fills[fills.model == model].groupby(["game", "variant"]).m60.mean().unstack()
    if a not in per or b not in per:
        return {"n": 0, "mean": None, "lo": None, "hi": None}
    both = per[[a, b]].dropna()
    return mean_ci((both[a] - both[b]).to_numpy(), both.index.to_numpy())


# ---- Sources --------------------------------------------------------------------------------------------------

def windows_from_snaps(t: np.ndarray, mid: np.ndarray, spread: np.ndarray, snaps: np.ndarray, scores: np.ndarray) -> dict[str, np.ndarray]:
    """Per-book permission for each variant, from snap times and scoring-play event times (history)."""
    snaps, scores = np.sort(snaps), np.sort(scores)
    calm = calm_mask(t, mid)
    dead_start = scores + REPORT_DELAY
    window = in_windows(t, dead_start, dead_start + RULE.max_window_s) & calm & (spread <= RULE.max_spread + EPS)
    reported = snaps + REPORT_DELAY
    pulled = in_windows(t, reported, reported + BASE_PULL_S)
    ends = np.minimum(snaps + PLAY_S + REPORT_DELAY + RULE.max_window_s, np.append(snaps[1:], np.inf) + REPORT_DELAY)
    between = in_windows(t, snaps + PLAY_S + REPORT_DELAY, ends) & calm & (spread <= RULE.max_spread + EPS)
    base = spread <= BASE_SPREAD + EPS
    return {"window": window, "maker-quote": base & ~pulled, "always": base, "between-snaps": between}


def windows_from_feed(t: np.ndarray, mid: np.ndarray, spread: np.ndarray, between: np.ndarray, report: np.ndarray) -> dict[str, np.ndarray]:
    """Per-book permission from recorded feed state (live): `between` = the between-plays flag, `report` = report time."""
    calm = calm_mask(t, mid)
    started = np.full(len(t), np.nan)
    for i in range(len(t)):
        started[i] = (started[i - 1] if i and between[i - 1] else t[i]) if between[i] else np.nan
    window = between & (t - np.nan_to_num(started, nan=np.inf) <= RULE.max_window_s + EPS) & calm & (spread <= RULE.max_spread + EPS)
    first_seen = pd.Series(t).groupby(pd.Series(report)).transform("min").to_numpy(float)
    pulled = np.isfinite(report) & (t - first_seen < BASE_PULL_S)
    base = spread <= BASE_SPREAD + EPS
    return {"window": window, "maker-quote": base & ~pulled, "always": base, "between-snaps": np.zeros(len(t), bool)}


def nfl_history(dense_only: bool = True) -> pd.DataFrame:
    from common import load
    from event_reaction import scores_from_snaps
    df = load("nfl")
    df = df[df.phase == "live"]
    if dense_only:
        gaps = df.groupby("game_id").ts.apply(lambda s: s.diff().median())
        df = df[df.game_id.isin(gaps[gaps <= 5].index)]
    frames = []
    for game, g in df.sort_values(["game_id", "ts", "seq"]).groupby("game_id"):
        g = g.groupby("ts").tail(1)
        t, bid, ask = g.ts.to_numpy(float), 1 - g.home_ask.to_numpy(float), 1 - g.home_bid.to_numpy(float)
        plays = g.dropna(subset=["play_t"]).drop_duplicates("play_t")
        snap = (pd.to_datetime(plays.play_t, utc=True) - pd.Timestamp(0, tz="UTC")).dt.total_seconds().to_numpy(float)
        scores = scores_from_snaps(pd.DataFrame({"game": game, "snap": snap, "yes_pre": plays.away_score_pre.to_numpy(float),
                                                 "no_pre": plays.home_score_pre.to_numpy(float)}))
        masks = windows_from_snaps(t, (bid + ask) / 2, ask - bid, snap, scores.t.to_numpy(float))
        frames.append(pd.DataFrame({"game": game, "t": t, "yes_ask": ask, "yes_bid": bid, "yes_win": 1 - g.home_win.to_numpy(float), **masks}))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["game", "t", "yes_ask", "yes_bid", "yes_win", *VARIANTS])


def live_source(league: str, dest: str | None) -> pd.DataFrame:
    from drive_entry import live_records
    records, settle = live_records(league, dest)
    frames = []
    for slug, r in records.groupby("slug"):
        r = r[r.live & ~r.ended & r.bids.map(lambda b: b is not None and len(b) > 0) & r.asks.map(lambda a: a is not None and len(a) > 0)].sort_values("t")
        if r.empty:
            continue
        t = r.t.to_numpy(float) / 1000
        bid = np.array([float(b[0][0]) for b in r.bids]); ask = np.array([float(a[0][0]) for a in r.asks])
        between = np.array([bool(f.get("betweenPlays")) if isinstance(f, dict) else False for f in r.football])
        report = r.reportTime.to_numpy(float) if "reportTime" in r else np.full(len(r), np.nan)
        masks = windows_from_feed(t, (bid + ask) / 2, ask - bid, between, report)
        frames.append(pd.DataFrame({"game": slug, "t": t, "yes_ask": ask, "yes_bid": bid, "yes_win": settle.get(slug, np.nan), **masks}))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["game", "t", "yes_ask", "yes_bid", "yes_win", *VARIANTS])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", choices=["nfl", "live"])
    parser.add_argument("--league", choices=["nfl", "cfb"], default="cfb", help="live source only")
    parser.add_argument("--dest", help="lake folder instead of R2 (live source)")
    parser.add_argument("--all", action="store_true", help="NFL history: include sparsely sampled games")
    args = parser.parse_args()
    league = "nfl" if args.source == "nfl" else args.league
    books = nfl_history(not args.all) if args.source == "nfl" else live_source(league, args.dest)
    fills = study(books)
    name = "nfl" if args.source == "nfl" else f"live-{league}"
    summary = summarize(fills, books.groupby("game").t.min(), league, name)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / f"maker-windows-{name}.json"
    path.write_text(json.dumps(summary, indent=1, default=float) + "\n", encoding="utf-8")
    cents = lambda ci: f"{ci['mean']:+.2f}c [{ci['lo']:+.2f}, {ci['hi']:+.2f}]" if ci["n"] else "n/a"  # noqa: E731
    for variant, models in summary["variants"].items():
        for model, v in models.items():
            print(f"{variant:13s} {model:12s} fills={v['fills']:6d} ({v['fillsPerGame']:.1f}/game) 10s {cents(v['markout10s'])} "
                  f"60s {cents(v['markout60s'])} 300s {cents(v['markout300s'])} settle {cents(v['toSettlement'])}")
    for model, ci in summary["paired"].items():
        print(f"window - maker-quote ({model}, per game, 60 s): {cents(ci)} over {ci['n']} games")
    print(f"evidence quiet-window-maker@1: {summary['evidence']['status'] if summary['evidence'] else summary['note']}")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
