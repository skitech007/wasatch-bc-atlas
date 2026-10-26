// Avalanche Risk sheet on the backcountry map: Day / Week / Month.
// Danger: UAC Salt Lake zone via /api/avalanche (avalanche.org public API). Weather red flags:
// Atwater SNOTEL (observed snow and water), Hidden Peak (observed wind, saved nightly), and the
// Alta forecast blend (forecast-data.js). Thresholds and their sources are in avalanche.js (FLAGS).

// North American Public Avalanche Danger Scale, travel advice (avalanche.org)
const TRAVEL_ADVICE = [
  null,
  'Generally safe avalanche conditions. Watch for unstable snow on isolated terrain features.',
  'Heightened avalanche conditions on specific terrain features. Evaluate snow and terrain carefully; identify features of concern.',
  'Dangerous avalanche conditions. Careful snowpack evaluation, cautious route-finding and conservative decision-making essential.',
  'Very dangerous avalanche conditions. Travel in avalanche terrain not recommended.',
  'Avoid all avalanche terrain.',
];

const risk = { range: 'day', asOf: null, avy: null, avyErr: null, fc: null };

// Alta forecast, shared with the route checks (Plan tab)
let fcPromise = null;
function altaForecast() {
  fcPromise ||= fetchAll(false).then(raw => ({ raw, b: build(raw) })).catch(e => { fcPromise = null; throw e; });
  return fcPromise;
}
async function altaToday() {
  try {
    const { b } = await altaForecast();
    const p = b.periods.find(x => x.isDay && x.date === b.today) || b.periods.find(x => x.isDay);
    return { highF: p?.tempF ?? null, fz: p?.fz ?? null, snow: b.days[0]?.snow ?? 0 };
  } catch { return null; }
}
globalThis.altaToday = altaToday;

// Per-day forecast weather for the red-flag tables
function forecastDays(b, n = 7) {
  return b.days.slice(0, n).map(d => {
    const hs = b.hours.filter(h => skiDay(h.t) === d.date);
    const rain = hs.reduce((s, h) => s + (h.water || 0) * (1 - (h.frac ?? 1)), 0);
    const ws = Math.max(0, ...hs.map(h => h.ws ?? 0));
    const day = b.periods.find(p => p.isDay && p.date === d.date);
    return { date: d.date, snow: d.snow ?? 0, water: d.water ?? 0, rain, ws, high: day?.tempF ?? null, fz: day?.fz ?? null };
  });
}

const $r = id => document.getElementById(id);
const escR = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayLabel = d => `${dow(d)} ${dom(d)}`;
const compass8 = deg => deg == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
const chipStyle = lvl => { const g = DANGER[lvl]; return g ? `background:${g.color};color:${g.ink}` : ''; };

async function loadRisk() {
  risk.avy = null; risk.avyErr = null;
  try { risk.avy = await fetchAvalanche(risk.asOf); } catch (e) { risk.avyErr = e.message; }
  try { risk.fc = await altaForecast(); } catch { risk.fc = null; }
  paintButton();
  renderRisk();
}

function paintButton() {
  const el = $r('avy-level');
  const lvl = risk.asOf ? null : risk.avy?.zone?.level;
  if (DANGER[lvl]) { el.textContent = `${lvl} ${DANGER[lvl].name}`; el.style.cssText = chipStyle(lvl); }
  else { el.textContent = risk.avyErr ? 'Offline' : 'No rating'; el.style.cssText = ''; }
}

function flagRow(on, icon, title, detail, src) {
  return `<div class="flag${on ? ' on' : ''}"><span class="ic">${on ? '⚠️' : icon}</span><span><b>${title}</b>${detail ? ' ' + detail : ''}</span>${src ? `<small>${src}</small>` : ''}</div>`;
}

