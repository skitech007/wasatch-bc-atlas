# Wasatch BC Atlas

A 3D backcountry planning map for the Central Wasatch. Static site with no build step.

## Run locally

```bash
python3 -m http.server 8080 -d ~/wasatch-bc-atlas
```

Then open http://localhost:8080.

## Files

- `index.html`, `home.css`, `home.js`: home screen, Alta's 15-day snow fitted to one phone screen, then Backcountry and Resorts
- `resorts.html`, `resorts.css`, `resorts.js`: the four Cottonwood resorts as cards (last 24 h, 15-day bars, next storm, opening day); starred ones sort first, each opens its forecast
- `snowbars.js`: the daily snow bars shared by home, resorts and forecast pages, coloured by what falls (snow, mix, rain, 6"+ day)
- `backcountry.html`, `backcountry.css`, `app.css`: the 3D map; phone bottom sheet with Tours / Plan / Map tabs
- `app.js`: map, layers, avalanche rose, route drawing, Cody Townsend-style route checks, tours and their guides, pins, GPX
- `risk.js`, `avalanche.js`: the Avalanche Risk sheet (Day / Week / Month) and its red-flag thresholds
- `sun.js`: sun position for real-sun hillshading
- `tools/terrain_wasatch.py`: AutoATES-method terrain class and runout reach tiles (`tiles/runout/`), the tours (`data/tours.geojson`, from `tools/tours.json`: computed lines, map slope/aspect at each named run, avalanche-death locations nearby) and NHD streams. Needs `tools/requirements.txt`
- `manifest.webmanifest`, `sw.js`, `icon-*.png`: add-to-home-screen app and offline shell
- `dem.js`: terrain maths shared by the page and workers (Terrarium decode, Horn slope/aspect)
- `tile-worker.js`: renders slope / aspect / rose-match tiles off the main thread
- `lib/`: MapLibre GL JS 5.24.0, unchanged from the npm package (BSD-3 licence alongside), served with the app so the map doesn't depend on a CDN
- `forecast.html`, `forecast.css`, `forecast.js`: one resort's snow forecast, `forecast.html?r=alta|snowbird|brighton|solitude` (summary, live cams, day/night, hourly, models, observed, NWS discussion)
- `forecast-data.js`: fetches and blends the forecast data for a resort; shared by the forecast, resorts and home pages and the map panel
- `data/resorts.json`: each resort's forecast point, SNOTEL, NWS grid, base/peak, opening day and cams, with sources
- `snow.js`: snow maths (rain/snow split, Kuchera snow ratio, weighted blends)
- `tools/calibrate.py <resort>`: measures each model's corrections at that resort's SNOTEL (water by lead day, storm direction, temperature by month and in storm hours); writes `data/<resort>_calibration.json`
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
| Resort forecast models | Open-Meteo forecast and ensemble APIs (NBM, ECMWF, GFS, GEM; ECMWF and GFS ensembles), fetched live |
| Correction factors | Open-Meteo Previous Runs API vs each resort's SNOTEL, winters 2024–25 and 2025–26 (`data/<resort>_calibration.json`): 1308 Atwater (Alta), 766 Snowbird, 366 Brighton (Brighton and Solitude, which has none of its own) |
| Resort forecast points | Alta: the original point (40.5884, −111.6386, 9,895 ft). Others: on the OpenStreetMap ski-area outline at the height halfway between base and peak, from AWS Terrain Tiles |
| Base and peak heights, opening days | Ski Utah resort pages and its 2026–27 opening-dates list (Oct 1, 2026) |
| Live cams | Brighton's and Solitude's own YouTube live streams (played in YouTube's player); Alta's and Snowbird's cams are pictures on their own sites, so the app links to those pages |
| Snow level, NWS snow, alerts, forecast discussion | NWS api.weather.gov, each resort's grid cell (Alta SLC 108,167; Snowbird 107,166; Brighton 110,166; Solitude 109,167) |
| Observed snow | Each resort's SNOTEL (above), fetched live |
| Temperature and storm-direction corrections | Open-Meteo Previous Runs (temperature, and precipitation to find storm hours) and archived GFS 700 mb wind vs each resort's SNOTEL, winters 2024–25 and 2025–26 |
| Wind correction (Alta only) | Learned nightly from NWS station HDP (Hidden Peak) vs saved Alta forecasts |
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

## Run your own copy

The live site deploys only from the maintainer's machine; no Cloudflare credentials live in this repo or on GitHub. To run the Worker yourself, on your own Cloudflare account:

```bash
npx wrangler@4 kv namespace create SCORE      # put the id it prints into wrangler.jsonc
npx wrangler@4 secret put RUN_KEY             # any long random string; guards POST /api/run
npx wrangler@4 deploy
```

The pages work without the Worker too (see Run locally); the scorecard and saved wind just stay empty.

## Contributing

Fork the repo and open a pull request against `main`. Keep to the data rule above: any new number needs a source in the table. Never commit keys, tokens or `.dev.vars`.

## License

The code is MIT licensed (`LICENSE`). MapLibre GL JS in `lib/` keeps its own BSD-3 licence. The files in `data/` and `tiles/` are derived from the sources in the table above and stay under those sources' terms, including OpenStreetMap data (© OpenStreetMap contributors, ODbL). Tour notes paraphrase and link the pages they came from. Resort logos are each resort's trademark, so they aren't in the repo: `logos/` is git-ignored, and without it the app shows each resort's initials instead.

This is a planning aid, not an avalanche forecast. Check the Utah Avalanche Center and make your own decisions in the field.
