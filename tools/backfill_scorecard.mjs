// Reconstruct the morning forecasts the worker would have saved on past days, so the scorecard
// has history from before the worker existed. Runs the site's own forecast code (snow.js,
// forecast-data.js) with the clock set back to each morning, fed with what each model actually
// forecast then (Open-Meteo Previous Runs). Every snapshot is marked reconstructed.
//
// Differences from a live snapshot, all stated on the scorecard page:
//   - storm direction comes from the archived short-range GFS 700 mb wind (what happened), since
//     past forecasts of upper-air wind aren't archived
//   - no 700 mb temperature, so the snow ratio uses the 9,895 ft temperature alone
//   - no wind, so reconstructed days never feed the wind correction
//
// Run:  node tools/backfill_scorecard.mjs 2026-09-21 2026-10-21 > /path/to/bulk.json
//       npx wrangler@4 kv bulk put /path/to/bulk.json --binding SCORE --remote
// (Days that already have a real snapshot should be left out of the range.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [first, last] = process.argv.slice(2);
if (!first || !last) throw new Error('usage: node tools/backfill_scorecard.mjs <first made date> <last made date>');

// A clock the forecast code reads through `new Date()`; set per reconstructed morning
const RealDate = Date;
let fakeNow = RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fakeNow])); }
  static now() { return fakeNow; }
};

await import(pathToFileURL(path.join(root, 'snow.js')));
await import(pathToFileURL(path.join(root, 'forecast-data.js')));
const { MODELS, POINT, ATWATER, TZ, build, leadOf, dateOf, addDays } = globalThis;
const calib = JSON.parse(fs.readFileSync(path.join(root, 'data/alta_calibration.json'), 'utf8'));
const ids = MODELS.map(m => m.id);
const round = (v, d = 2) => v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'wasatch-bc-atlas' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
const end = addDays(last, 9);
const prev = (point, v, unit) => get('https://previous-runs-api.open-meteo.com/v1/forecast?' + new URLSearchParams({
  latitude: point.lat, longitude: point.lon, elevation: point.elevM, start_date: first, end_date: end, timezone: TZ,
  hourly: [1, 2, 3, 4, 5, 6, 7].map(n => `${v}_previous_day${n}`).join(','), models: ids.join(','), ...unit,
}));
const [precip, temp, tempAtw, flow, obsRaw] = await Promise.all([
  prev(POINT, 'precipitation', { precipitation_unit: 'inch' }),
  prev(POINT, 'temperature_2m', { temperature_unit: 'fahrenheit' }),
  prev(ATWATER, 'temperature_2m', { temperature_unit: 'fahrenheit' }),
  get('https://historical-forecast-api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: POINT.lat, longitude: POINT.lon, start_date: first, end_date: end, timezone: TZ,
    hourly: 'wind_direction_700hPa,wind_speed_700hPa', models: 'gfs_global',
  })),
  get('https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=1308:UT:SNTL'
    + `&elements=PREC,SNWD,TMAX,TMIN&duration=DAILY&beginDate=${addDays(first, -1)}&endDate=${last}`),
]);
const idx = Object.fromEntries(precip.hourly.time.map((t, i) => [t, i]));

// The hourly block a run made that morning would have given, the way the live page sees it
function detFor(made, src, vars) {
  const startI = idx[`${made}T00:00`], nowI = idx[`${made}T06:00`];
  const hourly = { time: precip.hourly.time.slice(startI, startI + 24 * 9) };
  for (const [name, s] of vars) for (const m of ids) {
    hourly[`${name}_${m}`] = hourly.time.map((t, j) => s.hourly[`${name}_previous_day${leadOf(startI + j - nowI)}_${m}`]?.[idx[t]] ?? null);
  }
  hourly.wind_direction_700hPa_gfs_global = hourly.time.map(t => flow.hourly.wind_direction_700hPa[idx[t]] ?? null);
  hourly.wind_speed_700hPa_gfs_global = hourly.time.map(t => flow.hourly.wind_speed_700hPa[idx[t]] ?? null);
  return { hourly, hourly_units: {} };
}

const out = [];
for (let made = first; made <= last; made = addDays(made, 1)) {
  fakeNow = new RealDate(`${made}T06:30:00-06:00`).getTime();  // 6:30 am MDT, when the worker runs
  const b = build({ data: { calib, det: detFor(made, null, [['precipitation', precip], ['temperature_2m', temp]]) } });
  const atw = build({ data: { calib, det: detFor(made, null, [['temperature_2m', tempAtw]]) } });
  // Same per-day summary the worker saves (calendar days, to match SNOTEL)
  const byDate = (hours, f) => {
    const o = {};
    for (const h of hours) { const v = f(h); if (v != null) (o[dateOf(h.t)] ||= []).push(v); }
    return o;
  };
  const sum = a => a.reduce((s, v) => s + v, 0);
  const water = byDate(b.allHours, h => h.water), snow = byDate(b.allHours, h => h.snow);
  const raw = Object.fromEntries(ids.map(m => [m, byDate(b.allHours, h => h.per[m].water)]));
  const tC = byDate(atw.allHours, h => h.tempF), tR = byDate(atw.allHours, h => h.tempRaw);
  const days = [];
  for (let lead = 1; lead <= 7; lead++) {
    const d = addDays(made, lead);
    if ((water[d] || []).length < 24) continue;
    days.push({
      date: d, lead, water: round(sum(water[d])), snow: round(sum(snow[d]), 1),
      raw: Object.fromEntries(ids.map(m => [m, (raw[m][d] || []).length >= 24 ? round(sum(raw[m][d])) : null])),
      hi: round(Math.max(...(tC[d] || [NaN])), 1), lo: round(Math.min(...(tC[d] || [NaN])), 1),
      hiRaw: round(Math.max(...(tR[d] || [NaN])), 1), loRaw: round(Math.min(...(tR[d] || [NaN])), 1),
    });
  }
  out.push({ key: `snap:${made}`, value: JSON.stringify({ made, reconstructed: true, at: new RealDate().toISOString(), days }) });
}

// Atwater readings for the same stretch, in the worker's format
const series = code => Object.fromEntries((obsRaw[0].data.find(e => e.stationElement.elementCode === code)?.values || [])
  .map(v => [v.date.slice(0, 10), v.value]));
const P = series('PREC'), D = series('SNWD'), HI = series('TMAX'), LO = series('TMIN');
const dates = Object.keys(P).sort();
for (let i = 1; i < dates.length; i++) {
  const day = dates[i], p0 = dates[i - 1];
  const w = P[day] != null && P[p0] != null ? P[day] - P[p0] : null;
  const g = D[day] != null && D[p0] != null ? D[day] - D[p0] : null;
  out.push({ key: `obs:${day}`, value: JSON.stringify({
    date: day, water: w != null && w >= 0 && w < 6 ? round(w) : null, depthGain: g == null ? null : Math.max(0, g),
    hi: HI[day] ?? null, lo: LO[day] ?? null,
  }) });
}
process.stdout.write(JSON.stringify(out));
console.error(`${out.filter(o => o.key.startsWith('snap:')).length} snapshots, ${out.filter(o => o.key.startsWith('obs:')).length} observed days`);
