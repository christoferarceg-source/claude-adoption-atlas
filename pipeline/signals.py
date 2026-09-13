#!/usr/bin/env python3
"""Fetch daily npm downloads for Claude Code packages (a global, near-real-time signal)."""
import json
import os
import statistics
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "signals.json")
PACKAGES = {
    "@anthropic-ai/claude-code": "Claude Code CLI",
    "@anthropic-ai/claude-agent-sdk": "Claude Agent SDK",
}
START = date(2025, 2, 24)  # Claude Code research preview launch
CHUNK_DAYS = 500  # npm allows at most 18 months per range request


def fetch_range(pkg, start, end):
    url = f"https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}"
    req = urllib.request.Request(url, headers={"User-Agent": "claude-adoption-atlas"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp).get("downloads", [])
    except urllib.error.HTTPError as err:
        if err.code in (400, 404):
            return []
        raise


def series(pkg, end):
    days, cursor = [], START
    while cursor <= end:
        stop = min(cursor + timedelta(days=CHUNK_DAYS - 1), end)
        days.extend(fetch_range(pkg, cursor, stop))
        cursor = stop + timedelta(days=1)
    values = [d["downloads"] for d in days]
    while values and values[0] == 0:  # before the package existed
        values.pop(0)
        days.pop(0)
    if not values:
        return None
    # npm occasionally reports 0 for days it failed to count; mark those as gaps.
    cleaned = []
    for i, v in enumerate(values):
        window = [x for x in values[max(0, i - 7): i + 8] if x]
        cleaned.append(None if v == 0 and window and statistics.median(window) > 1000 else v)
    return {"label": PACKAGES[pkg], "start": days[0]["day"], "downloads": cleaned}


def main():
    end = datetime.now(timezone.utc).date() - timedelta(days=1)  # today's count is partial
    out = {"checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "npm": {}}
    for pkg in PACKAGES:
        s = series(pkg, end)
        if s:
            out["npm"][pkg] = s
    if "@anthropic-ai/claude-code" not in out["npm"]:
        raise SystemExit("npm returned no data for Claude Code; keeping the previous signals file.")
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print({k: len(v["downloads"]) for k, v in out["npm"].items()})


if __name__ == "__main__":
    main()
