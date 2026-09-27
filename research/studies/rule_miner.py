"""Rule miner for college football: search thousands of simple entry rules on older games, keep only those that also
win on newer games the search never saw, and write the survivors as evidence rows the bot trades on paper at once
(strategy mined-rule@1, lib/decision/strategies.ts).

Usage (on the PC, research venv active):
  python research/studies/rule_miner.py                  # all settled CFB games in research/data/pmus
  python research/studies/rule_miner.py --null 10        # more calibrated-null runs (how many survivors luck makes)
Writes research/studies/results/rule-miner-cfb.json. Add its rows with:
  node --experimental-strip-types scripts/evidence-pack.ts add pack.json research/studies/results/rule-miner-cfb.json <new-version>

Pre-registered before any run (docs/STRATEGY-ARCHITECTURE.md#lifecycle). Do not change it after seeing results; a changed
search is a new run with a new name, reported alongside this one.
  data      settled CFB moneyline markets (catalog + price history). Only executable quotes (spread <= 5c), no older
            than 5 minutes at the moment, sides priced 2c-98c.
  moments   pregame: every 10 min from 6 h to 5 min before the scheduled start. Live: every 2 min from the scheduled
            start for 4.5 h. Each moment and side is a possible entry: buy at the ask, hold to settlement, taker fee.
  features  exactly as the bot computes them (lib/decision/features.ts), so a rule means the same thing in both:
              price               the side's ask
              spread              ask - bid
              minutesToStart      (scheduled start - now) in minutes; negative once the game is on
              venue               home / away (the market's team ordering)
              pregamePrice        the side's midpoint at the last executable pregame quote (live only)
              moveSincePregame    (side midpoint now - pregamePrice) in cents (live only)
  rules     a contiguous price range of 1-3 ten-cent bands (or any price), plus up to two conditions from the other
            features' bands (below). One entry per rule per game: the first matching moment (YES before NO on ties),
            as the bot enters once per rule per game.
  split     games ordered by scheduled start: the oldest 60% are discovery, the newest 40% holdout.
  selection discovery: rules with at least 40 trades, one-sided t-test on per-game returns, Benjamini-Hochberg at a
            10% false-discovery rate. Of those, at most 20 are carried forward, best discovery lower bound first,
            skipping any whose games overlap more than 80% with one already carried (near-duplicates).
            holdout: a SURVIVOR needs at least 20 holdout trades, a positive holdout mean and a one-sided p-value
            below 0.05 / (number carried forward). Survivors become "lead" rows (paper only). Rules positive in the
            holdout but not significant are listed as "watch" and get no row.
  null      the same search in a world where prices are exactly right: each game's result redrawn from its own closing
            price. Nothing can have an edge there, so its survivors are what luck produces; reported next to the real count.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, RESULTS, mean_ci, settle_return  # noqa: E402

EPS = 1e-9
STALE_S = 300
PREGAME_GRID = [-(6 * 3600) + 600 * i for i in range(36) if 6 * 3600 - 600 * i >= 300]  # seconds relative to start
LIVE_GRID = [120 * i for i in range(int(4.5 * 3600 / 120))]
PRICE_EDGES = [0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98]
# Other features' bands: (label, lo, hi) meaning lo < x <= hi; None = open end.
BANDS: dict[str, list[tuple[str, float | None, float | None]]] = {
    "minutesToStart:pregame": [("5-30 min before", 5, 30), ("30-120 min before", 30, 120), ("2-6 h before", 120, 360)],
    "minutesToStart:live": [("0-30 min in", -30, 0), ("30-90 min in", -90, -30), ("90-150 min in", -150, -90), ("150-270 min in", -270, -150)],
    "pregamePrice": [("pregame <=20c", None, 0.2), ("pregame 20-40c", 0.2, 0.4), ("pregame 40-60c", 0.4, 0.6), ("pregame 60-80c", 0.6, 0.8), ("pregame >80c", 0.8, None)],
    "moveSincePregame": [("down 15c+", None, -15), ("down 5-15c", -15, -5), ("within 5c", -5, 5), ("up 5-15c", 5, 15), ("up 15c+", 15, None)],
    "spread": [("spread <=1.5c", None, 0.015), ("spread 1.5-3.5c", 0.015, 0.035), ("spread 3.5-5c", 0.035, 0.05)],
}
DIMS = {"pregame": ["minutesToStart:pregame", "venue", "spread"], "live": ["minutesToStart:live", "venue", "pregamePrice", "moveSincePregame", "spread"]}
MIN_DISCOVERY, MIN_HOLDOUT, FDR, CARRY, OVERLAP = 40, 20, 0.10, 20, 0.8


@dataclass
class Game:
    """One settled market: quotes (ts, yes_ask, no_ask) sorted by time; YES won (1/0); scheduled start (s)."""
    slug: str
    start: float
    yes_won: float
    fee: float
    yes_ordering: str | None  # 'away' | 'home' | None
    quotes: pd.DataFrame


# ---- Rows: one per moment and side --------------------------------------------------------------------------------

def rows_for(game: Game) -> pd.DataFrame:
    q = game.quotes
    q = q[(q.yes_ask > 0) & (q.yes_ask < 1) & (q.no_ask > 0) & (q.no_ask < 1) & (q.yes_ask + q.no_ask - 1 <= 0.05 + EPS)].sort_values("ts")
    if q.empty:
        return pd.DataFrame()
    ts, yes_ask, no_ask = q.ts.to_numpy(float), q.yes_ask.to_numpy(float), q.no_ask.to_numpy(float)
    pre = np.flatnonzero(ts < game.start)
    close_yes_mid = (yes_ask[pre[-1]] + 1 - no_ask[pre[-1]]) / 2 if pre.size else np.nan
    out = []
    for phase, grid in (("pregame", PREGAME_GRID), ("live", LIVE_GRID)):
        for offset in grid:
            t = game.start + offset
            i = int(np.searchsorted(ts, t, side="right") - 1)
            if i < 0 or t - ts[i] > STALE_S:
                continue
            spread = round(yes_ask[i] + no_ask[i] - 1, 6)
            for side in ("yes", "no"):
                ask = round(yes_ask[i] if side == "yes" else no_ask[i], 6)
                bid = round(1 - no_ask[i] if side == "yes" else 1 - yes_ask[i], 6)
                if not 0.02 < ask < 0.98:
                    continue
                won = game.yes_won if side == "yes" else 1 - game.yes_won
                venue = None if game.yes_ordering not in ("away", "home") else game.yes_ordering if side == "yes" else ("home" if game.yes_ordering == "away" else "away")
                close = close_yes_mid if side == "yes" else 1 - close_yes_mid
                mid = (ask + bid) / 2
                out.append({"game": game.slug, "start": game.start, "t": t, "phase": phase, "side": side, "price": ask, "spread": spread,
                            "minutesToStart": (game.start - t) / 60, "venue": venue,
                            "pregamePrice": close if phase == "live" else np.nan,
                            "moveSincePregame": (mid - close) * 100 if phase == "live" else np.nan,
                            "won": won, "fee": game.fee, "ret": float(settle_return(ask, won, game.fee))})
    return pd.DataFrame(out)


def build_rows(games: list[Game]) -> pd.DataFrame:
    frames = [rows_for(g) for g in games]
    frames = [f for f in frames if not f.empty]
    if not frames:
        return pd.DataFrame()
    rows = pd.concat(frames, ignore_index=True)
    rows["side_order"] = (rows.side == "no").astype(int)
    return rows.sort_values(["game", "t", "side_order"]).reset_index(drop=True)


# ---- Rules ----------------------------------------------------------------------------------------------------------

def band_mask(values: np.ndarray, lo: float | None, hi: float | None) -> np.ndarray:
    """lo < x <= hi, exactly as the engine's gt / lte conditions test it (no tolerance)."""
    ok = np.isfinite(values)
    if lo is not None:
        ok &= values > lo
    if hi is not None:
        ok &= values <= hi
    return ok


