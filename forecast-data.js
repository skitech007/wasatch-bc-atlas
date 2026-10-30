// Resort forecast data: fetches public model, ensemble, NWS and SNOTEL data and runs the snow maths
// in snow.js. Used by forecast.html (full page), resorts.html (the four resorts), index.html (home),
// backcountry.html (map panel) and the nightly scorecard worker (worker/index.js), which imports this
// file as a module and reads the globals it sets. Alta is the default; data/resorts.json has the others.

const POINT = { lat: 40.5884, lon: -111.6386, elevM: 3016, ft: 9895 };
// Where the temperature correction was measured, and where the scorecard checks temperatures
const ATWATER = { lat: 40.5912, lon: -111.6378, elevM: 2667, ft: 8750 };
const TZ = 'America/Denver';
const DAYS = 15;
const POWDER_IN = 6;

const MODELS = [
  { id: 'ncep_nbm_conus', name: 'NBM', long: 'NOAA National Blend of Models', color: 'var(--s1)' },
  { id: 'ecmwf_ifs025', name: 'ECMWF', long: 'European model (IFS 0.25°)', color: 'var(--s2)' },
  { id: 'gfs_global', name: 'GFS', long: 'NOAA Global Forecast System', color: 'var(--s3)' },
  { id: 'gem_seamless', name: 'GEM', long: 'Canadian model (2.5 km HRDPS for the first two days)', color: 'var(--s4)' },
];
// Each ensemble is corrected with the factor measured for its parent model. The GFS ensemble
// stays on one grid throughout, so its correction is held at the 4-day value, before the
// deterministic GFS's day-5 jump.
const ENSEMBLES = [
  { id: 'ecmwf_ifs025', suffix: 'ecmwf_ifs025_ensemble', parent: 'ecmwf_ifs025', maxLead: 7, name: 'ECMWF ensemble' },
  { id: 'gfs025', suffix: 'ncep_gefs025', parent: 'gfs_global', maxLead: 4, name: 'GFS ensemble' },
];
// Calibration is by lead day 1–7; later days reuse day 7
const leadOf = hoursAhead => Math.min(7, Math.max(1, Math.ceil((hoursAhead + 1) / 24)));
const factorAt = (calib, model, lead) => calib?.factors?.[model]?.[lead] ?? 1;
const weightsAt = (calib, lead) => Object.fromEntries(MODELS.map(m => [m.id, calib?.blend_weights?.[m.id]?.[lead] ?? 1]));
// Temperature correction (°F to add), measured at Atwater in 3-hour blocks of Mountain Standard
// Time (SNOTEL's clock). Two parts, averaged: a by-month table from the calibration, and a rolling
// 14-day bias per lead day that the nightly worker re-measures (absent locally: table only).
// The bias swings with the season and snow cover, so neither works well alone.
function isDst(date) {
  // US rules: second Sunday of March to first Sunday of November
  const y = +date.slice(0, 4);
  const nthSunday = (m, n) => { const d = new Date(Date.UTC(y, m, 1)); return 1 + (7 - d.getUTCDay()) % 7 + 7 * (n - 1); };
  const start = `${y}-03-${String(nthSunday(2, 2)).padStart(2, '0')}`, end = `${y}-11-${String(nthSunday(10, 1)).padStart(2, '0')}`;
  return date >= start && date < end;
}
function mstOf(key) {
  const h = (hourOf(key) - (isDst(dateOf(key)) ? 1 : 0) + 24) % 24;
  return { month: +key.slice(5, 7), block: Math.floor(h / 3) };
}
// `wet`: the model has 0.01"+ this hour. Sensors read closer to the models while it snows than on
// clear nights, so storm hours get the calibration's storm-hour adjustment on top.
function tempBiasAt(calib, roll, model, lead, key, wet = false) {
  const { month, block } = mstOf(key);
  const a = calib?.temperature_bias_month_3h?.[model]?.[month]?.[block] ?? 0;
  const b = roll?.[model]?.[lead]?.[block];
  return (b == null ? a : (a + b) / 2) + (wet ? calib?.temperature_wet_adjust?.[model]?.adjust ?? 0 : 0);
}
// Rolling bias: mean observed − forecast over the 14 days before `asOf`, per model, lead day and
// 3-hour MST block. `prev` is Open-Meteo Previous Runs hourly data at Atwater (timezone GMT);
// `obs` maps UTC hour keys to Atwater °F. Shared by the worker and tools/backfill_scorecard.mjs.
function rollingTempBias(prev, obs, asOf, days = 14) {
  const out = {}, from = asOf - days * 864e5;
  for (const m of MODELS) {
    out[m.id] = {};
    for (let lead = 1; lead <= 7; lead++) {
      const sum = Array(8).fill(0), n = Array(8).fill(0);
      const f = prev[`temperature_2m_previous_day${lead}_${m.id}`];
      prev.time.forEach((t, i) => {
        const ms = Date.parse(t + ':00Z');
        if (ms < from || ms >= asOf || f?.[i] == null || obs[t] == null) return;
        const blk = Math.floor(((new Date(ms).getUTCHours() - 7 + 24) % 24) / 3);
        sum[blk] += obs[t] - f[i]; n[blk]++;
      });
      out[m.id][lead] = sum.map((v, k) => n[k] >= 10 ? Math.round(v / n[k] * 100) / 100 : null);
    }
  }
  return out;
}
// Storm direction from the 700 mb wind; sectors match tools/calibrate.py
function flowSector(deg) {
  if (deg == null) return null;
  if (deg >= 285 || deg < 15) return 'NW';
  if (deg >= 225) return 'W';
  if (deg >= 135) return 'SW';
  return 'other';
}
const directionAt = (calib, model, sector) => (sector && calib?.direction_multipliers?.[model]?.[sector]) || 1;
const HOURLY_VARS = ['precipitation', 'temperature_2m', 'temperature_700hPa', 'apparent_temperature', 'relative_humidity_2m',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cloud_cover', 'freezing_level_height',
  'wind_direction_700hPa', 'wind_speed_700hPa'];


