#!/usr/bin/env python3
"""Build the LinkedIn infographic (1080x1350) from the atlas data, using the same models as the site.

Render:  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --window-size=1080,1350 --force-device-scale-factor=2 --screenshot=social/claude-adoption-linkedin.png \
  file://$PWD/social/infographic.html
"""
import html
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name):
    with open(os.path.join(ROOT, "docs", "data", name), encoding="utf-8") as fh:
        return json.load(fh)


aei, devs = load("aei.json"), load("developers.json")
period = aei["periods"][-1]
pid = period["id"]

# Claude Code model: share of GitHub developers, US weighted by JetBrains adoption (47% vs 39%),
# excluding places where Claude isn't available. Mirrors codeModel() in docs/app.js.
EXCLUDED = {"CN", "RU", "IR", "KP", "SY", "CU", "HK", "MO"}
weights = {k: v * (47 / 39 if k == "US" else 1) for k, v in devs["developers"].items() if k not in EXCLUDED}
total = sum(weights.values())
by_iso2 = {c["iso2"]: c for c in aei["countries"].values() if c.get("iso2")}
rows = [{"name": by_iso2[k]["name"], "chat": by_iso2[k]["p"][pid]["share"], "code": 100 * w / total}
        for k, w in weights.items() if k in by_iso2 and pid in by_iso2[k]["p"]]
rows.sort(key=lambda r: -r["code"])
# Largest Claude Code markets, plus France as the clearest chat-leaning contrast.
top = rows[:5] + [r for r in rows[5:] if r["name"] == "France"]

us = aei["countries"]["USA"]["p"][pid]["share"]
europe = aei["regions"]["Europe & Central Asia"]["p"][pid]["share"]
north_america = aei["regions"]["North America"]["p"][pid]["share"]
totals = aei["user_totals"][0]
scale = 600 / max(max(r["chat"], r["code"]) for r in top)

bars = "\n".join(f"""
      <div class="row">
        <span class="n">{html.escape(r['name'])}</span>
        <div class="bars">
          <div class="bar chat"><span style="width:{r['chat'] * scale:.0f}px"></span><b>{r['chat']:.1f}%</b></div>
          <div class="bar code"><span style="width:{r['code'] * scale:.0f}px"></span><b>{r['code']:.1f}%</b></div>
        </div>
      </div>""" for r in top)

