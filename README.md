# Wasatch BC Atlas

A 3D backcountry planning map for the Central Wasatch. Static site with no build step.

## Run locally

```bash
python3 -m http.server 8080 -d ~/wasatch-bc-atlas
```

Then open http://localhost:8080.

## Files

- `index.html`, `home.css`, `home.js`: home screen, Alta's 15-day snow fitted to one phone screen, then Backcountry and Resort
- `backcountry.html`, `backcountry.css`, `app.css`: the 3D map; phone bottom sheet with Tours / Plan / Map tabs
- `app.js`: map, layers, avalanche rose, route drawing, Cody Townsend-style route checks, tours and their guides, pins, GPX
- `risk.js`, `avalanche.js`: the Avalanche Risk sheet (Day / Week / Month) and its red-flag thresholds
- `sun.js`: sun position for real-sun hillshading
- `tools/terrain_wasatch.py`: AutoATES-method terrain class and runout reach tiles (`tiles/runout/`), the tours (`data/tours.geojson`, from `tools/tours.json`: computed lines, map slope/aspect at each named run, avalanche-death locations nearby) and NHD streams. Needs `tools/requirements.txt`
- `manifest.webmanifest`, `sw.js`, `icon-*.png`: add-to-home-screen app and offline shell
- `dem.js`: terrain maths shared by the page and workers (Terrarium decode, Horn slope/aspect)
- `tile-worker.js`: renders slope / aspect / rose-match tiles off the main thread
- `lib/`: MapLibre GL JS 5.24.0, unchanged from the npm package (BSD-3 licence alongside), served with the app so the map doesn't depend on a CDN
- `forecast.html`, `forecast.css`, `forecast.js`: the Alta snow forecast page (summary, day/night, hourly, models, observed, NWS discussion)
- `forecast-data.js`: fetches and blends the forecast data; shared by the forecast page and the map panel
- `snow.js`: snow maths (rain/snow split, Kuchera snow ratio, weighted blends)
- `tools/calibrate_alta.py`: measures each model's Alta corrections (water by lead day, storm direction, temperature); writes `data/alta_calibration.json`
- `scorecard.html`, `scorecard.js`: how accurate the forecast has been
- `worker/index.js`, `wrangler.jsonc`: Cloudflare Worker that serves the site and, each morning, saves the forecast, Atwater readings and Hidden Peak wind (KV), learns the wind correction, and serves `/api/scorecard`, `/api/corrections`, `/api/avalanche` (UAC Salt Lake danger and history from avalanche.org, plus saved Hidden Peak wind) and `/api/uphill` (Alta's uphill-travel status, read off alta.com/uphill-travel)
- `data/`: data snapshots, each with its source recorded inside the file

## Deploy

Live at https://wasatch-bc-atlas.mattsanford.workers.dev (Cloudflare Workers, static assets plus `worker/index.js`).

```bash
npx wrangler@4 deploy
```

`.assetsignore` keeps the worker, tools and git files off the public site. The nightly job runs at 12:30 UTC; `POST /api/run` with the `x-run-key` header (the `RUN_KEY` worker secret) runs it by hand.

## Data rule

No invented data. Every number comes from one of these sources:

| Data | Source |
|---|---|
| Elevation, slope, aspect, route stats | AWS Terrain Tiles (Terrarium; USGS 3DEP in the US), calculated in the browser |
| Basemaps | USGS The National Map |
| Avalanche paths | Utah SGID Avalanche Paths (1989 Wasatch Canyons Master Plan), State of Utah UPLAN copy, snapshot 2026-10-12 |
| Forecast zones | UGRC SGID, UAC Forecast Zones |
| Route ratings and stats | Utah Avalanche Center route pages (`data/uac_routes.json`) |
| Elevation bands | UAC Salt Lake advisories: <8,000′, 8,000–9,500′, >9,500′ |
| Alta forecast models | Open-Meteo forecast and ensemble APIs (NBM, ECMWF, GFS, GEM; ECMWF and GFS ensembles), fetched live |
| Alta correction factors | Open-Meteo Previous Runs API vs NRCS SNOTEL 1308 Atwater, winters 2024–25 and 2025–26 (`data/alta_calibration.json`) |
| Snow level, NWS snow, alerts, forecast discussion | NWS api.weather.gov, grid SLC 108,167 |
| Observed snow at Alta | NRCS SNOTEL 1308 Atwater, fetched live |
| Temperature and storm-direction corrections | Open-Meteo Previous Runs (temperature) and archived GFS 700 mb wind vs SNOTEL 1308 Atwater, winters 2024–25 and 2025–26 |
| Wind correction | Learned nightly from NWS station HDP (Hidden Peak) vs saved forecasts |
| Avalanche danger and history | Utah Avalanche Center via the avalanche.org public API (overall rating only; the rose and problems need a UAC API token) |
| Red-flag thresholds | avalanche.org "Loading / Loading Rate" (12" new snow or 1" water in 24 h); Avalanche Canada glossary, wind transport (25–40 km/h ≈ 15 mph+) |
| Terrain class (ATES) and runout reach | AutoATES v2.0 method and default thresholds (Toft et al. 2024, github.com/AutoATES/AutoATES-v2.0), simplified; USFS/NLCD Tree Canopy Cover 2025 |
| Tour endpoints | OpenStreetMap (© OpenStreetMap contributors, ODbL), USGS GNIS, the WBSkiing.com location list, Powder Project; ids in `tools/tours.json`. A few objectives are the highest ground within 250–450 m of a sourced point (labelled so). Lines are computed, not surveyed, except Suicide Chute (OpenStreetMap way 1382646254) |
| Tour names | Matt's photos: onX Backcountry screenshots, a Reddit comment, White Cloud Concierge's list; plus UAC route pages. Names only; onX lines were never traced |
| Tour guides | WBSkiing Guide (wbsguide.com) route pages: trailheads, skin tracks, vertical, distance, run difficulty/slope/aspect; Powder Project line stats; UAC route ratings; UAC avalanche reports read one by one (linked on each row). Paraphrased, each note linked to its page |
| Avalanche deaths near a tour | WBSkiing.com location list, entries of type AvalancheFatality (`data/avalanche_deaths_wbs.json`) |
| Access status | Alta uphill travel (alta.com, live); Mill Creek road (Salt Lake County 3/15/2026 update, Trails Utah) |
| Streams (terrain traps) | USGS National Hydrography Dataset, large-scale flowlines |
| Route-planning rules of thumb | Cody Townsend's route-planning talk: vertical ÷ hourly pace, overhead hazard time, creek-bed traps, low-angle terrain (~20–25°) with nothing above on high-danger days, map slope misses micro-features |
| Sun position | US Naval Observatory approximate solar coordinates |

## Checked and not used

- **PEAKS 2.0-style inversion correction** (2026-10-26). OpenSnow says models run too warm in valleys on calm, clear nights. At Atwater, after the month and hour temperature table, calm (≤5 mph), clear (≤25% cloud) nights show no consistent leftover bias: NBM was 5.5°F too warm in 2024–25 but 2°F too cold in 2025–26, GFS flips sign too, and ECMWF runs about 1–2°F too cold rather than warm. Alta's basin drains cold air rather than pooling it, so the correction isn't applied.