// ---------- time ----------
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function localKey(date) {
  const p = Object.fromEntries(keyFmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
const dateOf = k => k.slice(0, 10);
const hourOf = k => +k.slice(11, 13);
function addDays(d, n) {
  const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = d => DOW[new Date(d + 'T12:00:00Z').getUTCDay()];
const dom = d => +d.slice(8, 10);
const hourLabel = h => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
// OpenSnow's convention: a day's snow is the night before plus the day itself (6 pm to 6 pm)
const skiDay = k => hourOf(k) >= 18 ? addDays(dateOf(k), 1) : dateOf(k);
// 12-hour periods: day 6 am–6 pm, night 6 pm–6 am (named for the evening it starts)
function periodOf(k) {
  const h = hourOf(k), d = dateOf(k);
  if (h >= 6 && h < 18) return `${d}D`;
  return `${h >= 18 ? d : addDays(d, -1)}N`;
}

// NWS grid values cover ranges like "2026-10-20T22:00:00+00:00/PT2H"; spread them onto local hours.
function expandNws(series, { spread = false, scale = 1 } = {}) {
  const out = {};
  for (const { validTime, value } of series?.values || []) {
    if (value == null) continue;
    const [start, dur] = validTime.split('/');
    const m = dur.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?)?/);
    const hours = (+(m[1] || 0)) * 24 + (+(m[2] || 0)) || 1;
    const t0 = new Date(start).getTime();
    for (let i = 0; i < hours; i++) out[localKey(new Date(t0 + i * 3600e3))] = value * scale / (spread ? hours : 1);
  }
  return out;
}

// ---------- resorts ----------
let resortsP = null;
async function loadResorts() {
  resortsP ||= getJSON('data/resorts.json').then(c => c.resorts.map(r => ({
    ...r, point: { ...r.point, elevM: Math.round(r.point.ft * 0.3048) },
  }))).catch(e => { resortsP = null; throw e; });
  return resortsP;
}
const resortById = async id => { const rs = await loadResorts(); return rs.find(r => r.id === id) || rs[0]; };

// ---------- fetching ----------
const CACHE_MIN = 20;

async function getJSON(url) {
  // Time out so one slow source (USDA's SNOTEL server sometimes hangs) can't hold up the page
  const r = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

function omQuery(extra, point = POINT) {
  const q = new URLSearchParams({
    latitude: point.lat, longitude: point.lon, elevation: point.elevM, forecast_days: 16, timezone: TZ,
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', ...extra,
  });
  return q.toString();
}

async function fetchAll(force, resortId = 'alta') {
  const r = await resortById(resortId);
  const cacheKey = `${r.id}-forecast-v5`;
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey));
      if (c && Date.now() - c.at < CACHE_MIN * 60e3) return { ...c, resort: r };
    } catch { /* storage unavailable: fetch fresh */ }
  }
  const today = localKey(new Date()).slice(0, 10);
  const pt = r.point;
  const jobs = {
    calib: getJSON(`data/${r.id}_calibration.json`),
    // Temperature and wind corrections re-learned nightly by the scorecard worker, for Alta only
    // (absent when running locally)
    ...(r.id === 'alta' ? { corrections: getJSON('api/corrections') } : {}),
    det: getJSON('https://api.open-meteo.com/v1/forecast?' + omQuery({ hourly: HOURLY_VARS.join(','), models: MODELS.map(m => m.id).join(',') }, pt)),
    ens: getJSON('https://ensemble-api.open-meteo.com/v1/ensemble?' + omQuery({ hourly: 'precipitation,temperature_2m', models: ENSEMBLES.map(e => e.id).join(',') }, pt)),
    nws: getJSON(`https://api.weather.gov/gridpoints/${r.nws}`),
    alerts: getJSON(`https://api.weather.gov/alerts/active?point=${pt.lat},${pt.lon}`),
    afd: getJSON('https://api.weather.gov/products/types/AFD/locations/SLC').then(l => getJSON(l['@graph'][0]['@id'])),
    snotel: getJSON(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=${r.snotel.triplet}&elements=SNWD,WTEQ,PREC,TOBS&duration=DAILY`
      + `&beginDate=${addDays(today, -31)}&endDate=${today}`),
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(Object.values(jobs));
  const out = { at: Date.now(), data: {}, errors: {} };
  settled.forEach((s, i) => s.status === 'fulfilled' ? (out.data[names[i]] = s.value) : (out.errors[names[i]] = String(s.reason?.message || s.reason)));
  if (out.data.afd) out.data.afd = { productText: out.data.afd.productText, issuanceTime: out.data.afd.issuanceTime };
  if (out.data.nws) {
    const p = out.data.nws.properties;
    out.data.nws = { snowLevel: p.snowLevel, snowfallAmount: p.snowfallAmount, probabilityOfPrecipitation: p.probabilityOfPrecipitation, updateTime: p.updateTime };
  }
  // Only cache a complete fetch, so one source's hiccup isn't kept for the whole cache window
  // (the corrections endpoint doesn't exist on a local server, so it doesn't count)
  if (!Object.keys(out.errors).filter(k => k !== 'corrections').length) {
    try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch { /* quota or private mode */ }
  }
  return { ...out, resort: r };
}

// ---------- model maths ----------
function build({ data }) {
  const calib = data.calib;
  const det = data.det?.hourly;
  if (!det) throw new Error('Model forecast unavailable');
  const M2FT = data.det.hourly_units?.freezing_level_height === 'm' ? 3.28084 : 1;

  const nowKey = localKey(new Date());
  const today = dateOf(nowKey);
  const snowLevel = expandNws(data.nws?.snowLevel, { scale: 3.28084 });
  const nwsSnow = expandNws(data.nws?.snowfallAmount, { spread: true, scale: 1 / 25.4 });

  // Ensemble members: precipitation_member07_ncep_gefs025 etc.; the control run has no member tag.
  const members = [];
  const eh = data.ens?.hourly;
  if (eh) {
    for (const e of ENSEMBLES) {
      for (const k of Object.keys(eh)) {
        if (!k.startsWith('precipitation') || !k.endsWith(e.suffix)) continue;
        const tk = 'temperature_2m' + k.slice('precipitation'.length);
        if (eh[tk]) members.push({ ens: e, p: eh[k], t: eh[tk] });
      }
    }
  }
  const ensIndex = eh ? Object.fromEntries(eh.time.map((t, i) => [t, i])) : {};
  const nowIdx = Math.max(0, det.time.indexOf(nowKey));
  const windFactor = data.corrections?.wind?.active ? data.corrections.wind : null;
  const roll = data.corrections?.temperature?.bias || null;

  // Storm direction per calendar day: speed-weighted mean 700 mb wind across the models that
  // have it (NBM doesn't), the same daily measure the calibration used
  const flowAcc = {};
  det.time.forEach((t, i) => {
    for (const m of MODELS) {
      const wd = det[`wind_direction_700hPa_${m.id}`]?.[i], ws = det[`wind_speed_700hPa_${m.id}`]?.[i];
      if (wd == null || ws == null) continue;
      const a = flowAcc[dateOf(t)] ||= [0, 0];
      a[0] += ws * Math.sin(wd * Math.PI / 180); a[1] += ws * Math.cos(wd * Math.PI / 180);
    }
  });
  const flowDeg = Object.fromEntries(Object.entries(flowAcc).map(([d, [x, y]]) => [d, (Math.atan2(x, y) * 180 / Math.PI + 360) % 360]));

  const hours = det.time.map((t, i) => {
    const lead = leadOf(i - nowIdx);
    const weights = weightsAt(calib, lead);
    const sector = flowSector(flowDeg[dateOf(t)]);
    const per = {};
    for (const m of MODELS) {
      const g = v => det[`${v}_${m.id}`]?.[i] ?? null;
      const bias = tempBiasAt(calib, roll, m.id, lead, t, (det[`precipitation_${m.id}`]?.[i] ?? 0) >= 0.01);
      const x = {
        water: g('precipitation'), tempRaw: g('temperature_2m'), temp700F: g('temperature_700hPa'),
        app: g('apparent_temperature'), rh: g('relative_humidity_2m'), ws: g('wind_speed_10m'),
        wd: g('wind_direction_10m'), wg: g('wind_gusts_10m'), cc: g('cloud_cover'),
        fz: g('freezing_level_height') == null ? null : g('freezing_level_height') * M2FT,
      };
      x.tempF = x.tempRaw == null ? null : x.tempRaw + bias;
      if (x.app != null) x.app += bias;
      x.res = SNOW.hour(x, factorAt(calib, m.id, lead) * directionAt(calib, m.id, sector));
      per[m.id] = x;
    }
    const pick = f => Object.fromEntries(MODELS.map(m => [m.id, f(per[m.id])]));
    let snow = SNOW.blend(pick(x => x.res?.snow), weights);
    let water = SNOW.blend(pick(x => x.res?.water), weights);
    const wet = Object.fromEntries(MODELS.map(m => [m.id, per[m.id].res && per[m.id].res.water > 0.002 ? per[m.id].res.slr : null]));
    const frac = SNOW.blend(pick(x => x.res?.frac), weights);

    const ei = ensIndex[t];
    // Past day 7 the corrections aren't calibrated and single runs are mostly noise,
    // so snow and water come from the average of all ensemble runs instead
    // (hours where no run reports anything count as dry, never as a single-run fallback)
    if (i - nowIdx >= 7 * 24 && members.length) {
      let s = 0, w = 0;
      for (const mb of members) {
        if (ei == null || mb.p[ei] == null || mb.t[ei] == null) continue;
        const ml = Math.min(7, mb.ens.maxLead);
        const r = SNOW.hour({ water: mb.p[ei], tempF: mb.t[ei] + tempBiasAt(calib, roll, mb.ens.parent, 7, t, mb.p[ei] >= 0.01) },
          factorAt(calib, mb.ens.parent, ml) * directionAt(calib, mb.ens.parent, sector));
        s += r.snow; w += r.water;
      }
      snow = s / members.length; water = w / members.length;
    }

    // Ensemble chance of 0.01"+ in the 3 hours centred on this one
    let chance = null;
    if (ei != null && members.length) {
      let wetN = 0, n = 0;
      for (const mb of members) {
        const a = [mb.p[ei - 1], mb.p[ei], mb.p[ei + 1]].filter(v => v != null);
        if (!a.length) continue;
        n++; if (a.reduce((s, v) => s + v, 0) >= 0.01) wetN++;
      }
      chance = n ? 100 * wetN / n : null;
    }

    const wsRaw = SNOW.blend(pick(x => x.ws), weights), wgRaw = SNOW.blend(pick(x => x.wg), weights);
    return {
      t, lead, sector, per, snow, water, frac,
      slr: snow > 0.02 ? SNOW.blend(wet, weights) : null,
      tempF: SNOW.blend(pick(x => x.tempF), weights),
      tempRaw: SNOW.blend(pick(x => x.tempRaw), weights),
      app: SNOW.blend(pick(x => x.app), weights),
      rh: SNOW.blend(pick(x => x.rh), weights),
      wsRaw, wgRaw,
      ws: wsRaw == null ? null : wsRaw * (windFactor?.speed ?? 1),
      wd: SNOW.blendDirection(pick(x => x.wd), weights),
      wg: wgRaw == null ? null : wgRaw * (windFactor?.gust ?? 1),
      cc: SNOW.blend(pick(x => x.cc), weights),
      fz: SNOW.blend(pick(x => x.fz), weights),
      snowLevel: snowLevel[t] ?? null,
      nwsSnow: nwsSnow[t] ?? null,
      chance,
    };
  });

  // Share of the water that falls as snow, weighted by how much falls each hour (null when dry)
  const wetFrac = hs => {
    let w = 0, s = 0;
    for (const h of hs) if (h.water > 0 && h.frac != null) { w += h.water; s += h.water * h.frac; }
    return w >= 0.005 ? s / w : null;
  };

  // Per-member snow by ski day and by 12-hour period
  const memberDay = members.map(() => ({}));
  const memberPeriod = members.map(() => ({}));
  const memberPeriodWater = members.map(() => ({}));
  if (eh) {
    const ensNow = Math.max(0, eh.time.indexOf(nowKey));
    eh.time.forEach((t, i) => {
      const day = skiDay(t), per = periodOf(t), lead = leadOf(i - ensNow);
      members.forEach((mb, j) => {
        const w = mb.p[i], tf = mb.t[i];
        if (w == null || tf == null) return;
        const ml = Math.min(lead, mb.ens.maxLead);
        const s = SNOW.hour({ water: w, tempF: tf + tempBiasAt(calib, roll, mb.ens.parent, ml, t, w >= 0.01) },
          factorAt(calib, mb.ens.parent, ml) * directionAt(calib, mb.ens.parent, flowSector(flowDeg[dateOf(t)]))).snow;
        memberDay[j][day] = (memberDay[j][day] || 0) + s;
        memberPeriod[j][per] = (memberPeriod[j][per] || 0) + s;
        memberPeriodWater[j][per] = (memberPeriodWater[j][per] || 0) + w;
      });
    });
  }
  const spread = (byMember, key) => {
    const v = byMember.map(m => m[key]).filter(x => x != null).sort((a, b) => a - b);
    if (v.length < 10) return null;
    return {
      n: v.length, p10: SNOW.quantile(v, 0.1), p25: SNOW.quantile(v, 0.25), p50: SNOW.quantile(v, 0.5),
      p75: SNOW.quantile(v, 0.75), p90: SNOW.quantile(v, 0.9),
      pPowder: 100 * v.filter(x => x >= POWDER_IN).length / v.length,
      pInch: 100 * v.filter(x => x >= 1).length / v.length,
    };
  };

  // Days
  const days = [];
  const memberRun = members.map(() => 0);
  for (let d = 0; d < DAYS; d++) {
    const date = addDays(today, d);
    const hs = hours.filter(h => skiDay(h.t) === date);
    const sum = f => hs.reduce((s, h) => s + (f(h) || 0), 0);
    const covered = f => hs.some(h => f(h) != null);
    const byModel = Object.fromEntries(MODELS.map(m => [m.id,
      covered(h => h.per[m.id].res) ? sum(h => h.per[m.id].res?.snow) : null]));
    const rawWater = Object.fromEntries(MODELS.map(m => [m.id,
      covered(h => h.per[m.id].water) ? sum(h => h.per[m.id].water) : null]));
    // Running total per ensemble run, so the chart's band is a real cumulative range
    const runs = [];
    memberDay.forEach((md, j) => { if (md[date] != null) { memberRun[j] += md[date]; runs.push(memberRun[j]); } });
    runs.sort((a, c) => a - c);
    days.push({
      cum: runs.length >= 10 ? { p10: SNOW.quantile(runs, 0.1), p90: SNOW.quantile(runs, 0.9) } : null,
      date, snow: covered(h => h.snow) ? sum(h => h.snow) : null, water: covered(h => h.water) ? sum(h => h.water) : null,
      frac: wetFrac(hs),
      byModel, rawWater, sector: flowSector(flowDeg[date]),
      nws: covered(h => h.nwsSnow) && hs.filter(h => h.nwsSnow != null).length >= 18 ? sum(h => h.nwsSnow) : null,
      ens: spread(memberDay, date),
    });
  }

  // 12-hour periods, starting with the one we're in
  const periods = [];
  const firstPer = periodOf(nowKey);
  const perKeys = [...new Set(hours.map(h => periodOf(h.t)))];
  for (const pk of perKeys.slice(perKeys.indexOf(firstPer), perKeys.indexOf(firstPer) + DAYS * 2)) {
    const hs = hours.filter(h => periodOf(h.t) === pk);
    if (hs.length < 6) continue;
    const vals = f => hs.map(f).filter(v => v != null);
    const mean = f => { const v = vals(f); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const isDay = pk.endsWith('D');
    const temps = vals(h => h.tempF), apps = vals(h => h.app);
    const snow = vals(h => h.snow).reduce((a, b) => a + b, 0);
    const water = vals(h => h.water).reduce((a, b) => a + b, 0);
    let chance = null;
    if (members.length) {
      const w = memberPeriodWater.map(m => m[pk]).filter(v => v != null);
      if (w.length >= 10) chance = 100 * w.filter(v => v >= 0.01).length / w.length;
    }
    const slrHours = hs.filter(h => h.slr != null && h.snow > 0.02);
    periods.push({
      key: pk, date: pk.slice(0, 10), isDay,
      tempF: temps.length ? (isDay ? Math.max(...temps) : Math.min(...temps)) : null,
      app: apps.length ? (isDay ? Math.max(...apps) : Math.min(...apps)) : null,
      snow, water, frac: wetFrac(hs), chance,
      slr: slrHours.length ? slrHours.reduce((s, h) => s + h.slr * h.snow, 0) / slrHours.reduce((s, h) => s + h.snow, 0) : null,
      snowLevel: mean(h => h.snowLevel), fz: mean(h => h.fz),
      rh: mean(h => h.rh), ws: mean(h => h.ws), wd: SNOW.blendDirection(Object.fromEntries(hs.map((h, i) => [i, h.wd])), Object.fromEntries(hs.map((h, i) => [i, h.ws || 0.1]))),
      wg: vals(h => h.wg).length ? Math.max(...vals(h => h.wg)) : null, cc: mean(h => h.cc),
      ens: spread(memberPeriod, pk),
    });
  }

  return {
    hours: hours.filter(h => dateOf(h.t) >= today && dateOf(h.t) < addDays(today, DAYS)), allHours: hours,
    days, periods, nowKey, today, calib, windFactor, memberCount: members.length,
  };
}

// When imported as a module (the worker), these become globals as they already are in the browser
Object.assign(globalThis, {
  POINT, ATWATER, loadResorts, resortById, TZ, DAYS, POWDER_IN, MODELS, ENSEMBLES, HOURLY_VARS, leadOf, tempBiasAt, rollingTempBias, mstOf, flowSector,
  localKey, dateOf, hourOf, addDays, dow, dom, skiDay, getJSON, omQuery, fetchAll, build,
});
