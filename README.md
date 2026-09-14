# Claude Adoption Atlas

An interactive map of where Claude and Claude Code are adopted, by region, country and state/province, with an auto-generated insights tab.

Built by **[Christofer Arce](https://christoferarceg-source.github.io/christoferarce-site/)**.

**Live site:** https://christoferarceg-source.github.io/claude-adoption-atlas/

## What's inside

- **Map.** A world choropleth you can drill into: World → region → country → state/province. Colour by intensity (AUI), share of usage, change over time, use-case mix, coding share or automation. Every view is a shareable URL.
- **Insights.** Findings rewritten from the latest data on every refresh, plus charts of regional trends, the biggest movers, income vs intensity, the use-case curve and daily Claude Code installs.
- **Estimated users and adoption.** Ranges of monthly users and adoption (% of working-age people) per country and region. They're estimated by splitting third-party global user totals (`pipeline/reference/global_users.json`) by share of conversations. They're not account counts.
- **Claude chat vs Claude Code.** Chat is measured from the Economic Index. Claude Code's country split is modelled from GitHub Innovation Graph developer counts (refreshed by `pipeline/signals.py`), with a US adjustment from JetBrains' 2026 survey.
- **About the data.** Methodology, caveats and sources.

## How it stays fresh

`.github/workflows/refresh.yml` runs daily:

1. `pipeline/build.py` lists [Anthropic's Economic Index dataset](https://huggingface.co/datasets/Anthropic/EconomicIndex) and processes any release it hasn't seen. Each release is reduced once into `pipeline/cache/`, so normal runs download nothing large. If Anthropic changes the file schema, the job fails instead of publishing bad data.
2. `pipeline/signals.py` pulls daily npm downloads for Claude Code.
3. Changed files in `docs/data/` are committed, and GitHub Pages redeploys.

Country data is only as fresh as Anthropic's releases. They publish every few months, with monthly granularity.

## Limits

- **No city-level data.** The finest geography Anthropic publishes is ISO 3166-2 subdivisions.
- **No Claude Code or API usage by country.** Anthropic publishes API usage as a global total only.
- **Unsupported countries.** Claude isn't available in China, Russia, Iran, North Korea, Syria or Cuba.

## Run locally

```bash
python3 pipeline/build.py        # first run downloads ~450 MB, then uses the cache
python3 pipeline/signals.py
python3 -m http.server -d docs 8000
```

Map shapes in `docs/geo/` are built once from [Natural Earth](https://www.naturalearthdata.com) (public domain):

```bash
MAPSHAPER="npx mapshaper" python3 pipeline/geo/build_geo.py ne_50m_admin_0_countries.geojson ne_10m_admin_1_states_provinces.geojson
```

## Render the LinkedIn video and infographic

Both are generated from the same data and models as the site, so re-run them after a data refresh.

Requirements: Google Chrome (set `CHROME=/path/to/chrome` if it isn't in the default macOS location), Node 18+ and Python 3.

```bash
# one-time: install the frame grabber (puppeteer-core) and encoder (ffmpeg-static)
npm install --prefix social/video

# infographic -> social/claude-adoption-linkedin.png (2160x2700)
python3 social/build_infographic.py
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1080,1350 --force-device-scale-factor=2 --virtual-time-budget=10000 \
  --screenshot=social/claude-adoption-linkedin.png "file://$PWD/social/infographic.html"

# video -> social/claude-adoption-video.mp4 (1080x1350, 30 fps) + -poster.png, about 3 minutes
bash social/video/render.sh
```

`social/video/index.html` is a deterministic animation: `window.seek(t)` draws the frame at `t` seconds. `render.mjs` loads it in headless Chrome, captures every frame and pipes them into ffmpeg. To preview it in a browser, serve the repo root (`python3 -m http.server 8770`) and open `http://localhost:8770/social/video/index.html`.

## Credits

Built by [Christofer Arce](https://christoferarceg-source.github.io/christoferarce-site/). Data: Anthropic Economic Index (CC-BY). Borders: Natural Earth. Developers: GitHub Innovation Graph. Independent analysis, not affiliated with Anthropic.
