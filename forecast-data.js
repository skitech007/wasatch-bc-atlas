// Alta forecast data: fetches public model, ensemble, NWS and SNOTEL data in the browser and runs
// the snow maths in snow.js. Used by forecast.html (full page) and index.html (map panel).

const POINT = { lat: 40.5884, lon: -111.6386, elevM: 3016, ft: 9895 };
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
const HOURLY_VARS = ['precipitation', 'temperature_2m', 'temperature_700hPa', 'apparent_temperature', 'relative_humidity_2m',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'cloud_cover', 'freezing_level_height'];


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

// ---------- fetching ----------
const CACHE_KEY = 'alta-forecast-v3';
const CACHE_MIN = 20;

async function getJSON(url) {
  // Time out so one slow source (USDA's SNOTEL server sometimes hangs) can't hold up the page
  const r = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

function omQuery(extra) {
  const q = new URLSearchParams({
    latitude: POINT.lat, longitude: POINT.lon, elevation: POINT.elevM, forecast_days: 16, timezone: TZ,
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', ...extra,
  });
  return q.toString();
}

async function fetchAll(force) {
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && Date.now() - c.at < CACHE_MIN * 60e3) return c;
    } catch { /* storage unavailable: fetch fresh */ }
  }
  const today = localKey(new Date()).slice(0, 10);
  const jobs = {
    calib: getJSON('data/alta_calibration.json'),
    det: getJSON('https://api.open-meteo.com/v1/forecast?' + omQuery({ hourly: HOURLY_VARS.join(','), models: MODELS.map(m => m.id).join(',') })),
    ens: getJSON('https://ensemble-api.open-meteo.com/v1/ensemble?' + omQuery({ hourly: 'precipitation,temperature_2m', models: ENSEMBLES.map(e => e.id).join(',') })),
    nws: getJSON('https://api.weather.gov/gridpoints/SLC/108,167'),
    alerts: getJSON(`https://api.weather.gov/alerts/active?point=${POINT.lat},${POINT.lon}`),
    afd: getJSON('https://api.weather.gov/products/types/AFD/locations/SLC').then(l => getJSON(l['@graph'][0]['@id'])),
    snotel: getJSON('https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=1308:UT:SNTL&elements=SNWD,WTEQ,PREC,TOBS&duration=DAILY'
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
  if (!Object.keys(out.errors).length) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch { /* quota or private mode */ }
  }
  return out;
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

  const hours = det.time.map((t, i) => {
    const lead = leadOf(i - nowIdx);
    const weights = weightsAt(calib, lead);
    const per = {};
    for (const m of MODELS) {
      const g = v => det[`${v}_${m.id}`]?.[i] ?? null;
      const x = {
        water: g('precipitation'), tempF: g('temperature_2m'), temp700F: g('temperature_700hPa'),
        app: g('apparent_temperature'), rh: g('relative_humidity_2m'), ws: g('wind_speed_10m'),
        wd: g('wind_direction_10m'), wg: g('wind_gusts_10m'), cc: g('cloud_cover'),
        fz: g('freezing_level_height') == null ? null : g('freezing_level_height') * M2FT,
      };
      x.res = SNOW.hour(x, factorAt(calib, m.id, lead));
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
        const r = SNOW.hour({ water: mb.p[ei], tempF: mb.t[ei] }, factorAt(calib, mb.ens.parent, Math.min(7, mb.ens.maxLead)));
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

    return {
      t, lead, per, snow, water, frac,
      slr: snow > 0.02 ? SNOW.blend(wet, weights) : null,
      tempF: SNOW.blend(pick(x => x.tempF), weights),
      app: SNOW.blend(pick(x => x.app), weights),
      rh: SNOW.blend(pick(x => x.rh), weights),
      ws: SNOW.blend(pick(x => x.ws), weights),
      wd: SNOW.blendDirection(pick(x => x.wd), weights),
      wg: SNOW.blend(pick(x => x.wg), weights),
      cc: SNOW.blend(pick(x => x.cc), weights),
      fz: SNOW.blend(pick(x => x.fz), weights),
      snowLevel: snowLevel[t] ?? null,
      nwsSnow: nwsSnow[t] ?? null,
      chance,
    };
  });

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
        const s = SNOW.hour({ water: w, tempF: tf }, factorAt(calib, mb.ens.parent, Math.min(lead, mb.ens.maxLead))).snow;
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
      date, snow: covered(h => h.snow) ? sum(h => h.snow) : null, byModel, rawWater,
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
      snow, water, frac: mean(h => h.frac), chance,
      slr: slrHours.length ? slrHours.reduce((s, h) => s + h.slr * h.snow, 0) / slrHours.reduce((s, h) => s + h.snow, 0) : null,
      snowLevel: mean(h => h.snowLevel), fz: mean(h => h.fz),
      rh: mean(h => h.rh), ws: mean(h => h.ws), wd: SNOW.blendDirection(Object.fromEntries(hs.map((h, i) => [i, h.wd])), Object.fromEntries(hs.map((h, i) => [i, h.ws || 0.1]))),
      wg: vals(h => h.wg).length ? Math.max(...vals(h => h.wg)) : null, cc: mean(h => h.cc),
      ens: spread(memberPeriod, pk),
    });
  }

  return { hours: hours.filter(h => dateOf(h.t) >= today && dateOf(h.t) < addDays(today, DAYS)), days, periods, nowKey, today, calib, memberCount: members.length };
}
