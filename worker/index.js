// Cloudflare Worker for the atlas: serves the static site, and every morning saves the Alta
// forecast and what actually happened so /scorecard can show how accurate it has been.
//
// KV keys (binding SCORE):
//   snap:<date>  forecast made that morning: per-day water/snow (corrected blend and raw models),
//                Atwater high/low (corrected and raw), and hourly raw wind for the next 8 days
//   obs:<date>   Atwater SNOTEL: water, depth gain, high, low
//   wind:<date>  Hidden Peak hourly wind and gust (mph), kept because NWS only holds about a week
//   corrections  wind factors learned from snap + wind, read by the forecast page

import '../snow.js';
import '../forecast-data.js';
import calib from '../data/alta_calibration.json';

const { MODELS, POINT, ATWATER, HOURLY_VARS, omQuery, getJSON, build, localKey, dateOf, addDays } = globalThis;
const LEADS = [1, 2, 3, 4, 5, 6, 7];
const WIND_STATION = 'HDP';     // Hidden Peak, 11,000 ft, the nearest ridgetop wind in the NWS feed
const WIND_MIN_DAYS = 14;       // matched days before the wind correction switches on
const KMH_TO_MPH = 0.621371;

const json = (body, maxAge = 0) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});
const round = (v, d = 2) => v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/scorecard') return json(await scorecard(env), 600);
    if (url.pathname === '/api/corrections') return json((await env.SCORE.get('corrections', 'json')) || {}, 1800);
    if (url.pathname === '/api/run' && request.method === 'POST') {
      if (!env.RUN_KEY || request.headers.get('x-run-key') !== env.RUN_KEY) return new Response('Forbidden', { status: 403 });
      return json(await nightly(env));
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(nightly(env));
  },
};

// ---------- nightly ----------
async function nightly(env) {
  const today = dateOf(localKey(new Date()));
  const results = await Promise.allSettled([snapshot(env, today), observed(env, today), windObs(env)]);
  const report = Object.fromEntries(['snapshot', 'observed', 'wind'].map((k, i) =>
    [k, results[i].status === 'fulfilled' ? results[i].value : `failed: ${results[i].reason?.message || results[i].reason}`]));
  report.corrections = await learnWind(env).catch(e => `failed: ${e.message}`);
  return report;
}

// Today's forecast, kept small: days 1–8 only use the deterministic models, so no ensembles
async function snapshot(env, today) {
  const corrections = (await env.SCORE.get('corrections', 'json')) || {};
  const models = MODELS.map(m => m.id).join(',');
  const [det, detAtw] = await Promise.all([
    getJSON('https://api.open-meteo.com/v1/forecast?' + omQuery({ hourly: HOURLY_VARS.join(','), models, forecast_days: 9 })),
    getJSON('https://api.open-meteo.com/v1/forecast?' + omQuery({ hourly: 'temperature_2m', models, forecast_days: 9 }, ATWATER)),
  ]);
  const b = build({ data: { calib, det, corrections } });
  const atw = build({ data: { calib, det: detAtw } });

  const byDate = (hours, f) => {
    const out = {};
    for (const h of hours) {
      const v = f(h);
      if (v != null) (out[dateOf(h.t)] ||= []).push(v);
    }
    return out;
  };
  // Calendar days (midnight to midnight) to match SNOTEL's daily readings
  const water = byDate(b.allHours, h => h.water);
  const raw = Object.fromEntries(MODELS.map(m => [m.id, byDate(b.allHours, h => h.per[m.id].water)]));
  const snow = byDate(b.allHours, h => h.snow);
  const tC = byDate(atw.allHours, h => h.tempF), tR = byDate(atw.allHours, h => h.tempRaw);
  const days = [];
  for (const lead of LEADS) {
    const d = addDays(today, lead);
    if ((water[d] || []).length < 24) continue;
    days.push({
      date: d, lead,
      water: round(water[d].reduce((s, v) => s + v, 0)),
      snow: round(snow[d].reduce((s, v) => s + v, 0), 1),
      raw: Object.fromEntries(MODELS.map(m => [m.id, (raw[m.id][d] || []).length >= 24 ? round(raw[m.id][d].reduce((s, v) => s + v, 0)) : null])),
      hi: round(Math.max(...(tC[d] || [NaN])), 1), lo: round(Math.min(...(tC[d] || [NaN])), 1),
      hiRaw: round(Math.max(...(tR[d] || [NaN])), 1), loRaw: round(Math.min(...(tR[d] || [NaN])), 1),
    });
  }
  const windHours = b.allHours.filter(h => h.wsRaw != null && dateOf(h.t) > today && dateOf(h.t) <= addDays(today, 8));
  const snap = {
    made: today, at: new Date().toISOString(), days,
    wind: { t0: windHours[0]?.t, ws: windHours.map(h => round(h.wsRaw, 1)), wg: windHours.map(h => round(h.wgRaw, 1)) },
  };
  await env.SCORE.put(`snap:${today}`, JSON.stringify(snap));
  return { days: days.length, windHours: windHours.length };
}

