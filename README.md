# Wasatch BC Atlas

A 3D backcountry planning map for the Central Wasatch. Static site with no build step.

## Run locally

```bash
python3 -m http.server 8080 -d ~/wasatch-bc-atlas
```

Then open http://localhost:8080.

## Files

- `index.html`, `app.css`: page and styles
- `app.js`: map, layers, avalanche rose, route drawing and stats, pins, GPX
- `dem.js`: terrain maths shared by the page and workers (Terrarium decode, Horn slope/aspect)
- `tile-worker.js`: renders slope / aspect / rose-match tiles off the main thread
- `forecast.html`, `forecast.css`, `forecast.js`: the Alta snow forecast page (summary, day/night, hourly, models, observed, NWS discussion)
- `forecast-data.js`: fetches and blends the forecast data; shared by the forecast page and the map panel
- `snow.js`: snow maths (rain/snow split, Kuchera snow ratio, weighted blends)
- `tools/calibrate_alta.py`: measures each model's Alta corrections (water by lead day, storm direction, temperature); writes `data/alta_calibration.json`
- `scorecard.html`, `scorecard.js`: how accurate the forecast has been
- `worker/index.js`, `wrangler.jsonc`: Cloudflare Worker that serves the site and, each morning, saves the forecast, Atwater readings and Hidden Peak wind (KV), learns the wind correction, and serves `/api/scorecard` and `/api/corrections`
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