def price_ranges() -> list[tuple[float, float] | None]:
    edges, out = PRICE_EDGES, [None]
    for width in (1, 2, 3):
        out += [(edges[i], edges[i + width]) for i in range(len(edges) - width)]
    return out


def conditions_of(phase: str) -> list[list[tuple[str, str, float | None, float | None]]]:
    """Condition sets: none, one band, or two bands from different features. Each item: (feature, label, lo, hi)."""
    singles = []
    for dim in DIMS[phase]:
        if dim == "venue":
            singles.append([("venue", "home", None, None), ("venue", "away", None, None)])
        else:
            singles.append([(dim.split(":")[0], label, lo, hi) for label, lo, hi in BANDS[dim]])
    out: list[list] = [[]]
    for values in singles:
        out += [[v] for v in values]
    for a in range(len(singles)):
        for b in range(a + 1, len(singles)):
            out += [[x, y] for x in singles[a] for y in singles[b]]
    return out


def rule_mask(rows: pd.DataFrame, price: tuple[float, float] | None, conds: list) -> np.ndarray:
    mask = np.ones(len(rows), bool)
    if price is not None:
        p = rows.price.to_numpy(float)
        mask &= (p > price[0] + EPS) & (p <= price[1] + EPS)
    for feature, label, lo, hi in conds:
        if feature == "venue":
            mask &= (rows.venue == label).to_numpy()
        else:
            mask &= band_mask(rows[feature].to_numpy(float), lo, hi)
    return mask


