"""Polymarket US historical game-winner markets: catalog + price history.

Usage (from repo root):
  research/.venv/Scripts/python research/market-history/fetch_polymarket_us.py catalog
  research/.venv/Scripts/python research/market-history/fetch_polymarket_us.py history --leagues nfl,cfb,mlb,atp,wta

catalog: crawls every closed event (GET /v1/events?closed=true, ascending start time, offset paging)
         and keeps one row per moneyline market -> research/data/pmus/catalog.parquet
history: per market, GET /v1/price-history over [start - 12h, finish + 15m] in <=24h windows
         -> research/data/pmus/history/<league>/<market slug>.parquet (ts, seq, long, short)

Verified facts (Sep 27, 2026): no auth; custom windows up to 24h return every stored observation
(2,112 points for a CFB game day, no ~1k cap); duplicate timestamps occur, so arrival order is kept
in `seq`. longPrice is the ask-derived YES price; estimated YES bid = 1 - shortPrice.
Both steps are resumable.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, RateLimiter, get_json, iso_to_epoch, update_manifest  # noqa: E402

BASE = "https://gateway.polymarket.us"
OUT = DATA / "pmus"
PAGES = OUT / "catalog_pages"
CATALOG = OUT / "catalog.parquet"
HISTORY = OUT / "history"
PAGE_SIZE = 100
PREGAME_S = 12 * 3600
POSTGAME_S = 15 * 60
WINDOW_S = 24 * 3600
TARGET_LEAGUES = ("nfl", "cfb", "mlb", "atp", "wta")
# Full-game winner markets use the aec- prefix; atc-/astatc- slugs are sub-markets
# (first five innings, single innings, quarters, halves, sets), which history skips unless --all-types.
FULL_GAME_TYPES = {"moneyline", "football_team_full_game_winner", "baseball_team_full_game_winner", "tennis_match_winner"}


def is_full_game(catalog: pd.DataFrame) -> pd.Series:
    return catalog.market_slug.str.startswith("aec-") & catalog.market_type.isin(FULL_GAME_TYPES)


def league_of(event: dict) -> str:
    series = event.get("seriesSlug") or ""
    return series.split("-")[0] if series else ""


def side_row(side: dict | None) -> dict:
    side = side or {}
    team = side.get("team") or {}
    return {"name": side.get("description"), "abbr": team.get("abbreviation"), "team": team.get("name"),
            "ordering": team.get("ordering"), "settle": _num(side.get("price"))}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def slim_markets(event: dict) -> list[dict]:
    rows = []
    for m in event.get("markets", []):
        v2, v1 = m.get("sportsMarketTypeV2") or "", m.get("sportsMarketType") or ""
        if v2 != "SPORTS_MARKET_TYPE_MONEYLINE" and not v1.endswith("_winner"):
            continue
        sides = m.get("marketSides") or []
        long_side = next((s for s in sides if s.get("long") is True), None)
        short_side = next((s for s in sides if s.get("long") is False), None)
        lg, sh = side_row(long_side), side_row(short_side)
        rows.append({
            "event_id": event.get("id"), "event_slug": event.get("slug"), "series": event.get("seriesSlug"),
            "league": league_of(event), "title": event.get("title"),
            "start_ts": iso_to_epoch(m.get("gameStartTime") or event.get("startTime")),
            "finished_ts": iso_to_epoch(event.get("finishedTimestamp")),
            "market_end_ts": iso_to_epoch(m.get("endDate")),
            "final_score": event.get("score"), "final_period": event.get("period"),
            "sportradar_game_id": event.get("sportradarGameId"), "game_id": event.get("gameId"),
            "market_slug": m.get("slug"), "market_type": v1, "market_type_v2": v2, "status": m.get("status"),
            "fee_coefficient": _num(m.get("feeCoefficient")), "tick": _num(m.get("orderPriceMinTickSize")),
            "min_qty": _num(m.get("minimumTradeQty")),
            **{f"long_{k}": v for k, v in lg.items()}, **{f"short_{k}": v for k, v in sh.items()},
        })
    return rows


def crawl_catalog() -> None:
    PAGES.mkdir(parents=True, exist_ok=True)
    limiter = RateLimiter(4)
    done = sorted(int(p.name.split("-")[1].split(".")[0]) for p in PAGES.glob("page-*.jsonl.gz"))
    # Resume by re-reading the last saved page: it may have been partial when the crawl stopped.
    offset = done[-1] if done else 0
    while True:
        data = get_json(f"{BASE}/v1/events", {"closed": "true", "limit": PAGE_SIZE, "offset": offset,
                                              "orderBy": "startTime", "orderDirection": "asc"}, limiter)
        events = (data or {}).get("events") or []
        if not events:
            break
        rows = [row for e in events for row in slim_markets(e)]
        with gzip.open(PAGES / f"page-{offset:07d}.jsonl.gz", "wt", encoding="utf-8") as fh:
            fh.write(json.dumps({"offset": offset, "events": len(events)}) + "\n")
            for row in rows:
                fh.write(json.dumps(row) + "\n")
        if offset % 5000 == 0:
            print(f"catalog offset {offset}: {len(rows)} moneylines, last start {events[-1].get('startTime')}", flush=True)
        # Short pages happen mid-catalog (observed: 99 of 100); only an empty page ends the crawl.
        offset += PAGE_SIZE
    build_catalog()


def build_catalog() -> pd.DataFrame:
    rows, events = [], 0
    for page in sorted(PAGES.glob("page-*.jsonl.gz")):
        with gzip.open(page, "rt", encoding="utf-8") as fh:
            events += json.loads(next(fh))["events"]
            rows.extend(json.loads(line) for line in fh)
    df = pd.DataFrame(rows).drop_duplicates("market_slug", keep="last")
    df.to_parquet(CATALOG, index=False)
    by_league = df.groupby("league").agg(markets=("market_slug", "size"), first=("start_ts", "min"), last=("start_ts", "max"))
    summary = {lg: {"markets": int(r.markets), "firstStart": pd.to_datetime(r["first"], unit="s").isoformat(),
                    "lastStart": pd.to_datetime(r["last"], unit="s").isoformat()}
               for lg, r in by_league.iterrows() if lg}
    update_manifest("polymarketUsCatalog", {"eventsScanned": events, "moneylineMarkets": len(df),
                                            "path": str(CATALOG.relative_to(DATA)), "byLeague": summary})
    print(f"catalog: {events} events scanned, {len(df)} moneyline markets")
    for lg in TARGET_LEAGUES:
        if lg in summary:
            print(f"  {lg}: {summary[lg]}")
    return df


def history_windows(row) -> list[tuple[int, int]]:
    start = int(row.start_ts)
    end_candidates = [v for v in (row.finished_ts, row.market_end_ts) if pd.notna(v)]
    end = int(min(end_candidates)) + POSTGAME_S if end_candidates else start + 6 * 3600
    end = max(end, start + 3600)
    a, windows = start - PREGAME_S, []
    while a < end:
        b = min(end, a + WINDOW_S)
        windows.append((a, b))
        a = b
    return windows


def fetch_one(row, limiter: RateLimiter) -> tuple[str, int]:
    path = HISTORY / row.league / f"{row.market_slug}.parquet"
    if path.exists():
        return "skip", 0
    points = []
    for a, b in history_windows(row):
        data = get_json(f"{BASE}/v1/price-history", {"symbol": row.market_slug, "timestamp.startTimestamp": a,
                                                      "timestamp.endTimestamp": b, "fidelity": 1}, limiter)
        points.extend((data or {}).get("history") or [])
    df = pd.DataFrame({"ts": [int(p["timestamp"]) for p in points],
                       "long": [_num(p.get("longPrice")) for p in points],
                       "short": [_num(p.get("shortPrice")) for p in points]})
    df["seq"] = range(len(df))
    df = df.astype({"ts": "int64", "seq": "int32", "long": "float32", "short": "float32"})
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)  # empty files are kept so empties are not re-requested
    return ("empty" if df.empty else "ok"), len(df)


def fetch_history(leagues: list[str], workers: int, rate: float, all_types: bool = False) -> None:
    catalog = pd.read_parquet(CATALOG)
    todo = catalog[catalog.league.isin(leagues) & catalog.start_ts.notna() & (all_types | is_full_game(catalog))]
    todo = todo.sort_values("start_ts")
    limiter = RateLimiter(rate)
    counts = {"ok": 0, "empty": 0, "skip": 0, "error": 0}
    points = 0
    print(f"history: {len(todo)} markets for {leagues}", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(fetch_one, row, limiter): row.market_slug for row in todo.itertuples()}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                status, n = fut.result()
            except Exception as exc:  # keep going; a rerun retries failures
                status, n = "error", 0
                print(f"error {futures[fut]}: {exc}", flush=True)
            counts[status] += 1
            points += n
            if i % 250 == 0:
                print(f"history {i}/{len(todo)} {counts} points+{points}", flush=True)
    summarize_history()
    print(f"history done {counts}")


def summarize_history() -> None:
    summary = {}
    for league_dir in sorted(p for p in HISTORY.glob("*") if p.is_dir()):
        files = list(league_dir.glob("*.parquet"))
        rows = sum(pd.read_parquet(f, columns=["ts"]).shape[0] for f in files)
        empty = sum(1 for f in files if pd.read_parquet(f, columns=["ts"]).empty)
        summary[league_dir.name] = {"markets": len(files), "emptyMarkets": empty, "points": rows}
    update_manifest("polymarketUsHistory", {"path": str(HISTORY.relative_to(DATA)), "byLeague": summary,
                                            "fields": "ts (unix s), seq (arrival order), long (YES ask-derived), short (NO)"})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("catalog")
    sub.add_parser("rebuild-catalog")
    h = sub.add_parser("history")
    h.add_argument("--leagues", default=",".join(TARGET_LEAGUES))
    h.add_argument("--workers", type=int, default=4)
    h.add_argument("--rate", type=float, default=6.0, help="max requests per second across workers")
    h.add_argument("--all-types", action="store_true", help="include sub-markets (innings, quarters, sets)")
    sub.add_parser("summarize")
    args = parser.parse_args()
    if args.cmd == "catalog":
        crawl_catalog()
    elif args.cmd == "rebuild-catalog":
        build_catalog()
    elif args.cmd == "history":
        fetch_history(args.leagues.split(","), args.workers, args.rate, args.all_types)
    else:
        summarize_history()


if __name__ == "__main__":
    main()
