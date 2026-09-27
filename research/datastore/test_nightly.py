"""Tests for nightly.py and lake.py with synthetic events (no network). Run:
  python research/datastore/test_nightly.py
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import nightly  # noqa: E402
import lake  # noqa: E402

DAY = "2026-10-01"


def event(slug: str, start: str, series: str = "cfb-2026", market_type: str = "football_team_full_game_winner") -> dict:
    return {"id": slug, "slug": slug[4:], "seriesSlug": series, "title": slug, "startTime": start, "finishedTimestamp": start.replace("T0", "T1"),
            "markets": [{"slug": slug, "sportsMarketType": market_type, "gameStartTime": start, "endDate": start, "feeCoefficient": 0.0695,
                         "orderPriceMinTickSize": 0.005, "minimumTradeQty": 0.01, "status": "MARKET_STATUS_RESOLVED",
                         "marketSides": [{"long": True, "description": "Home", "price": "1", "team": {"abbreviation": "h", "name": "Home", "ordering": "away"}},
                                         {"long": False, "description": "Away", "price": "0", "team": {"abbreviation": "a", "name": "Away", "ordering": "home"}}]}]}


PAGES = [
    [event("aec-cfb-new-one-2026-10-02", "2026-10-02T18:00:00Z"), event("aec-cfb-day-one-2026-10-01", "2026-10-01T19:00:00Z"),
     event("atc-cfb-day-one-q1-2026-10-01", "2026-10-01T19:00:00Z", market_type="football_team_first_quarter_winner")],
    [event("aec-cfb-day-two-2026-10-01", "2026-10-01T02:00:00Z"), event("aec-nba-other-2026-10-01", "2026-10-01T02:00:00Z", series="nba-2026"),
     event("aec-cfb-old-2026-09-30", "2026-09-30T23:00:00Z")],
    [event("aec-cfb-older-2026-09-29", "2026-09-29T23:00:00Z")],
]


class FakeGateway:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, params: dict):
        self.calls.append((url, params))
        if url.endswith("/v1/events"):
            page = params["offset"] // 100
            return {"events": PAGES[page] if page < len(PAGES) else []}
        if url.endswith("/v1/price-history"):
            a = params["timestamp.startTimestamp"]
            return {"history": [{"timestamp": a + i * 60, "longPrice": "0.6", "shortPrice": "0.41"} for i in range(3)]}
        raise AssertionError(url)


def main() -> None:
    work = Path(tempfile.mkdtemp())
    original_root = nightly.ROOT
    try:
        nightly.ROOT = work  # staging lives in the temp folder
        dest = str(work / "lake")
        gateway = FakeGateway()
        rows = nightly.collect_day(DAY, ["cfb"], gateway)
        assert sorted(rows.market_slug) == ["aec-cfb-day-one-2026-10-01", "aec-cfb-day-two-2026-10-01"], rows.market_slug.tolist()
        event_pages = [c for c in gateway.calls if c[0].endswith("/v1/events")]
        assert len(event_pages) == 2 and all(p["orderDirection"] == "desc" for _, p in event_pages), "stops after the page older than the day"

        first = nightly.run(DAY, ["cfb"], dest, False, FakeGateway())
        assert first == {"day": DAY, "markets": 2, "alreadyInLake": 0, "published": 2}, first
        files = sorted(str(p.relative_to(work / "lake")) for p in (work / "lake").rglob("*.parquet"))
        assert "lake/pmus_catalog/part_day-2026-10-01.parquet" in files, files
        assert any(f.startswith("lake/pmus_history/league=cfb/month=") and "/day-2026-10-01_" in f for f in files), files
        assert not (work / "data" / "pmus").exists(), "the full catalog location is never written"

        second = nightly.run(DAY, ["cfb"], dest, False, FakeGateway())
        assert second["published"] == 0 and second["alreadyInLake"] == 2, second

        con = lake.connect_for_query(Namespace(local=False, dest=dest))
        assert con.execute("SELECT count(*) FROM pmus_catalog").fetchone()[0] == 2
        assert con.execute("SELECT count(DISTINCT market_slug), count(*) FROM pmus_history").fetchone() == (2, 2 * 3 * len(nightly.pm.history_windows(rows.iloc[0:1].itertuples().__next__())))
        print("nightly: ok")
    finally:
        nightly.ROOT = original_root
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    os.environ.pop("R2_BUCKET", None)
    main()