def first_per_game(rows: pd.DataFrame, mask: np.ndarray) -> pd.DataFrame:
    """The first matching moment per game (rows are sorted by game, time, YES before NO)."""
    hit = rows[mask]
    return hit[~hit.game.duplicated()]


def stats(returns: np.ndarray) -> dict:
    n = len(returns)
    if n < 2:
        return {"n": n, "mean": float(returns.mean()) if n else None, "t": None, "p": None}
    mean, sd = float(returns.mean()), float(returns.std(ddof=1))
    t = mean / (sd / math.sqrt(n)) if sd > 0 else (math.inf if mean > 0 else -math.inf)
    return {"n": n, "mean": mean, "t": t, "p": 0.5 * math.erfc(t / math.sqrt(2))}  # one-sided, normal approximation


def describe(phase: str, price, conds) -> str:
    parts = [f"{phase}"] + ([f"price {round(price[0] * 100)}-{round(price[1] * 100)}c"] if price else ["any price"]) + [label for _, label, _, _ in conds]
    return ", ".join(parts)


def conditions_json(conds) -> list[dict]:
    out = []
    for feature, label, lo, hi in conds:
        if feature == "venue":
            out.append({"feature": "venue", "op": "eq", "value": label})
            continue
        if lo is not None:
            out.append({"feature": feature, "op": "gt", "value": lo})
        if hi is not None:
            out.append({"feature": feature, "op": "lte", "value": hi})
    return out


# ---- The search -----------------------------------------------------------------------------------------------------

def split(rows: pd.DataFrame) -> tuple[set, set]:
    starts = rows.groupby("game").start.first().sort_values(kind="stable")
    cut = int(math.floor(len(starts) * 0.6))
    return set(starts.index[:cut]), set(starts.index[cut:])