page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Claude adoption: chat vs Claude Code</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: 1080px; height: 1350px; background: #0B1320; overflow: hidden; }}
body {{ font-family: "Archivo", "Arial Narrow", sans-serif; color: #EEF3F7; padding: 58px 64px 50px; display: flex; flex-direction: column; gap: 22px; -webkit-font-smoothing: antialiased; }}
.eyebrow {{ font-family: "IBM Plex Mono", monospace; font-size: 18px; letter-spacing: .08em; text-transform: uppercase; color: #93A3B3; }}
h1 {{ font-stretch: 72%; font-weight: 750; font-size: 80px; line-height: .95; letter-spacing: -.01em; margin-top: 12px; text-wrap: balance; }}
.dek {{ font-size: 25px; line-height: 1.35; color: #C3CFDA; max-width: 920px; }}
.stats {{ display: grid; grid-template-columns: repeat(3, 1fr); border-top: 2px solid #EEF3F7; }}
.stat {{ padding: 16px 22px 0 0; display: grid; gap: 6px; align-content: start; }}
.stat .v {{ font-stretch: 74%; font-weight: 750; font-size: 66px; line-height: 1; }}
.stat .l {{ font-size: 20px; line-height: 1.3; color: #C3CFDA; }}
.chart {{ background: #111C2C; border: 1px solid #22324A; border-radius: 10px; padding: 24px 28px 18px; display: grid; gap: 12px; }}
.chart-head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }}
.chart h2 {{ font-stretch: 85%; font-weight: 700; font-size: 31px; }}
.legend {{ display: flex; gap: 22px; font-size: 18px; color: #C3CFDA; }}
.legend i {{ display: inline-block; width: 14px; height: 14px; border-radius: 3px; margin-right: 8px; vertical-align: -1px; }}
.rows {{ display: grid; }}
.row {{ display: grid; grid-template-columns: 190px 1fr; align-items: center; gap: 16px; height: 46px; }}
.row .n {{ font-size: 22px; font-weight: 600; }}
.bars {{ display: grid; gap: 4px; }}
.bar {{ display: flex; align-items: center; gap: 10px; height: 15px; }}
.bar span {{ height: 15px; border-radius: 0 4px 4px 0; }}
.bar b {{ font-size: 17px; font-weight: 600; color: #DDE6EE; font-variant-numeric: tabular-nums; }}
.chat span {{ background: #3987e5; }}
.code span {{ background: #d95926; }}
.facts {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 26px; }}
.revenue {{ display: grid; gap: 10px; border-top: 1px solid #22324A; padding-top: 18px; }}
.rev-head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }}
.rev-t {{ font-stretch: 78%; font-weight: 700; font-size: 31px; }}
.rev-s {{ font-family: "IBM Plex Mono", monospace; font-size: 14px; letter-spacing: .06em; text-transform: uppercase; color: #93A3B3; white-space: nowrap; }}
.rev-bar {{ height: 28px; background: #2A3A52; border-radius: 0 5px 5px 0; overflow: hidden; }}
.rev-code {{ display: block; height: 100%; width: 17.9%; background: #d95926; }}
.rev-labels {{ display: flex; justify-content: space-between; gap: 16px; font-size: 18px; color: #C3CFDA; }}
.rev-labels b {{ color: #EEF3F7; font-weight: 650; }}
.sw {{ display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 8px; vertical-align: 0; }}
.fact .v {{ font-stretch: 74%; font-weight: 750; font-size: 46px; line-height: 1; }}
.fact .l {{ font-size: 18px; line-height: 1.3; color: #C3CFDA; margin-top: 6px; }}
.foot {{ margin-top: auto; display: flex; justify-content: space-between; gap: 28px; align-items: end; font-size: 14.5px; color: #93A3B3; line-height: 1.4; }}
.foot .credit {{ display: grid; gap: 4px; justify-items: end; text-align: right; }}
.foot .by {{ font-size: 17px; color: #EEF3F7; font-weight: 600; }}
.foot .url {{ font-family: "IBM Plex Mono", monospace; color: #79AEEE; font-size: 15px; white-space: nowrap; }}
.foot .profile {{ font-family: "IBM Plex Mono", monospace; color: #93A3B3; font-size: 13px; white-space: nowrap; }}
</style></head>
<body>
  <div>
    <span class="eyebrow">Claude Adoption Atlas · data to {period['label']}</span>
    <h1>Who uses Claude, and who codes with it</h1>
  </div>
  <p class="dek">Anthropic measures chat use by country. Claude Code by country isn't published, so it's modelled here from where the world's developers are.</p>

  <div class="stats">
    <div class="stat"><span class="v">{us:.0f}%</span><span class="l">of Claude chat conversations come from the US</span></div>
    <div class="stat"><span class="v">{europe:.0f}%</span><span class="l">from Europe &amp; Central Asia, now ahead of North America ({north_america:.0f}%)</span></div>
    <div class="stat"><span class="v">{totals['low'] / 1e6:.0f}–{totals['high'] / 1e6:.0f}M</span><span class="l">estimated monthly Claude users worldwide</span></div>
  </div>

  <div class="chart">
    <div class="chart-head">
      <h2>Share of global use: chat vs Claude Code</h2>
      <div class="legend"><span><i style="background:#3987e5"></i>Chat (measured)</span><span><i style="background:#d95926"></i>Claude Code (modelled)</span></div>
    </div>
    <div class="rows">{bars}
    </div>
  </div>

  <div class="revenue">
    <div class="rev-head"><span class="rev-t">Claude Code is at least 18% of Anthropic's run-rate revenue</span><span class="rev-s">Anthropic · Feb 2026</span></div>
    <div class="rev-bar"><span class="rev-code"></span></div>
    <div class="rev-labels"><span><i class="sw" style="background:#d95926"></i><b>Claude Code &gt;$2.5B</b></span><span><i class="sw" style="background:#2A3A52"></i>API, Claude apps &amp; enterprise &lt;$11.5B · total $14B</span></div>
  </div>

  <div class="facts">
    <div class="fact"><div class="v">39%</div><div class="l">of professional developers use Claude Code at work (JetBrains, 2026)</div></div>
    <div class="fact"><div class="v">54% vs 10%</div><div class="l">of sessions run on Opus: Claude Code vs chat (Anthropic, Jun 2026)</div></div>
  </div>

  <div class="foot">
    <p>Chat: Anthropic Economic Index, {period['label']}. Claude Code by country: modelled from GitHub developer counts ({devs['quarter']}), US-adjusted with JetBrains 2026. Revenue: Anthropic Series G announcement. User totals: third-party estimates (Sensor Tower; Reuters). Independent analysis, not affiliated with Anthropic.</p>
    <div class="credit">
      <span class="by">Built by Christofer Arce</span>
      <span class="profile">christoferarceg-source.github.io/christoferarce-site</span>
      <span class="url">christoferarceg-source.github.io/claude-adoption-atlas</span>
    </div>
  </div>
</body></html>
"""
with open(os.path.join(ROOT, "social", "infographic.html"), "w", encoding="utf-8") as fh:
    fh.write(page)
print("top rows:", [(r["name"], round(r["chat"], 1), round(r["code"], 1)) for r in top])