function renderDay() {
  const z = risk.avy?.zone, lvl = z?.level, g = DANGER[lvl];
  const advice = z?.travelAdvice && lvl ? z.travelAdvice : TRAVEL_ADVICE[lvl];
  let h = '';
  if (risk.avyErr) h += `<p class="muted">The danger feed isn't reachable right now (${escR(risk.avyErr)}). Check <a href="${UAC_SALT_LAKE}" target="_blank" rel="noopener">UAC directly</a>.</p>`;
  h += g
    ? `<div class="danger-big" style="${chipStyle(lvl)}"><span class="lvl">${lvl}</span><div><div class="nm">${g.name}</div><p>${escR(advice)}</p></div></div>`
    : `<div class="danger-big" style="background:#232c36"><span class="lvl">–</span><div><div class="nm">No rating ${risk.asOf ? 'that day' : 'today'}</div><p>UAC hasn't published a Salt Lake rating for ${risk.asOf ? 'this date' : 'today'}. Early and late season, read their latest conditions update and treat any slope with snow as possible avalanche terrain.</p></div></div>`;
  if (z?.warning) h += `<div class="check bad"><b>Avalanche warning in effect</b>See UAC for details.</div>`;
  h += `<a class="cta" href="${escR(z?.link || UAC_SALT_LAKE)}" target="_blank" rel="noopener">Read the full UAC forecast: rose, problems, discussion ↗</a>`;

  // weather red flags
  const obs = snotelDaily(risk.fc?.raw?.data?.snotel);
  const last = obs.at(-1);
  const wind = risk.avy?.wind || [];
  const w = [...wind].reverse().find(x => x.hours > 0);
  const f0 = risk.fc ? forecastDays(risk.fc.b, 1)[0] : null;
  h += '<h3>Red flags in the weather</h3>';
  if (risk.asOf) h += '<p class="muted small">Snow and forecast below are for today; only the danger rating follows the date you picked.</p>';
  if (last) {
    h += flagRow(last.gain >= FLAGS.newSnowIn, '❄️', `New snow, last day: ${last.gain}"`, `(depth ${last.depth ?? '–'}")`, `Atwater SNOTEL, Alta, ${dayLabel(last.date)}. Red flag at ${FLAGS.newSnowIn}" in 24 h (avalanche.org).`);
    h += flagRow(last.water >= FLAGS.waterIn, '💧', `Water, last day: ${last.water == null ? '–' : last.water.toFixed(2) + '"'}`, '', `Red flag at ${FLAGS.waterIn}" of snow water in 24 h (avalanche.org).`);
  }
  if (w) {
    const lee = leeAspects(w.loadingDir);
    h += flagRow(w.loadingHours >= 3, '💨', `Hidden Peak wind ${dayLabel(w.date)}: ${w.loadingHours} h at ${FLAGS.windMph} mph+`,
      `max ${w.maxWs ?? '–'} mph${w.maxGust ? `, gusts ${w.maxGust}` : ''}${w.loadingHours && w.loadingDir != null ? `, from the ${compass8(w.loadingDir)}: loads <b>${lee.join(', ')}</b> slopes` : ''}.`,
      `NWS station HDP (11,000 ft). ${FLAGS.windMph} mph ≈ the 25 km/h where Avalanche Canada says wind starts building slabs; flagged at 3+ hours.`);
  } else {
    h += flagRow(false, '💨', 'Hidden Peak wind: no saved readings yet', '', 'Saved nightly from NWS station HDP.');
  }
  if (f0) {
    h += flagRow(f0.snow >= FLAGS.newSnowIn || f0.water >= FLAGS.waterIn, '🌨️', `Forecast today: ${Math.round(f0.snow)}" snow, ${f0.water.toFixed(2)}" water`, '', 'Alta blend at 9,895 ft, 6 pm–6 pm.');
    if (f0.rain >= 0.05) h += flagRow(true, '🌧️', `Rain forecast: ${f0.rain.toFixed(2)}"`, 'Rain loads and weakens the snowpack.', 'avalanche.org: rain also loads and adds stress to the snowpack.');
    h += flagRow(f0.high != null && f0.high > 32, '☀️', `High ${f0.high == null ? '–' : Math.round(f0.high) + '°F'} at 9,895 ft${f0.fz ? `, freezing level ${(Math.round(f0.fz / 100) * 100).toLocaleString()}′` : ''}`,
      f0.high > 32 ? 'Above freezing: sunny SE–SW slopes warm first. Cody bails rather than sit under warming slopes.' : '', '');
    h += flagRow(f0.ws >= FLAGS.windMph, '🌬️', `Forecast wind: up to ${Math.round(f0.ws)} mph`, f0.ws >= FLAGS.windMph ? 'Enough to move loose snow onto lee slopes.' : '', 'Alta blend, 10 m wind at the forecast point.');
  }

  h += '<h3>Your terrain today</h3>';
  if (lvl >= 3) h += `<button class="cta primary" data-act="safe">Show low-angle terrain with nothing above it</button><p class="muted small">Cody Townsend on Considerable and High days: stay on slopes of about 20–25° with no overhead hazard, and pick the corner of terrain you'll hang out in.</p>`;
  else h += `<button class="cta" data-act="safe">Show low-angle terrain with nothing above it</button>`;
  h += `<button class="cta" data-act="rose">Fill in today's danger rose on the map</button>`;
  h += `<button class="cta" data-act="plan">Check a route against today (Plan)</button>`;

  h += '<h3>Only you can see these, out there</h3>';
  h += flagRow(false, '👀', 'Recent avalanches, shooting cracks, collapsing (whumpfs)', '', 'Signs of instability, avalanche.org.');
  h += flagRow(false, '✨', '“Shiny snow is bad snow”', 'Wind- or sun-glazed surfaces: back off.', 'Cody Townsend.');
  h += flagRow(false, '📐', 'A 31° roll can hide in a “30°” slope', 'Map slope smooths micro-terrain. Carry an inclinometer.', 'Cody Townsend; USGS 3DEP is ~10 m.');
  return h;
}