def search(rows: pd.DataFrame, discovery: set, holdout: set) -> dict:
    tested, candidates = [], []
    disc_rows, hold_rows = rows[rows.game.isin(discovery)], rows[rows.game.isin(holdout)]
    for phase in ("pregame", "live"):
        dp, hp = disc_rows[disc_rows.phase == phase].reset_index(drop=True), hold_rows[hold_rows.phase == phase].reset_index(drop=True)
        if dp.empty:
            continue
        for price in price_ranges():
            for conds in conditions_of(phase):
                trades = first_per_game(dp, rule_mask(dp, price, conds))
                if len(trades) < MIN_DISCOVERY:
                    continue
                s = stats(trades.ret.to_numpy(float))
                tested.append({"phase": phase, "price": price, "conds": conds, "disc": s, "games": set(trades.game), "hold_rows": hp})
    # Benjamini-Hochberg over every rule that had enough discovery trades.
    ps = np.array([r["disc"]["p"] if r["disc"]["p"] is not None else 1.0 for r in tested])
    order = np.argsort(ps)
    passed = np.zeros(len(tested), bool)
    if len(tested):
        thresholds = FDR * (np.arange(1, len(tested) + 1) / len(tested))
        below = np.flatnonzero(ps[order] <= thresholds)
        if below.size:
            passed[order[: below.max() + 1]] = True
    bh = [r for r, ok in zip(tested, passed) if ok and r["disc"]["mean"] > 0]
    # Best discovery lower bound first; skip near-duplicates.
    def lower(r):
        s = r["disc"]
        return s["mean"] - 1.645 * (s["mean"] / s["t"]) if s["t"] and math.isfinite(s["t"]) and s["t"] != 0 else s["mean"]
    for rule in sorted(bh, key=lower, reverse=True):
        if len(candidates) >= CARRY:
            break
        if any(len(rule["games"] & c["games"]) / max(1, len(rule["games"] | c["games"])) > OVERLAP for c in candidates):
            continue
        candidates.append(rule)
    survivors, watch = [], []
    alpha = 0.05 / max(1, len(candidates))
    for rule in candidates:
        hp = rule.pop("hold_rows")
        trades = first_per_game(hp, rule_mask(hp, rule["price"], rule["conds"]))
        rule["hold"] = stats(trades.ret.to_numpy(float))
        rule["holdCi"] = mean_ci(trades.ret.to_numpy(float), trades.game.to_numpy())
        h = rule["hold"]
        if h["n"] >= MIN_HOLDOUT and h["mean"] is not None and h["mean"] > 0 and h["p"] is not None and h["p"] < alpha:
            survivors.append(rule)
        elif h["n"] >= MIN_HOLDOUT and h["mean"] is not None and h["mean"] > 0:
            watch.append(rule)
    for rule in tested:
        rule.pop("hold_rows", None)
    return {"tested": len(tested), "bh": len(bh), "carried": len(candidates), "alpha": alpha, "survivors": survivors, "watch": watch}


def calibrated(rows: pd.DataFrame, seed: int) -> pd.DataFrame:
    """The null world: every game's result redrawn from its own closing price (YES wins with probability equal to its
    last pregame midpoint), so prices are exactly right and no rule has an edge. Survivors here are pure luck."""
    rng = np.random.default_rng(seed)
    yes = rows[rows.side == "yes"]
    close = yes.groupby("game").apply(lambda g: g.pregamePrice.dropna().iloc[0] if g.pregamePrice.notna().any() else g.price.iloc[0] - g.spread.iloc[0] / 2, include_groups=False)
    close = close.reindex(rows.game.unique()).fillna(0.5)
    draw = dict(zip(close.index, (rng.random(len(close)) < close.to_numpy()).astype(float)))
    out = rows.copy()
    w = out.game.map(draw).to_numpy(float)
    w = np.where(out.side == "yes", w, 1 - w)
    out["won"] = w
    out["ret"] = settle_return(out.price.to_numpy(float), w, out.fee.to_numpy(float))
    return out


def rule_row(rule: dict, games: int, first: str, last: str) -> dict:
    key = json.dumps([rule["phase"], rule["price"], [c[:2] for c in rule["conds"]]])
    rid = f"cfb-mined-{rule['phase']}-{hashlib.sha256(key.encode()).hexdigest()[:10]}"
    ci, text = rule["holdCi"], describe(rule["phase"], rule["price"], rule["conds"])
    row = {"id": rid, "title": f"Mined CFB rule: {text}", "status": "lead", "sports": ["CFB"], "phases": [rule["phase"]], "styles": ["taker-hold"],
           "strategies": ["mined-rule@1"],
           "estimate": {"mean": round(ci["mean"], 4), "lo": round(ci["lo"], 4), "hi": round(ci["hi"], 4), "unit": "return"},
           "sample": f"discovery {rule['disc']['n']} games, holdout {rule['hold']['n']} games of {games} CFB games, {first} to {last}",
           "source": "research/studies/results/rule-miner-cfb.json",
           "plain": (f"{text}: buy at the ask, hold to the final. Discovery {rule['disc']['mean'] * 100:+.1f}%, later holdout "
                     f"{rule['hold']['mean'] * 100:+.1f}% after fees and spread. Paper only until forward trades agree.")}
    if rule["price"]:
        row["price"] = {"min": rule["price"][0], "max": rule["price"][1]}
    conds = conditions_json(rule["conds"])
    if conds:
        row["conditions"] = conds
    return row


def summarize(rule: dict) -> dict:
    return {"rule": describe(rule["phase"], rule["price"], rule["conds"]), "discovery": rule["disc"], "holdout": rule.get("hold"), "holdoutCi": rule.get("holdCi")}


