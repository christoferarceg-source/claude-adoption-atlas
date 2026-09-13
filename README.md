# Claude Adoption Atlas

An interactive map of where Claude and Claude Code are adopted, by region, country and state/province, with an auto-generated insights tab.

**Live site:** https://christoferarceg-source.github.io/claude-adoption-atlas/

## What's inside

- **Map.** A world choropleth you can drill into: World → region → country → state/province. Colour by intensity (AUI), share of usage, change over time, use-case mix, coding share or automation. Every view is a shareable URL.
- **Insights.** Findings rewritten from the latest data on every refresh, plus charts of regional trends, the biggest movers, income vs intensity, the use-case curve and daily Claude Code installs.
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

## Credits

Data: Anthropic Economic Index (CC-BY). Borders: Natural Earth. Independent analysis, not affiliated with Anthropic.