function renderWeek() {
  const hist = (risk.avy?.history || []).slice(-7);
  let h = '<h3>Danger, last 7 days</h3>';
  h += `<div class="strip w7">${hist.map(d => `<div class="cell" style="${chipStyle(d.rating)}"><b>${d.rating ?? '–'}</b>${dow(d.date)} ${dom(d.date)}</div>`).join('') || '<p class="muted">No data.</p>'}</div>`;
  const obs = snotelDaily(risk.fc?.raw?.data?.snotel).slice(-7);
  const windBy = Object.fromEntries((risk.avy?.wind || []).map(w => [w.date, w]));
  if (obs.length) {
    const tot = obs.reduce((s, x) => s + x.gain, 0), wat = obs.reduce((s, x) => s + (x.water || 0), 0);
    h += `<h3>What happened: ${tot}" new snow, ${wat.toFixed(2)}" water</h3>`;
    h += `<table class="mini-table"><tr><th>Day</th><th>New snow</th><th>Water</th><th>Wind ${FLAGS.windMph}+ mph</th></tr>${obs.map(x => {
      const w = windBy[x.date];
      return `<tr><td>${dayLabel(x.date)}</td><td class="${x.gain >= FLAGS.newSnowIn ? 'hot' : ''}">${x.gain}"</td><td class="${x.water >= FLAGS.waterIn ? 'hot' : ''}">${x.water == null ? '–' : x.water.toFixed(2)}</td>
        <td class="${w?.loadingHours >= 3 ? 'hot' : ''}">${w?.hours ? `${w.loadingHours} h${w.loadingHours && w.loadingDir != null ? ' ' + compass8(w.loadingDir) : ''}` : '–'}</td></tr>`;
    }).join('')}</table><p class="muted small">Atwater SNOTEL (snow, water) and Hidden Peak (wind, from the hours saved nightly). Orange = red flag.</p>`;
  }
  if (risk.fc) {
    const fd = forecastDays(risk.fc.b, 7);
    h += `<h3>Coming up: ${Math.round(fd.reduce((s, d) => s + d.snow, 0))}" forecast</h3>`;
    h += `<table class="mini-table"><tr><th>Day</th><th>Snow</th><th>Water</th><th>Rain</th><th>Wind</th><th>High</th></tr>${fd.map(d => `<tr>
      <td>${dayLabel(d.date)}</td><td class="${d.snow >= FLAGS.newSnowIn ? 'hot' : ''}">${Math.round(d.snow)}"</td><td class="${d.water >= FLAGS.waterIn ? 'hot' : ''}">${d.water.toFixed(2)}</td>
      <td class="${d.rain >= 0.05 ? 'hot' : ''}">${d.rain >= 0.01 ? d.rain.toFixed(2) : '–'}</td><td class="${d.ws >= FLAGS.windMph ? 'hot' : ''}">${Math.round(d.ws)}</td>
      <td class="${d.high > 32 ? 'hot' : ''}">${d.high == null ? '–' : Math.round(d.high) + '°'}</td></tr>`).join('')}</table>
      <p class="muted small">Alta blend at 9,895 ft; days run 6 pm–6 pm. Big loading days, rain and above-freezing highs are flagged.</p>`;
  }
  if (risk.asOf) h += '<p class="muted small">Snow, wind and forecast tables are for this week; only the danger strip follows the date you picked.</p>';
  return h;
}