def mine(rows: pd.DataFrame, null_runs: int = 5) -> dict:
    discovery, holdout = split(rows)
    real = search(rows, discovery, holdout)
    starts = rows.groupby("game").start.first()
    first, last = (pd.to_datetime(starts.min(), unit="s").date().isoformat(), pd.to_datetime(starts.max(), unit="s").date().isoformat()) if len(starts) else ("?", "?")
    nulls = []
    for seed in range(null_runs):
        n = search(calibrated(rows, seed), discovery, holdout)
        nulls.append({"tested": n["tested"], "bh": n["bh"], "survivors": len(n["survivors"])})
    baseline = {phase: mean_ci(first_per_game(rows[rows.phase == phase].reset_index(drop=True), np.ones((rows.phase == phase).sum(), bool)).ret.to_numpy(float))
                for phase in ("pregame", "live")}
    return {"league": "cfb", "games": int(rows.game.nunique()), "discoveryGames": len(discovery), "holdoutGames": len(holdout), "from": first, "to": last,
            "rulesTested": real["tested"], "discoveryPassedFdr": real["bh"], "carriedToHoldout": real["carried"], "holdoutAlpha": real["alpha"],
            "survivors": [summarize(r) for r in real["survivors"]], "watch": [summarize(r) for r in real["watch"]],
            "null": {"runs": null_runs, "perRun": nulls, "meanSurvivors": float(np.mean([n["survivors"] for n in nulls])) if nulls else None},
            "baselineFirstMomentPerGame": baseline,
            "evidence": [rule_row(r, int(rows.game.nunique()), first, last) for r in real["survivors"]]}


# ---- Data -----------------------------------------------------------------------------------------------------------

def load_cfb() -> list[Game]:
    catalog = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
    full = {"moneyline", "football_team_full_game_winner"}
    cat = catalog[(catalog.league == "cfb") & catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(full) & catalog.long_settle.isin([0.0, 1.0])]
    games = []
    for m in cat.itertuples():
        path = DATA / "pmus" / "history" / "cfb" / f"{m.market_slug}.parquet"
        if not path.exists() or pd.isna(m.start_ts):
            continue
        h = pd.read_parquet(path)
        if h.empty:
            continue
        h = h.sort_values(["ts", "seq"]).groupby("ts").tail(1)
        games.append(Game(slug=m.market_slug, start=float(m.start_ts), yes_won=float(m.long_settle), fee=float(m.fee_coefficient) if pd.notna(m.fee_coefficient) else 0.0695,
                          yes_ordering=getattr(m, "long_ordering", None), quotes=pd.DataFrame({"ts": h.ts.astype(float), "yes_ask": h.long.astype(float), "no_ask": h.short.astype(float)})))
    return games


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--null", type=int, default=5, help="calibrated-null runs (default 5)")
    args = parser.parse_args()
    games = load_cfb()
    print(f"{len(games)} settled CFB games; building moments...", flush=True)
    rows = build_rows(games)
    print(f"{len(rows)} candidate entries; searching...", flush=True)
    result = mine(rows, args.null)
    RESULTS.mkdir(parents=True, exist_ok=True)
    path = RESULTS / "rule-miner-cfb.json"
    path.write_text(json.dumps(result, indent=1, default=float) + "\n", encoding="utf-8")
    print(f"games {result['games']} ({result['discoveryGames']} discovery, {result['holdoutGames']} holdout), {result['from']} to {result['to']}")
    print(f"rules tested {result['rulesTested']}; passed the discovery FDR {result['discoveryPassedFdr']}; carried to holdout {result['carriedToHoldout']}")
    print(f"SURVIVORS {len(result['survivors'])}   (if prices were exactly right: {result['null']['meanSurvivors']} per run on average)")
    for s in result["survivors"]:
        print(f"  + {s['rule']}: discovery {s['discovery']['mean'] * 100:+.1f}% (n={s['discovery']['n']}), holdout {s['holdout']['mean'] * 100:+.1f}% (n={s['holdout']['n']})")
    for s in result["watch"]:
        print(f"  ? {s['rule']}: holdout {s['holdout']['mean'] * 100:+.1f}% (n={s['holdout']['n']}), not significant")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()