// Atwater SNOTEL daily readings for the last 10 days (rewritten each night in case of late fixes)
async function observed(env, today) {
  const d = await getJSON('https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=1308:UT:SNTL'
    + `&elements=PREC,SNWD,TMAX,TMIN&duration=DAILY&beginDate=${addDays(today, -11)}&endDate=${addDays(today, -1)}`);
  const series = code => Object.fromEntries((d[0].data.find(e => e.stationElement.elementCode === code)?.values || [])
    .map(v => [v.date.slice(0, 10), v.value]));
  const P = series('PREC'), D = series('SNWD'), HI = series('TMAX'), LO = series('TMIN');
  const dates = Object.keys(P).sort();
  let n = 0;
  for (let i = 1; i < dates.length; i++) {
    const day = dates[i], prev = dates[i - 1];
    const w = P[day] != null && P[prev] != null ? P[day] - P[prev] : null;
    const g = D[day] != null && D[prev] != null ? D[day] - D[prev] : null;
    await env.SCORE.put(`obs:${day}`, JSON.stringify({
      date: day, water: w != null && w >= 0 && w < 6 ? round(w) : null, depthGain: g == null ? null : Math.max(0, g),
      hi: HI[day] ?? null, lo: LO[day] ?? null,
    }));
    n++;
  }
  return { days: n };
}

// Hidden Peak hourly wind, merged into per-day keys
async function windObs(env) {
  const d = await getJSON(`https://api.weather.gov/stations/${WIND_STATION}/observations?limit=200`);
  const hours = {};
  for (const f of d.features || []) {
    const p = f.properties, ws = p.windSpeed?.value, wg = p.windGust?.value;
    if (ws == null) continue;
    const k = localKey(new Date(p.timestamp));
    (hours[k] ||= { ws: [], wg: [] }).ws.push(ws * KMH_TO_MPH);
    if (wg != null) hours[k].wg.push(wg * KMH_TO_MPH);
  }
  const byDay = {};
  for (const [k, v] of Object.entries(hours)) {
    (byDay[dateOf(k)] ||= {})[k] = [round(mean(v.ws), 1), v.wg.length ? round(Math.max(...v.wg), 1) : null];
  }
  for (const [day, hrs] of Object.entries(byDay)) {
    const old = (await env.SCORE.get(`wind:${day}`, 'json')) || {};
    await env.SCORE.put(`wind:${day}`, JSON.stringify({ ...old, ...hrs }));
  }
  return { hours: Object.keys(hours).length };
}

