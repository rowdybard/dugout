"""Dugout Lab: a local page that walks through the college football tests with one button per step.

Start it (Windows): double-click research/lab/Start Dugout Lab.bat
Or from the repo root, research venv active:  python research/lab/lab.py
It opens http://127.0.0.1:8765 in your browser. It listens on this PC only, runs one fixed command at a time (the same
scripts you could type), and never publishes anything unless you press the Publish button.
Progress is remembered in research/lab/state.json (gitignored), so you can close it and pick up where you left off.
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "research"
DATA = RESEARCH / "data"
RESULTS = RESEARCH / "studies" / "results"
LAB = RESEARCH / "lab"
STATE = LAB / "state.json"
PACK = LAB / "pack.json"
PORT = 8765
TOKEN = secrets.token_urlsafe(24)
PY = sys.executable
NODE = ["node", "--experimental-strip-types"]


def py(script: str, *args: str) -> list[str]:
    return [PY, str(RESEARCH / script), *args]


# Each step: id, title, what it does (one line), how long, and its command(s). "check" and "pack" are built in.
STEPS: list[dict] = [
    {"id": "update", "title": "Get the latest code", "what": "Pulls the newest scripts from GitHub.", "time": "seconds",
     "cmds": [["git", "pull", "--ff-only"]]},
    {"id": "check", "title": "Check your data", "what": "Counts the college games, prices and plays on this PC.", "time": "seconds", "cmds": []},
    {"id": "prices", "title": "Refresh college prices", "what": "Adds any new finished games and their price history from Polymarket US.",
     "time": "5-30 min", "cmds": [py("market-history/fetch_polymarket_us.py", "catalog"), py("market-history/fetch_polymarket_us.py", "history", "--leagues", "cfb")]},
    {"id": "plays", "title": "Download college play-by-play", "what": "Every play of every college game from ESPN, with its exact time. Resumable.",
     "time": "20-60 min the first time", "cmds": [py("market-history/fetch_cfb_pbp.py")]},
    {"id": "align", "title": "Line up plays with prices", "what": "Joins each price to the game situation at that second.", "time": "a few min",
     "cmds": [py("market-history/align_cfb.py")]},
    {"id": "miner", "title": "Rule finder: prices only", "what": "Tries ~5,300 simple rules on older games, keeps only those that also win on newer ones.",
     "time": "10-20 min", "cmds": [py("studies/rule_miner.py")], "result": "rule-miner-cfb.json"},
    {"id": "miner-state", "title": "Rule finder: with the game situation", "what": "The same, adding score margin, quarter and who has the ball.",
     "time": "20-40 min", "cmds": [py("studies/rule_miner.py", "--game-state")], "result": "rule-miner-cfb-state.json"},
    {"id": "drives", "title": "Drive tests", "what": "Buying the trailing team as it drives vs buying the leader, with controls.", "time": "a few min",
     "cmds": [py("studies/drive_entry.py", "cfb")], "result": "drive-entry-cfb.json"},
    {"id": "surprise", "title": "Surprise-score test", "what": "After an underdog scores, is the other team too cheap?", "time": "a few min",
     "cmds": [py("studies/event_reaction.py", "cfb")], "result": "event-reaction-cfb.json"},
    {"id": "deadball", "title": "Dead-ball quotes test", "what": "Do resting orders placed only while the ball is dead lose less?", "time": "a few min",
     "cmds": [py("studies/maker_windows.py", "cfb")], "result": "maker-windows-cfb.json"},
    {"id": "pack", "title": "Build the evidence pack", "what": "Collects every rule that passed into one pack and checks it. Nothing is published yet.",
     "time": "seconds", "cmds": []},
    {"id": "publish", "title": "Publish the pack", "what": "Sends the pack to your data lake so the bot starts paper-trading what passed. Needs your R2 keys in research/.env.",
     "time": "seconds", "cmds": [py("datastore/lake.py", "put-pack", str(PACK))]},
]
BY_ID = {step["id"]: step for step in STEPS}
TESTS = ["align", "miner", "miner-state", "drives", "surprise", "deadball"]


# ---- State --------------------------------------------------------------------------------------------------------

lock = threading.Lock()
job: dict = {"id": None, "status": "idle", "log": deque(maxlen=4000), "proc": None, "queue": []}


def saved() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def remember(step_id: str, ok: bool, summary: str) -> None:
    state = saved()
    state[step_id] = {"ok": ok, "at": datetime.now().strftime("%a %d %b, %H:%M"), "summary": summary}
    LAB.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1), encoding="utf-8")


def log(line: str) -> None:
    with lock:
        job["log"].append(line.rstrip("\n"))


# ---- Summaries from result files ------------------------------------------------------------------------------------

def pct(x) -> str:
    return "n/a" if x is None else f"{x * 100:+.1f}%"


def summarize(step_id: str) -> str:
    step = BY_ID[step_id]
    if step_id == "check":
        return check_data()
    if not step.get("result"):
        return ""
    path = RESULTS / step["result"]
    if not path.exists():
        return "No result file was written."
    r = json.loads(path.read_text(encoding="utf-8"))
    if step_id.startswith("miner"):
        luck = r.get("null", {}).get("meanSurvivors")
        lines = [f"{len(r['survivors'])} rules passed (luck alone makes about {luck} per run). {r['rulesTested']} rules tried on {r['games']} games."]
        lines += [f"PASSED: {s['rule']} (older games {pct(s['discovery']['mean'])}, newer games {pct(s['holdout']['mean'])})" for s in r["survivors"]]
        lines += [f"watch: {s['rule']} (newer games {pct(s['holdout']['mean'])}, not significant)" for s in r.get("watch", [])[:5]]
        return "\n".join(lines)
    rows = [r.get("evidence"), r.get("evidenceHold"), r.get("evidenceFade")]
    notes = [r.get("note"), r.get("holdNote"), r.get("fadeNote")]
    out = []
    for row, note in zip(rows, notes):
        if isinstance(row, dict):
            out.append(f"{row['strategies'][0]}: {row['status'].upper()} ({pct(row['estimate']['mean'])} per trade)")
        elif note:
            out.append(f"no verdict: {note}")
    return "\n".join(out) or "Done."


def check_data() -> str:
    lines = []
    try:
        import pandas as pd
        cat = pd.read_parquet(DATA / "pmus" / "catalog.parquet")
        cfb = cat[(cat.league == "cfb") & cat.market_slug.str.startswith("aec-") & cat.long_settle.isin([0.0, 1.0])]
        last = pd.to_datetime(cfb.start_ts.max(), unit="s").date() if len(cfb) else "none"
        lines.append(f"Finished college games in the catalog: {len(cfb)} (latest {last})")
    except Exception as error:  # noqa: BLE001
        lines.append(f"Catalog: missing ({error.__class__.__name__}). Run 'Refresh college prices'.")
    hist = DATA / "pmus" / "history" / "cfb"
    lines.append(f"Games with price history: {len(list(hist.glob('*.parquet'))) if hist.exists() else 0}")
    plays = DATA / "cfb" / "espn" / "plays.parquet"
    if plays.exists():
        import pandas as pd
        p = pd.read_parquet(plays, columns=["market_slug"])
        lines.append(f"Games with play-by-play: {p.market_slug.nunique()} ({len(p)} plays)")
    else:
        lines.append("Play-by-play: not downloaded yet.")
    aligned = DATA / "aligned" / "cfb.parquet"
    lines.append("Plays lined up with prices: " + ("yes" if aligned.exists() else "not yet"))
    return "\n".join(lines)


# ---- Running ------------------------------------------------------------------------------------------------------

def pack_commands() -> list[list[str]]:
    version = "lab-" + datetime.now().strftime("%Y%m%d-%H%M")
    cmds = [] if PACK.exists() else [[*NODE, "scripts/evidence-pack.ts", "export", str(PACK)]]
    for step in STEPS:
        path = RESULTS / step["result"] if step.get("result") else None
        if path and path.exists():
            r = json.loads(path.read_text(encoding="utf-8"))
            rows = r.get("evidence")
            if (isinstance(rows, list) and rows) or isinstance(rows, dict) or r.get("evidenceHold") or r.get("evidenceFade"):
                cmds.append([*NODE, "scripts/evidence-pack.ts", "add", str(PACK), str(path), version])
    cmds.append([*NODE, "scripts/evidence-pack.ts", "validate", str(PACK)])
    return cmds


def run_steps(ids: list[str]) -> None:
    for index, step_id in enumerate(ids):
        with lock:
            if job["status"] == "stopping":
                break
            job["id"], job["status"] = step_id, "running"
            job["queue"] = ids[index + 1:]
        step = BY_ID[step_id]
        log(f"\n=== {step['title']} ===")
        ok = True
        if step_id == "check":
            text = check_data()
            log(text)
            remember(step_id, True, text)
            continue
        for cmd in (pack_commands() if step_id == "pack" else step["cmds"]):
            log("$ " + " ".join(os.path.relpath(c, ROOT) if os.path.isabs(c) and c.startswith(str(ROOT)) else c for c in cmd))
            env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
            try:
                proc = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", env=env)
            except FileNotFoundError as error:
                log(f"Could not start {cmd[0]}: {error}. Is it installed and on PATH?")
                ok = False
                break
            with lock:
                job["proc"] = proc
            for line in proc.stdout:  # type: ignore[union-attr]
                log(line)
            code = proc.wait()
            with lock:
                job["proc"] = None
            if code != 0:
                log(f"Stopped: the command exited with code {code}.")
                ok = False
                break
        summary = summarize(step_id) if ok else "Failed. See the log below."
        remember(step_id, ok, summary)
        if not ok:
            break
    with lock:
        job["id"], job["status"], job["queue"] = None, "idle", []


def start(ids: list[str]) -> str | None:
    with lock:
        if job["status"] != "idle":
            return "Another step is running."
        job["status"], job["log"] = "running", deque(maxlen=4000)
    threading.Thread(target=run_steps, args=(ids,), daemon=True).start()
    return None


def stop() -> None:
    with lock:
        job["status"] = "stopping" if job["status"] != "idle" else "idle"
        proc = job["proc"]
    if proc and proc.poll() is None:
        proc.terminate()


# ---- HTTP -----------------------------------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # quiet console
        pass

    def send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/":
            return self.send(200, PAGE.replace("__TOKEN__", TOKEN).encode(), "text/html; charset=utf-8")
        if self.path == "/api/state":
            with lock:
                body = {"running": job["id"], "status": job["status"], "queue": job["queue"], "log": list(job["log"])[-400:]}
            body["steps"] = [{k: s[k] for k in ("id", "title", "what", "time")} for s in STEPS]
            body["saved"], body["tests"] = saved(), TESTS
            return self.send(200, json.dumps(body).encode(), "application/json")
        self.send(404, b"not found", "text/plain")

    def do_POST(self):  # noqa: N802
        if self.headers.get("X-Lab-Token") != TOKEN or self.headers.get("Origin") not in (None, f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return self.send(403, b"forbidden", "text/plain")
        if self.path == "/api/stop":
            stop()
            return self.send(200, b"{}", "application/json")
        if self.path.startswith("/api/run/"):
            name = self.path.rsplit("/", 1)[-1]
            ids = TESTS if name == "all-tests" else [name] if name in BY_ID else None
            if not ids:
                return self.send(404, b"unknown step", "text/plain")
            error = start(ids)
            return self.send(409 if error else 200, json.dumps({"error": error}).encode(), "application/json")
        self.send(404, b"not found", "text/plain")


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dugout Lab</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b0f14;--panel:#141a22;--line:#232c38;--text:#e8edf3;--muted:#8b97a6;--accent:#c6f25e;--good:#7ee29b;--bad:#ff7a7a;--warn:#f2c14e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 80px}
h1{font-size:26px;margin:0 0 4px}h1 span{color:var(--accent)}.sub{color:var(--muted);margin:0 0 22px}
.bar{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:var(--accent);color:#0b0f14}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}button:disabled{opacity:.4;cursor:default}
.step{display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:start;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 10px}
.n{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;background:#1d2530;color:var(--muted)}
.step.ok .n{background:var(--good);color:#0b0f14}.step.fail .n{background:var(--bad);color:#0b0f14}.step.run .n{background:var(--warn);color:#0b0f14}
.t{font-weight:600}.w{color:var(--muted);font-size:14px}.meta{color:var(--muted);font-size:12px;margin-top:4px}
pre.sum{white-space:pre-wrap;margin:8px 0 0;font:13px/1.5 "JetBrains Mono",monospace;color:var(--text)}
.sum .pass{color:var(--good)}
details{margin-top:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px 16px}summary{cursor:pointer;font-weight:600}
#log{white-space:pre-wrap;font:12px/1.45 "JetBrains Mono",monospace;color:var(--muted);max-height:360px;overflow:auto;margin:10px 0 0}
.note{color:var(--muted);font-size:13px;margin-top:24px}
@media (max-width:560px){.step{grid-template-columns:30px 1fr}.step button{grid-column:2}}
</style></head><body><main>
<h1>Dugout <span>Lab</span></h1>
<p class="sub">College football tests, one button at a time. Runs on this PC only. Nothing is published unless you press Publish.</p>
<div class="bar"><button id="all">Run all tests (steps 5-10)</button><button class="ghost" id="stop" disabled>Stop</button></div>
<div id="steps"></div>
<details id="logbox"><summary>Log</summary><div id="log"></div></details>
<p class="note">Order: get the code, check data, refresh prices, download plays, then the tests. A rule only reaches the bot after "Build the evidence pack" and "Publish", and then only as a paper trade.</p>
</main><script>
const TOKEN="__TOKEN__";
const $=s=>document.querySelector(s);
async function post(path){const r=await fetch(path,{method:'POST',headers:{'X-Lab-Token':TOKEN}});if(!r.ok){const j=await r.json().catch(()=>({}));alert(j.error||'Could not start.');}refresh();}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
async function refresh(){
  const s=await (await fetch('/api/state')).json();
  const busy=s.status!=='idle';
  $('#all').disabled=busy;$('#stop').disabled=!busy;
  $('#steps').innerHTML=s.steps.map((st,i)=>{
    const done=s.saved[st.id],running=s.running===st.id,queued=s.queue.includes(st.id);
    const cls=running?'run':done?(done.ok?'ok':'fail'):'';
    const status=running?'Running…':queued?'Queued':done?`${done.ok?'Done':'Failed'} · ${done.at}`:`Not run · ${st.time}`;
    const sum=done&&done.summary?`<pre class="sum">${esc(done.summary).replace(/^(PASSED:.*)$/gm,'<span class="pass">$1</span>')}</pre>`:'';
    return `<div class="step ${cls}"><div class="n">${done&&done.ok&&!running?'✓':i+1}</div><div><div class="t">${esc(st.title)}</div><div class="w">${esc(st.what)}</div><div class="meta">${status}</div>${sum}</div>
      <button ${busy?'disabled':''} data-id="${st.id}" class="${done&&done.ok?'ghost':''}">${done?'Run again':'Run'}</button></div>`;
  }).join('');
  document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>post('/api/run/'+b.dataset.id));
  const log=$('#log'),atEnd=log.scrollTop+log.clientHeight>=log.scrollHeight-8;
  log.textContent=s.log.join('\n');if(atEnd)log.scrollTop=log.scrollHeight;
  if(busy)$('#logbox').open=true;
}
$('#all').onclick=()=>post('/api/run/all-tests');$('#stop').onclick=()=>post('/api/stop');
refresh();setInterval(refresh,1500);
</script></body></html>"""


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"Dugout Lab is running at {url} (close this window to stop it)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop()
        time.sleep(0.2)


if __name__ == "__main__":
    main()
