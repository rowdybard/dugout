"""Shared helpers for the strategy-lab data lake (see docs/STRATEGY-LAB-HANDOFF.md).

Everything written here lands under research/data/ (gitignored, re-fetchable).
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MANIFEST = DATA / "manifest.json"
_manifest_lock = threading.Lock()


def load_env() -> None:
    """Load research/.env (KEY=VALUE lines) into os.environ without overriding real env vars."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


class RateLimiter:
    """Process-wide minimum interval between request starts, shared by worker threads."""

    def __init__(self, per_second: float):
        self.interval = 1.0 / per_second
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            delay = self.next_at - now
            self.next_at = max(now, self.next_at) + self.interval
        if delay > 0:
            time.sleep(delay)


_local = threading.local()


def session() -> requests.Session:
    if not hasattr(_local, "session"):
        s = requests.Session()
        s.headers["User-Agent"] = "dugout-strategy-lab/1 (research; github.com/rowdybard/dugout)"
        _local.session = s
    return _local.session


def get_json(url: str, params: dict | None = None, limiter: RateLimiter | None = None,
             headers: dict | None = None, attempts: int = 6, timeout: float = 60):
    """GET with retry on 429/5xx/network errors. Returns parsed JSON, or None on 404."""
    for attempt in range(attempts):
        if limiter:
            limiter.wait()
        try:
            r = session().get(url, params=params, headers=headers, timeout=timeout)
        except requests.RequestException:
            time.sleep(min(60, 2 ** attempt))
            continue
        if r.status_code == 404:
            return None
        if r.status_code == 429 or r.status_code >= 500:
            retry_after = r.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else min(60, 2 ** (attempt + 1)))
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"GET failed after {attempts} attempts: {url} {params}")


def iso_to_epoch(value: str | None) -> int | None:
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def update_manifest(section: str, payload: dict) -> None:
    """Merge one source's summary into research/data/manifest.json."""
    with _manifest_lock:
        DATA.mkdir(parents=True, exist_ok=True)
        current = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
        current[section] = {**payload, "updatedAt": utc_now()}
        MANIFEST.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