// Compare stored raw forecast wind (1–7 days ahead) with what Hidden Peak measured
async function learnWind(env) {
  const snaps = await getAll(env, 'snap:');
  const winds = await getAll(env, 'wind:');
  const obs = Object.assign({}, ...Object.values(winds));
  let so = 0, sf = 0, go = 0, gf = 0, hours = 0;
  const days = new Set();
  for (const s of Object.values(snaps)) {
    const t0 = s.wind?.t0;
    if (!t0) continue;
    const start = Date.parse(t0 + ':00Z');
    s.wind.ws.forEach((fc, i) => {
      const k = new Date(start + i * 3600e3).toISOString().slice(0, 13) + ':00';  // same local-key format
      const o = obs[k];
      if (!o || o[0] == null || fc == null) return;
      so += o[0]; sf += fc; hours++; days.add(dateOf(k));
      const fg = s.wind.wg[i];
      if (o[1] != null && fg != null) { go += o[1]; gf += fg; }
    });
  }
  const c = {
    wind: {
      station: 'Hidden Peak (HDP), 11,000 ft', days: days.size, hours,
      active: days.size >= WIND_MIN_DAYS && sf > 0,
      speed: sf ? round(so / sf, 3) : null, gust: gf ? round(go / gf, 3) : null,
      needDays: WIND_MIN_DAYS, updated: new Date().toISOString(),
    },
  };
  await env.SCORE.put('corrections', JSON.stringify(c));
  return c.wind;
}

async function getAll(env, prefix) {
  const out = {};
  let cursor;
  do {
    const page = await env.SCORE.list({ prefix, cursor });
    const vals = await Promise.all(page.keys.map(k => env.SCORE.get(k.name, 'json')));
    page.keys.forEach((k, i) => { out[k.name.slice(prefix.length)] = vals[i]; });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

// ---------- scorecard ----------
async function scorecard(env) {
  const [snaps, obs, corr] = await Promise.all([getAll(env, 'snap:'), getAll(env, 'obs:'), env.SCORE.get('corrections', 'json')]);
  // forecasts[date][lead] = that day's forecast made `lead` days earlier
  const forecasts = {};
  for (const s of Object.values(snaps)) for (const d of s.days) (forecasts[d.date] ||= {})[d.lead] = d;

  const leads = LEADS.map(lead => {
    const pairs = Object.values(obs).filter(o => o.water != null && forecasts[o.date]?.[lead]).map(o => [o, forecasts[o.date][lead]]);
    const err = f => pairs.map(([o, fc]) => f(o, fc)).filter(v => v != null && !Number.isNaN(v));
    const mae = f => round(mean(err((o, fc) => { const v = f(o, fc); return v == null ? null : Math.abs(v); })));
    const wet = pairs.filter(([o, fc]) => o.water >= 0.1 || fc.water >= 0.1);
    return {
      lead, days: pairs.length, wetDays: wet.length,
      water: {
        blend: mae((o, fc) => fc.water - o.water),
        bias: round(mean(err((o, fc) => fc.water - o.water))),
        raw: Object.fromEntries(MODELS.map(m => [m.id, mae((o, fc) => fc.raw[m.id] == null ? null : fc.raw[m.id] - o.water)])),
      },
      temp: {
        hi: mae((o, fc) => o.hi == null ? null : fc.hi - o.hi), hiRaw: mae((o, fc) => o.hi == null ? null : fc.hiRaw - o.hi),
        lo: mae((o, fc) => o.lo == null ? null : fc.lo - o.lo), loRaw: mae((o, fc) => o.lo == null ? null : fc.loRaw - o.lo),
      },
    };
  });
  const recent = Object.values(obs).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 21).map(o => ({
    ...o, f1: pick(forecasts[o.date]?.[1]), f3: pick(forecasts[o.date]?.[3]), f5: pick(forecasts[o.date]?.[5]),
  }));
  return {
    since: Object.keys(snaps).sort()[0] || null, snapshots: Object.keys(snaps).length,
    models: MODELS.map(m => ({ id: m.id, name: m.name })), leads, recent, wind: corr?.wind || null,
    point: POINT,
  };
}
const pick = d => d ? { water: d.water, snow: d.snow, hi: d.hi, lo: d.lo } : null;
