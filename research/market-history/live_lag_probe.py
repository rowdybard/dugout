"""Live speed test: when do free play feeds publish each play, relative to Polymarket US price moves?

Usage (leave running for the whole slate; the PC must stay awake):
  research/.venv/Scripts/python research/market-history/live_lag_probe.py [--date 2026-09-27]

Records, with this machine's receive time (ms, UTC):
  MLB  statsapi feed/live (fields-filtered, ~1-3 KB) per live game every 2 s: current PA, isComplete,
       event, score, count, operator endTime, feed metaData.timeStamp
  NFL  ESPN public scoreboard every 2 s (one request for all games): situation.lastPlay id/text/type,
       score, down/distance, ESPN's own home win probability
  Books Polymarket US REST book for each matched market every 30 s (cross-check only; exact prices are
       fetched afterwards from /v1/price-history, which is ~1 s resolution for 2026 games)
Output: research/data/live_probe/<date>/{mlb-<gamePk>,nfl,book-<slug>}.jsonl (append-only, one JSON per change).
Analyse afterwards with research/studies/live_lag.py.
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, get_json, session  # noqa: E402

MLB_FIELDS = ("gameData,status,abstractGameState,detailedState,metaData,timeStamp,liveData,plays,currentPlay,"
              "result,eventType,event,awayScore,homeScore,about,atBatIndex,endTime,startTime,isComplete,inning,"
              "isTopInning,count,balls,strikes,outs")
STOP = threading.Event()


def now_ms() -> int:
    return int(time.time() * 1000)


class Sink:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(path, "a", encoding="utf-8")
        self.lock = threading.Lock()
        self.last = None

    def write(self, record: dict, dedupe_key=None) -> None:
        if dedupe_key is not None and dedupe_key == self.last:
            return
        self.last = dedupe_key
        with self.lock:
            self.fh.write(json.dumps(record, separators=(",", ":")) + "\n")
            self.fh.flush()


def fetch(url: str, params: dict | None = None, timeout: float = 8):
    try:
        r = session().get(url, params=params, timeout=timeout)
        return r.status_code, (r.json() if r.ok else None), r.headers
    except Exception as exc:  # network hiccups must never stop the probe
        return -1, {"error": str(exc)}, {}


def mlb_worker(game: dict, out: Path, deadline: float) -> None:
    pk, start = game["gamePk"], datetime.fromisoformat(game["gameDate"].replace("Z", "+00:00"))
    sink = Sink(out / f"mlb-{pk}.jsonl")
    while not STOP.is_set() and datetime.now(timezone.utc) < start - timedelta(minutes=10):
        STOP.wait(30)
    final_seen = None
    while not STOP.is_set() and time.time() < deadline:
        t0 = time.time()
        status, data, _ = fetch(f"https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live", {"fields": MLB_FIELDS})
        recv = now_ms()
        if status == 200 and data:
            cp = (data.get("liveData", {}).get("plays", {}) or {}).get("currentPlay") or {}
            about, res, cnt = cp.get("about", {}), cp.get("result", {}), cp.get("count", {})
            state = data.get("gameData", {}).get("status", {})
            rec = {"recv": recv, "feedTs": data.get("metaData", {}).get("timeStamp"), "state": state.get("abstractGameState"),
                   "detail": state.get("detailedState"), "ab": about.get("atBatIndex"), "complete": about.get("isComplete"),
                   "endTime": about.get("endTime"), "inning": about.get("inning"), "top": about.get("isTopInning"),
                   "event": res.get("eventType"), "away": res.get("awayScore"), "home": res.get("homeScore"),
                   "balls": cnt.get("balls"), "strikes": cnt.get("strikes"), "outs": cnt.get("outs")}
            key = tuple(v for k, v in rec.items() if k not in ("recv", "feedTs"))
            sink.write(rec, key)
            if rec["state"] == "Final":
                final_seen = final_seen or time.time()
                if time.time() - final_seen > 120:
                    return
        else:
            sink.write({"recv": recv, "error": status})
        STOP.wait(max(0.0, 2.0 - (time.time() - t0)))


def nfl_worker(out: Path, deadline: float) -> None:
    sink = Sink(out / "nfl.jsonl")
    last_play: dict[str, str] = {}
    while not STOP.is_set() and time.time() < deadline:
        t0 = time.time()
        status, data, headers = fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")
        recv = now_ms()
        if status == 200 and data:
            live_any = False
            for e in data.get("events", []):
                comp = e["competitions"][0]
                st = e["status"]["type"]
                if st.get("state") != "in" and st.get("name") != "STATUS_FINAL":
                    continue
                live_any = live_any or st.get("state") == "in"
                sit = comp.get("situation") or {}
                lp = sit.get("lastPlay") or {}
                pid = str(lp.get("id"))
                score = {c["homeAway"]: c.get("score") for c in comp["competitors"]}
                if last_play.get(e["id"]) == pid and st.get("state") == "in":
                    continue
                last_play[e["id"]] = pid
                sink.write({"recv": recv, "event": e["id"], "state": st.get("name"), "playId": pid,
                            "type": (lp.get("type") or {}).get("text"), "text": (lp.get("text") or "")[:160],
                            "home": score.get("home"), "away": score.get("away"), "down": sit.get("down"),
                            "distance": sit.get("distance"), "yardLine": sit.get("yardLine"),
                            "possession": sit.get("possession"), "espnHomeWp": (lp.get("probability") or {}).get("homeWinPercentage"),
                            "period": e["status"].get("period"), "clock": e["status"].get("displayClock"),
                            "cache": headers.get("Age") if headers else None})
            if not live_any and datetime.now(timezone.utc).hour >= 5 and datetime.now(timezone.utc).hour < 16:
                return
        STOP.wait(max(0.0, 2.0 - (time.time() - t0)))


def book_worker(slug: str, start: datetime, out: Path, deadline: float) -> None:
    sink = Sink(out / f"book-{slug}.jsonl")
    while not STOP.is_set() and datetime.now(timezone.utc) < start - timedelta(minutes=10):
        STOP.wait(30)
    misses = 0
    while not STOP.is_set() and time.time() < deadline:
        t0 = time.time()
        status, data, headers = fetch(f"https://gateway.polymarket.us/v1/markets/{slug}/book", {"dugout_read": uuid.uuid4().hex})
        recv = now_ms()
        if status == 200 and data:
            md = data.get("marketData", {})
            px = lambda lv: float(lv["px"]["value"] if isinstance(lv.get("px"), dict) else lv["px"])  # noqa: E731
            bids = sorted((px(l) for l in md.get("bids", [])), reverse=True)
            asks = sorted(px(l) for l in md.get("offers", []))
            sink.write({"recv": recv, "bid": bids[0] if bids else None, "ask": asks[0] if asks else None,
                        "state": md.get("state"), "transactTime": md.get("transactTime"),
                        "cache": headers.get("CF-Cache-Status"), "age": headers.get("Age")})
            if md.get("state") in ("MARKET_STATE_EXPIRED", "MARKET_STATE_RESOLVED", "MARKET_STATE_CLOSED"):
                return
            misses = 0
        else:
            misses += 1
            if status == 404 and misses > 3:
                return
        STOP.wait(max(0.0, 30.0 - (time.time() - t0)))  # light cross-check; the gateway rate-limits bursts (429)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=datetime.now(timezone.utc).date().isoformat())
    parser.add_argument("--hours", type=float, default=19.0, help="maximum runtime")
    args = parser.parse_args()
    out = DATA / "live_probe" / args.date
    deadline = time.time() + args.hours * 3600
    threads = []
    sched = get_json("https://statsapi.mlb.com/api/v1/schedule", {"sportId": 1, "date": args.date, "hydrate": "team"}) or {}
    mlb_games = [g for d in sched.get("dates", []) for g in d["games"] if g["status"].get("abstractGameState") != "Final"]
    meta = {"started": datetime.now(timezone.utc).isoformat(), "mlb": [], "nfl": [], "books": []}
    for g in mlb_games:
        a, h = (g["teams"][s]["team"]["abbreviation"].lower() for s in ("away", "home"))
        slug = f"aec-mlb-{a}-{h}-{g['officialDate']}"
        meta["mlb"].append({"gamePk": g["gamePk"], "start": g["gameDate"], "slug": slug})
        threads.append(threading.Thread(target=mlb_worker, args=(g, out, deadline), daemon=True))
        start = datetime.fromisoformat(g["gameDate"].replace("Z", "+00:00"))
        threads.append(threading.Thread(target=book_worker, args=(slug, start, out, deadline), daemon=True))
        meta["books"].append(slug)
    sb = get_json("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard") or {}
    for e in sb.get("events", []):
        if e["status"]["type"].get("state") == "post":
            continue
        comp = e["competitions"][0]
        teams = {c["homeAway"]: c["team"]["abbreviation"].lower() for c in comp["competitors"]}
        start = datetime.fromisoformat(e["date"].replace("Z", "+00:00"))
        local_date = (start - timedelta(hours=4)).date().isoformat()  # US Eastern (EDT) calendar date
        code = lambda t: {"wsh": "was"}.get(t, t)  # noqa: E731
        slug = f"aec-nfl-{code(teams['away'])}-{code(teams['home'])}-{local_date}"
        meta["nfl"].append({"espnId": e["id"], "start": e["date"], "slug": slug})
        threads.append(threading.Thread(target=book_worker, args=(slug, start, out, deadline), daemon=True))
        meta["books"].append(slug)
    threads.append(threading.Thread(target=nfl_worker, args=(out, deadline), daemon=True))
    out.mkdir(parents=True, exist_ok=True)
    (out / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"probe: {len(meta['mlb'])} MLB games, {len(meta['nfl'])} NFL games, {len(meta['books'])} books -> {out}", flush=True)
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads) and time.time() < deadline:
            time.sleep(30)
    except KeyboardInterrupt:
        STOP.set()
    STOP.set()
    print("probe finished", datetime.now(timezone.utc).isoformat(), flush=True)


if __name__ == "__main__":
    main()