function renderMonth() {
  const hist = risk.avy?.history || [];
  let h = '<h3>Danger, last 30 days</h3>';
  if (hist.length) {
    const lead = new Date(hist[0].date + 'T12:00:00Z').getUTCDay();
    h += `<div class="strip m">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<div class="cell empty" style="min-height:0"><b>${d}</b></div>`).join('')}${'<div class="cell empty"></div>'.repeat(lead)}${hist.map(d => `<div class="cell" style="${chipStyle(d.rating)}" title="${dayLabel(d.date)}: ${DANGER[d.rating]?.name || 'no rating'}"><b>${d.rating ?? '·'}</b>${dom(d.date)}</div>`).join('')}</div>`;
    const counts = [0, 0, 0, 0, 0, 0];
    hist.forEach(d => counts[d.rating ?? 0]++);
    const rated = hist.length - counts[0];
    h += rated
      ? `<p class="small">${[1, 2, 3, 4, 5].filter(l => counts[l]).map(l => `<span class="uac-chip" style="${chipStyle(l)}">${DANGER[l].name}: ${counts[l]} d</span>`).join(' ')} ${counts[0] ? `<span class="muted">· no rating ${counts[0]} d</span>` : ''}</p>`
      : '<p class="muted small">No UAC Salt Lake ratings in this window. Pick an earlier date below to look back at last season.</p>';
  }
  const obs = snotelDaily(risk.fc?.raw?.data?.snotel);
  if (obs.length && !risk.asOf) {
    const tot = obs.reduce((s, x) => s + x.gain, 0), wat = obs.reduce((s, x) => s + (x.water || 0), 0);
    const big = obs.reduce((m, x) => x.gain > (m?.gain ?? -1) ? x : m, null);
    const heavy = obs.filter(x => x.gain >= FLAGS.newSnowIn || x.water >= FLAGS.waterIn).length;
    h += `<h3>Snow, last ${obs.length} days</h3><p>${tot}" new snow, ${wat.toFixed(2)}" water${big?.gain ? `; biggest day ${big.gain}" (${dayLabel(big.date)})` : ''}. ${heavy} red-flag loading day${heavy === 1 ? '' : 's'}. Depth now ${obs.at(-1).depth ?? '–'}".</p>`;
  }
  const wind = (risk.avy?.wind || []).filter(w => w.hours);
  if (wind.length) {
    const days = wind.filter(w => w.loadingHours >= 3);
    h += `<h3>Wind loading</h3><p>${days.length} of ${wind.length} days with saved Hidden Peak readings had 3+ hours at ${FLAGS.windMph} mph+${days.length ? ': ' + days.map(w => `${dayLabel(w.date)} (${compass8(w.loadingDir)})`).join(', ') : ''}.</p>`;
  }
  return h;
}

function renderRisk() {
  const body = $r('avy-body');
  if (!body || $r('avy-sheet').hidden) return;
  let h = risk.range === 'day' ? renderDay() : risk.range === 'week' ? renderWeek() : renderMonth();
  h += `<div class="asof"><label for="avy-asof">Look back to</label><input type="date" id="avy-asof" max="${risk.avy?.asOf || ''}" value="${risk.asOf || ''}">${risk.asOf ? '<button id="avy-today" class="linkish">Back to today</button>' : ''}</div>`;
  h += `<p class="muted small">Danger: Utah Avalanche Center via avalanche.org (overall rating only; the rose and problems are on UAC's page). ${risk.avy?.asOf ? 'As of ' + dayLabel(risk.avy.asOf) + '.' : ''}</p>`;
  body.innerHTML = h;
  body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    closeAvalanche();
    if (b.dataset.act === 'safe') { setMode('safe'); if (map.getZoom() < 12) map.easeTo({ zoom: 12.5 }); }
    if (b.dataset.act === 'rose') openTab('map');
    if (b.dataset.act === 'plan') openTab('plan');
  });
  $r('avy-asof').onchange = e => { risk.asOf = e.target.value || null; body.innerHTML = '<p class="muted">Loading…</p>'; loadRisk(); };
  $r('avy-today') && ($r('avy-today').onclick = () => { risk.asOf = null; loadRisk(); });
}

function openAvalanche() {
  $r('avy-sheet').hidden = false;
  renderRisk();
  $r('avy-close').focus();
}
function closeAvalanche() {
  $r('avy-sheet').hidden = true;
  if (location.hash === '#avalanche') history.replaceState(null, '', location.pathname);
  $r('avy-btn').focus();
}
globalThis.openAvalanche = openAvalanche;

$r('avy-btn').onclick = openAvalanche;
$r('avy-close').onclick = closeAvalanche;
$r('avy-sheet').addEventListener('click', e => { if (e.target.id === 'avy-sheet') closeAvalanche(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$r('avy-sheet').hidden) closeAvalanche(); });
document.querySelectorAll('.avy-range [role=tab]').forEach(b => b.onclick = () => {
  risk.range = b.dataset.range;
  document.querySelectorAll('.avy-range [role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  renderRisk();
});
loadRisk();
if (location.hash === '#avalanche') openAvalanche();
