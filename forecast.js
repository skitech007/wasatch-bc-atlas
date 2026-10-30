// Resort snow forecast page (forecast.html?r=alta|snowbird|brighton|solitude): renders the summary,
// day/night, cams, hourly, model and observed views. Data and maths come from forecast-data.js.

// ---------- shared bits ----------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = v => v == null ? '–' : Math.round(v).toString();
const in2 = v => v == null ? '–' : v.toFixed(2);
const isPowder = v => v != null && v >= POWDER_IN - 0.5;
const ft = v => Math.round(v).toLocaleString('en-US');
const RESORT_ID = new URLSearchParams(location.search).get('r') || 'alta';
let R = null;   // this page's resort, from data/resorts.json
function icon({ snow, water, frac, cc, isDay }) {
  if (snow >= 0.1 && frac >= 0.5) return ['🌨️', 'Snow'];
  if (water >= 0.01 && frac < 0.5) return ['🌧️', 'Rain'];
  if (water >= 0.01) return ['🌨️', 'Light snow'];
  if (cc == null) return ['', ''];
  if (cc < 25) return isDay ? ['☀️', 'Clear'] : ['🌙', 'Clear'];
  if (cc < 60) return isDay ? ['🌤️', 'Partly cloudy'] : ['☁️', 'Partly cloudy'];
  return ['☁️', 'Cloudy'];
}
const wind = (dir, spd) => spd == null ? '–' : `${SNOW.compass(dir)}${Math.round(spd)}`;
// Colour ramp for precip chance and snow cells (one hue, light to dark)
const chanceBg = c => c == null || c < 5 ? '' : `background: color-mix(in oklab, var(--s1) ${Math.round(c * 0.55)}%, transparent)`;

// ---------- renderers ----------
function renderSummary(b) {
  const groups = [[0, 5, 'Next 1–5 days'], [5, 10, 'Next 6–10 days'], [10, 15, 'Next 11–15 days']];
  const max = Math.max(4, ...b.days.map(d => d.snow || 0));
  $('summary').innerHTML = groups.map(([a, z, label]) => {
    const ds = b.days.slice(a, z);
    const tot = ds.reduce((s, d) => s + (d.snow || 0), 0);
    const anyMissing = ds.some(d => d.snow == null);
    return `<section class="sgroup">
      <header><span>${label}</span><b>${Math.round(tot)}"${anyMissing ? '<sup title="Some models end before these days">*</sup>' : ''}</b></header>
      ${snowBars(ds, { max, marks: [], todayFirst: a === 0, tipAttr: 'data-tip' })}
    </section>`;
  }).join('');
  $('legend').innerHTML = snowLegend();
  // Powder odds strip
  $('odds').innerHTML = b.days.map(d => {
    const p = d.ens?.pPowder;
    return `<div class="odd" style="${chanceBg(p)}" data-tip="${esc(`${dow(d.date)} ${dom(d.date)}: ${p == null ? 'no ensemble' : Math.round(p) + '% of ' + d.ens.n + ' ensemble runs give ' + POWDER_IN + '"+'}`)}">
      <span>${p == null ? '–' : Math.round(p)}</span></div>`;
  }).join('');
}

function renderPeriods(b) {
  const rows = b.periods.map(p => {
    const [ic, icTitle] = icon(p);
    const rangeTxt = rangeText(p.ens, p.snow);
    const blended = p.snow >= 0.05 ? `${p.snow.toFixed(1)}"` : '';
    // Under half an inch likely, the block stays plain text so the snowy periods stand out
    const cls = (likelyRange(p.ens, p.snow)?.[1] ?? p.snow) >= 0.5 ? snowClass(p) : 'none';
    return `<tr class="${p.isDay ? 'day' : 'night'}">
      ${p.isDay || p === b.periods[0] ? `<th rowspan="${p.isDay && b.periods[b.periods.indexOf(p) + 1] ? 2 : 1}" class="pday">${dow(p.date)}<small>${dom(p.date)}</small></th>` : ''}
      <td class="pn">${p.isDay ? 'Day' : 'Night'}</td>
      <td class="snowcell"><span class="chip t-${cls}" title="${PTYPE_NAME[precipType(p)]}">${rangeTxt}</span><small>${blended}</small></td>
      <td class="num">${r0(p.tempF)}°</td>
      <td class="ic" title="${icTitle}">${ic}</td>
      <td class="num">${p.slr ? Math.round(p.slr) + ':1' : '--'}</td>
      <td class="num">${p.snowLevel != null ? (Math.round(p.snowLevel / 100) * 100).toLocaleString() :`<span class="muted" title="Freezing level (models); NWS snow level runs out after ~7 days">${p.fz != null ? 'FzL ' + (Math.round(p.fz / 100) * 100).toLocaleString() : '–'}</span>`}</td>
      <td class="num" style="${chanceBg(p.chance)}">${p.chance == null ? '–' : Math.round(p.chance) + '%'}</td>
      <td class="num">${in2(p.water)}"</td>
      <td class="num">${r0(p.app)}°</td>
      <td class="num">${r0(p.rh)}%</td>
      <td class="num">${wind(p.wd, p.ws)}</td>
      <td class="num">${r0(p.wg)}</td>
      <td class="num">${r0(p.cc)}%</td>
    </tr>`;
  });
  $('periods').innerHTML = `<table class="ptable">
    <thead><tr><th></th><th></th><th>12-hr snow <small>likely range · blend</small></th><th>Temp</th><th></th><th>Snow ratio</th>
    <th>Snow level ft</th><th>Precip chance</th><th>Precip</th><th>Feels like</th><th>Humidity</th><th>Wind mph</th><th>Gust</th><th>Cloud</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;
}

function renderHourly(b) {
  const hs = b.hours;
  const rows = [
    ['Precip chance', h => h.chance == null ? '–' : Math.round(h.chance) + '%', h => chanceBg(h.chance)],
    ['Precipitation <small>in</small>', h => in2(h.water)],
    ['Snowfall <small>in</small>', h => h.snow == null ? '–' : h.snow.toFixed(1), h => h.snow >= 0.05 ? `background: color-mix(in oklab, var(--s1) ${Math.min(70, Math.round(h.snow * 60))}%, transparent)` : ''],
    ['Snow ratio', h => h.slr ? Math.round(h.slr) + ':1' : '--'],
    ['Snow level <small>ft</small>', h => h.snowLevel == null ? '<span class="muted">–</span>' : (Math.round(h.snowLevel / 100) * 100).toLocaleString()],
    ['Freezing level <small>ft</small>', h => h.fz == null ? '–' : (Math.round(h.fz / 100) * 100).toLocaleString()],
    ['Weather', h => { const hr = hourOf(h.t); const [i, t] = icon({ ...h, isDay: hr >= 7 && hr < 19 }); return `<span title="${t}">${i}</span>`; }],
    ['Temperature <small>°F</small>', h => r0(h.tempF)],
    ['Feels like <small>°F</small>', h => r0(h.app)],
    ['Humidity <small>%</small>', h => r0(h.rh)],
    ['Wind <small>mph</small>', h => wind(h.wd, h.ws)],
    ['Gust <small>mph</small>', h => r0(h.wg)],
    ['Cloud cover <small>%</small>', h => r0(h.cc)],
  ];
  const head = hs.map(h => {
    const hr = hourOf(h.t);
    return `<th class="${hr === 0 ? 'newday' : ''} ${h.t === b.nowKey ? 'now' : ''}" id="${hr === 0 ? 'h-' + dateOf(h.t) : ''}">${hourLabel(hr)}<small>${dow(dateOf(h.t))}</small></th>`;
  }).join('');
  const body = rows.map(([label, f, style]) => `<tr><th>${label}</th>${hs.map(h =>
    `<td class="${hourOf(h.t) === 0 ? 'newday' : ''}" style="${style ? style(h) : ''}">${f(h)}</td>`).join('')}</tr>`).join('');
  $('hourly').innerHTML = `<table class="htable"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $('jump').innerHTML = b.days.map(d => `<button data-day="${d.date}">${d.date === b.today ? 'Today' : dow(d.date) + ' ' + dom(d.date)}</button>`).join('');
  const now = $('hourly').querySelector('th.now');
  if (now) $('hourly').scrollLeft = now.offsetLeft - 160;
}

function renderModels(b) {
  const lastDay = b.days.length;
  const rows = MODELS.map(m => {
    const vals = b.days.map(d => d.byModel[m.id]);
    const tot = vals.reduce((s, v) => s + (v || 0), 0);
    const ends = vals.findIndex(v => v == null);
    const fs = Object.values(b.calib?.factors?.[m.id] || { 1: 1 });
    const fr = `×${Math.min(...fs).toFixed(1)}${Math.max(...fs) - Math.min(...fs) >= 0.1 ? '–' + Math.max(...fs).toFixed(1) : ''}`;
    return `<tr><th><i class="key" style="background:${m.color}"></i>${m.name} <small>${fr}</small></th>
      ${vals.map(v => `<td class="${isPowder(v) ? 'pw' : ''}">${v == null ? '<span class="muted">·</span>' : v < 0.05 ? '0' : v.toFixed(1)}</td>`).join('')}
      <td class="tot">${Math.round(tot)}"${ends >= 0 ? `<small> to day ${ends}</small>` : ''}</td></tr>`;
  });
  const nwsTot = b.days.reduce((s, d) => s + (d.nws || 0), 0);
  rows.push(`<tr><th><i class="key" style="background:var(--s7)"></i>NWS <small>forecasters' grid, uncorrected</small></th>
    ${b.days.map(d => `<td>${d.nws == null ? '<span class="muted">·</span>' : d.nws < 0.05 ? '0' : d.nws.toFixed(1)}</td>`).join('')}<td class="tot">${Math.round(nwsTot)}"</td></tr>`);
  rows.push(`<tr class="ensrow"><th>Ensemble median <small>${b.memberCount} runs</small></th>
    ${b.days.map(d => `<td>${d.ens ? d.ens.p50.toFixed(1) : '·'}</td>`).join('')}<td class="tot">${Math.round(b.days.reduce((s, d) => s + (d.ens?.p50 || 0), 0))}"</td></tr>`);
  rows.push(`<tr class="ensrow"><th>Storm flow <small>700 mb wind</small></th>${b.days.map(d => `<td>${d.sector ? (d.sector === 'other' ? '·' : d.sector) : '·'}</td>`).join('')}<td></td></tr>`);
  rows.push(`<tr class="blendrow"><th>${esc(R.name)} blend</th>${b.days.map(d => `<td class="${isPowder(d.snow) ? 'pw' : ''}">${d.snow == null ? '·' : d.snow.toFixed(1)}</td>`).join('')}
    <td class="tot">${Math.round(b.days.reduce((s, d) => s + (d.snow || 0), 0))}"</td></tr>`);
  $('models').innerHTML = `<table class="mtable"><thead><tr><th>Snow by day, inches <small>(${esc(R.name)}-corrected)</small></th>
    ${b.days.map(d => `<th>${dow(d.date)[0]}<small>${dom(d.date)}</small></th>`).join('')}<th>${lastDay} days</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  renderCumulative(b);
}

function renderCumulative(b) {
  const W = 720, H = 240, L = 36, R = 64, T = 12, B = 26;
  const n = b.days.length;
  const series = MODELS.map(m => {
    let s = 0; const pts = [];
    b.days.forEach((d, i) => { if (d.byModel[m.id] == null) return; s += d.byModel[m.id]; pts.push([i + 1, s]); });
    return { ...m, pts: [[0, 0], ...pts] };
  });
  let bs = 0; const blend = [[0, 0], ...b.days.map((d, i) => [i + 1, bs += d.snow || 0])];
  // Ensemble band: 10th–90th percentile of each run's running total
  const band = [[0, 0, 0], ...b.days.map((d, i) => d.cum && [i + 1, d.cum.p10, d.cum.p90]).filter(Boolean)];
  const hi = band.at(-1)[2];
  const ymax = Math.max(6, ...series.flatMap(s => s.pts.map(p => p[1])), bs, hi) * 1.08;
  const x = i => L + (W - L - R) * i / n, y = v => T + (H - T - B) * (1 - v / ymax);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const step = ymax > 60 ? 20 : ymax > 30 ? 10 : 5;
  const grid = []; for (let v = 0; v <= ymax; v += step) grid.push(v);
  const bandPath = band.length > 1 ? `M${band.map(p => `${x(p[0])},${y(p[2])}`).join('L')}L${band.slice().reverse().map(p => `${x(p[0])},${y(p[1])}`).join('L')}Z` : '';
  // Direct labels at line ends, nudged apart so they don't collide
  const ends = [...series.map(s => ({ name: s.name, color: s.color, v: s.pts.at(-1)[1], i: s.pts.at(-1)[0] })), { name: 'Blend', color: 'var(--text)', v: bs, i: n }]
    .sort((a, b2) => b2.v - a.v);
  let lastY = -Infinity;
  ends.forEach(e => { e.y = Math.max(y(e.v), lastY + 13); lastY = e.y; });
  $('cumulative').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative snow by model over ${n} days">
    ${grid.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3}" class="ax" text-anchor="end">${v}"</text>`).join('')}
    ${b.days.map((d, i) => (i % 2 === 0) ? `<text x="${x(i + 0.5)}" y="${H - 8}" class="ax" text-anchor="middle">${dow(d.date)[0]}${dom(d.date)}</text>` : '').join('')}
    ${bandPath ? `<path d="${bandPath}" class="band"/>` : ''}
    ${series.map(s => `<path d="${path(s.pts)}" fill="none" stroke="${s.color}" stroke-width="2"/>`).join('')}
    <path d="${path(blend)}" fill="none" stroke="var(--text)" stroke-width="3"/>
    ${ends.map(e => `<text x="${x(e.i) + 6}" y="${e.y + 4}" class="lbl" fill="${e.color}">${e.name} ${Math.round(e.v)}"</text>`).join('')}
    <line id="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" class="cross" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="cum-hit"/>
  </svg>`;
  const svg = $('cumulative').querySelector('svg'), cross = svg.querySelector('#cross');
  svg.querySelector('#cum-hit').addEventListener('pointermove', ev => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(1, Math.min(n, Math.round((p.x - L) / ((W - L - R) / n))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    const d = b.days[i - 1];
    const at = s => { const q = s.pts.find(pp => pp[0] === i); return q ? Math.round(q[1]) + '"' : '–'; };
    const bd = band.find(q => q[0] === i);
    showTip(ev, `<b>Through ${dow(d.date)} ${dom(d.date)}</b><br>Blend ${Math.round(blend[i][1])}"<br>${series.map(s => `<span style="color:${s.color}">■</span> ${s.name} ${at(s)}`).join('<br>')}${bd ? `<br><span class="muted">Ensemble 10–90% ${Math.round(bd[1])}–${Math.round(bd[2])}"</span>` : ''}`);
  });
  svg.querySelector('#cum-hit').addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
}

function renderObserved(data) {
  const el = $('observed');
  const d = data.snotel?.[0]?.data;
  if (!d) { el.innerHTML = '<p class="muted">SNOTEL data unavailable right now.</p>'; return; }
  const series = code => (d.find(e => e.stationElement.elementCode === code)?.values || []);
  const depth = series('SNWD'), swe = series('WTEQ'), prec = series('PREC'), tobs = series('TOBS');
  const byDate = arr => Object.fromEntries(arr.map(v => [v.date.slice(0, 10), v.value]));
  const D = byDate(depth), P = byDate(prec), T = byDate(tobs), S = byDate(swe);
  const dates = Object.keys(D).sort();
  const daily = dates.slice(1).map((dt, i) => {
    const prev = dates[i];
    const dd = D[dt] != null && D[prev] != null ? D[dt] - D[prev] : null;
    const pw = P[dt] != null && P[prev] != null ? P[dt] - P[prev] : null;
    return { date: dt, depth: D[dt], gain: dd != null && dd > 0 ? dd : 0, change: dd, water: pw != null && pw >= 0 && pw < 6 ? pw : null, temp: T[dt] };
  });
  const last = daily.slice(-15);
  const sums = [[0, 5], [5, 10], [10, 15]].map(([a, z]) => last.slice(-z, a ? -a : undefined));
  const latest = daily.at(-1);
  const max = Math.max(4, ...last.map(x => x.gain));
  el.innerHTML = `
    <div class="obs-tiles">
      <div class="tile"><b>${latest?.depth ?? '–'}"</b><span>Snow depth</span></div>
      <div class="tile"><b>${latest?.change == null ? '–' : (latest.change > 0 ? '+' : '') + latest.change + '"'}</b><span>Depth change, last day</span></div>
      <div class="tile"><b>${S[dates.at(-1)] ?? '–'}"</b><span>Snow water (SWE)</span></div>
      <div class="tile"><b>${P[dates.at(-1)] ?? '–'}"</b><span>Water-year precip (since Oct 1)</span></div>
    </div>
    <div class="obs-groups">${['Last 1–5 days', 'Prev 6–10 days', 'Prev 11–15 days'].map((lbl, i) => {
      const g = sums[i];
      return `<div><span>${lbl}</span><b>${g.reduce((s, x) => s + x.gain, 0)}"</b><small>${g.reduce((s, x) => s + (x.water || 0), 0).toFixed(2)}" water</small></div>`;
    }).join('')}</div>
    <div class="bars obs">${last.map(x => `<div class="bar" data-tip="${esc(`${dow(x.date)} ${dom(x.date)}: depth ${x.depth ?? '–'}" (${x.change == null ? '–' : (x.change > 0 ? '+' : '') + x.change}") · water ${x.water == null ? '–' : x.water.toFixed(2)}" · ${x.temp ?? '–'}°F`)}">
      <span class="bv">${x.gain ? x.gain + '"' : ''}</span><div class="area"><i style="height:${Math.max(2, 100 * x.gain / max)}%"></i></div><span class="bd">${dow(x.date)[0]}<br>${dom(x.date)}</span></div>`).join('')}</div>
    <p class="hint">New snow here is the rise in measured depth at the ${esc(R.snotel.name)} SNOTEL (${ft(R.snotel.ft)} ft, ${R.snotel.km < 1 ? `at ${esc(R.name)}` : `${R.snotel.km} km from ${esc(R.name)}'s forecast point`}), midnight to midnight. Settling makes this read a little low in big storms.</p>`;
}

function renderNws(data) {
  const al = data.alerts?.features || [];
  $('alerts').innerHTML = al.length ? al.map(f => `<div class="alert"><b>${esc(f.properties.event)}</b> ${esc(f.properties.headline || '')}</div>`).join('') : '';
  const afd = data.afd?.productText;
  if (!afd) { $('afd').innerHTML = '<p class="muted">Forecast discussion unavailable.</p>'; return; }
  // Lead with the key messages / synopsis, then the full text
  const m = afd.match(/\.(KEY MESSAGES|SYNOPSIS)\.\.\.([\s\S]*?)(?=\n&&|\n\.[A-Z /]+\.\.\.)/);
  const issued = new Date(data.afd.issuanceTime).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('afd').innerHTML = `${m ? `<p class="afd-lead"><b>${m[1] === 'KEY MESSAGES' ? 'Key messages' : 'Synopsis'}</b> <span class="muted">· NWS Salt Lake City, ${issued}</span></p><pre>${esc(m[2].trim())}</pre>` : ''}
    <details><summary>Full forecast discussion</summary><pre>${esc(afd)}</pre></details>`;
}

// The method write-up, with this resort's point, sensor and which corrections it has
function methodHtml() {
  const n = esc(R.name), st = `${esc(R.snotel.name)} SNOTEL`, pf = `${ft(R.point.ft)} ft`, alta = R.id === 'alta';
  const where = alta ? `${n}'s forecast point (${R.point.lat}, ${R.point.lon}, ${pf})`
    : `${n}'s forecast point (${R.point.lat}, ${R.point.lon}, ${pf}: on the mountain, halfway between the ${ft(R.base_ft)} ft base and ${ft(R.peak_ft)} ft peak)`;
  const near = R.snotel.km < 1 ? `at ${n}` : `${R.snotel.km} km from the forecast point; ${n} has no SNOTEL of its own`;
  return `<ol>
    <li><b>Water.</b> Hourly precipitation from four weather models for ${where}, via <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>.</li>
    <li><b>${n} correction.</b> The models smooth the Wasatch into blobs and miss how much falls at ${n}. For the winters of <span id="method-seasons"></span> (Nov 15 – Apr 15) we compared what each model forecast 1 to 7 days ahead with what fell at the ${st} (${ft(R.snotel.ft)} ft, ${near}), and multiply each model's water by its factor for that lead day (days 8–15 use day 7):
      <div class="scroll-x"><table class="ftable"><thead><tr><th>Model</th><th>1 day out</th><th>2</th><th>3</th><th>4</th><th>5</th><th>6</th><th>7</th></tr></thead><tbody id="method-factors"></tbody></table></div>
      Models with smaller day-to-day error after correction get more weight in the blend (hover a factor for details). Rerun <code>tools/calibrate.py ${R.id}</code> to refresh.</li>
    <li><b>Storm direction.</b> ${alta ? 'Alta does best in northwest flow and the models know it least well.' : 'How much falls depends on the storm direction, which the models handle least well.'} Each day is labelled by its 700 mb (about 10,000 ft) wind: NW, W, SW or other. Over the same two winters each model's misses were split by that label, and its water is scaled again for the day's direction. Directions with few wet days are pulled toward no change:
      <div class="scroll-x"><table class="ftable"><thead><tr><th>Model</th><th>NW</th><th>W</th><th>SW</th><th>Other</th></tr></thead><tbody id="method-direction"></tbody></table></div></li>
    <li><b>Temperature.</b> Each model's temperature is compared with the ${st} sensor in 3-hour blocks of the day. The miss swings with the season and with snow on the ground, so ${alta
      ? 'the correction averages two measures: a table by calendar month from every month since March 2024, and a rolling bias from the last 14 days, re-measured each morning for each lead day'
      : 'the correction uses a table by calendar month from every month since March 2024 (the nightly job that adds a rolling 14-day bias runs for Alta only)'}. For this month, 1 day out:
      <div class="scroll-x"><table class="ftable"><thead><tr><th>Model</th><th>12–3a</th><th>3–6a</th><th>6–9a</th><th>9a–12p</th><th>12–3p</th><th>3–6p</th><th>6–9p</th><th>9p–12a</th></tr></thead><tbody id="method-temp"></tbody></table></div>
      <span id="method-temp-note"></span> In hours when a model has precipitation its correction also gets a storm-hour adjustment (<span id="method-wet">–</span>): the sensor reads closer to the models while it snows than on clear nights, and those are the hours that decide rain or snow. The corrected temperature feeds the rain/snow split and the snow ratio. The sensor sits at ${ft(R.snotel.ft)} ft, so this assumes each model's miss is the same at ${pf}.${alta ? ' The <a href="scorecard.html">scorecard</a> tracks whether it helps.' : ''}</li>
    <li><b>Wind.</b> <span id="method-wind">${alta ? "No SNOTEL near Alta measures wind, so the nightly scorecard worker saves Hidden Peak's readings and learns the correction from them."
      : "Not corrected: SNOTELs don't measure wind, and the Hidden Peak correction is learned against Alta's forecast only. Wind here is the plain model blend, which reads light for ridgetops."}</span></li>
    <li><b>Rain or snow.</b> From the temperature at ${pf}: all snow at 32°F or colder, all rain at 37.4°F or warmer, a straight line between (Jennings et al. 2018). The bars and blocks are blue when at least 85% of the water falls as snow, green when at most 15% does, purple in between, and orange for any 6"+ day.</li>
    <li><b>Snow ratio.</b> Kuchera method: 12:1 at about 29°F, heavier above, lighter below, from the warmer of the ${pf} and 700 mb temperatures.</li>
    <li><b>Days 8–15.</b> The corrections are only measured out to 7 days, and a single model run that far out is mostly noise, so from day 8 the snow and water are the average of all 82 ensemble runs rather than the four-model blend. The model table still shows each model's own run.</li>
    <li><b>Odds and ranges.</b> The same steps run on all 82 runs of the ECMWF (51) and GFS (31) ensembles, each corrected with its parent model's factor (the GFS ensemble keeps one grid throughout, so its factor is held at the day-4 value). "Likely range" takes how spread out the middle half of those runs is and centres it on the blend; chance figures are the share of runs that hit the mark.</li>
    <li><b>Everything else</b> (temperature, feels like, humidity, wind, cloud, freezing level) is the weighted blend of the four models. Snow level comes from the NWS forecast grid (${esc(R.nws)}) and runs out after about 7 days.</li>
  </ol>
  <p class="hint">Sources: Open-Meteo forecast, ensemble and previous-runs APIs (NOAA, ECMWF, Environment Canada models) · NWS api.weather.gov (snow level, forecast snow, alerts, forecast discussion) · NRCS SNOTEL ${esc(R.snotel.triplet.split(':')[0])} ${esc(R.snotel.name)} · base and peak heights and opening day: Ski Utah. The forecast numbers never come from OpenSnow or the resort; the cams are the resort's own.</p>`;
}

function renderMethod(b, data) {
  $('method').innerHTML = methodHtml();
  const c = data.calib;
  if (!c) { $('method').insertAdjacentHTML('afterbegin', `<p class="warn">This resort's calibration file is missing, so its water isn't corrected.</p>`); return; }
  const leads = Object.keys(c.factors[MODELS[0].id]);
  $('method-factors').innerHTML = MODELS.map(m => `<tr><th><i class="key" style="background:${m.color}"></i>${m.name}</th>
    ${leads.map(n => `<td title="${c.totals[m.id][n].forecast}&quot; forecast vs ${c.totals[m.id][n].observed}&quot; measured over ${c.totals[m.id][n].days} days · blend weight ${Math.round(100 * c.blend_weights[m.id][n])}%">×${c.factors[m.id][n].toFixed(2)}</td>`).join('')}</tr>`).join('');
  $('method-seasons').textContent = c.seasons.map(s => s.slice(0, 4) + '–' + s.slice(16, 18)).join(' and ');
  const pct = v => v == null ? '–' : `${v >= 1 ? '+' : '−'}${Math.abs(Math.round((v - 1) * 100))}%`;
  if (c.direction_multipliers) {
    $('method-direction').innerHTML = MODELS.map(m => `<tr><th><i class="key" style="background:${m.color}"></i>${m.name}</th>
      ${['NW', 'W', 'SW', 'other'].map(sct => {
        const det = c.direction_detail[m.id][sct];
        return `<td title="${det.wet_days} wet days; unshrunk ${pct(det.raw)}">${pct(c.direction_multipliers[m.id][sct])}</td>`;
      }).join('')}</tr>`).join('');
  }
  if (c.temperature_bias_month_3h) {
    // Combined correction now in use for each 3-hour MST block, 1 day out
    const month = +b.today.slice(5, 7), roll = data.corrections?.temperature?.bias;
    const sg = v => v == null ? '–' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}°`;
    $('method-temp').innerHTML = MODELS.map(m => `<tr><th><i class="key" style="background:${m.color}"></i>${m.name}</th>
      ${[0, 1, 2, 3, 4, 5, 6, 7].map(k => {
        const a = c.temperature_bias_month_3h[m.id][month][k], r = roll?.[m.id]?.[1]?.[k];
        return `<td title="month table ${sg(a)} · last 14 days ${sg(r)}">${sg(r == null ? a : (a + r) / 2)}</td>`;
      }).join('')}</tr>`).join('');
    const wa = c.temperature_wet_adjust;
    if (wa) $('method-wet').textContent = MODELS.map(m => `${m.name} ${sg(wa[m.id]?.adjust ?? 0)}`).join(', ') + ', from November–April storm hours';
    $('method-temp-note').textContent = roll
      ? `Hover a cell for its two parts. Blocks are Mountain Standard Time; add an hour while daylight saving is on.`
      : R.id === 'alta' ? `Only the month table is in use here (the rolling part comes from the deployed site's nightly job). Blocks are Mountain Standard Time.`
      : `Blocks are Mountain Standard Time; add an hour while daylight saving is on.`;
  }
  const w = b.windFactor || data.corrections?.wind;
  if (w) $('method-wind').textContent = w.active
    ? `Forecast wind is scaled ×${w.speed.toFixed(2)} and gusts ×${w.gust.toFixed(2)}, learned from ${w.days} days of Hidden Peak (11,000 ft) readings vs what was forecast 1–7 days earlier, so it reads as upper-mountain wind.`
    : `Learning: ${w.days} of ${w.needDays} days of Hidden Peak (11,000 ft) readings matched so far; the correction switches on by itself after that. Until then wind is the uncorrected model blend.`;
}

// ---------- resort header, opening day, cams ----------
const monogram = r => ({ alta: 'AL', snowbird: 'SB', brighton: 'BR', solitude: 'SO' })[r.id] || r.name.slice(0, 2).toUpperCase();
const LCC = r => r.canyon === 'Little Cottonwood';
function renderHeader() {
  document.title = `${R.name} Snow Forecast`;
  $('rname').textContent = R.name;
  $('rpoint').textContent = `· forecast point ${ft(R.point.ft)} ft`;
  const alta = R.id === 'alta';
  $('badge').innerHTML = alta ? '<img src="badge.svg" alt="">' : `<span class="mono ${LCC(R) ? 'lcc' : 'bcc'}">${monogram(R)}</span>`;
  $('alta-logo').hidden = !alta;
  $('score-link').hidden = !alta;
  $('obs-where').textContent = `· ${R.snotel.name} SNOTEL${R.snotel.km < 1 ? `, ${R.name}` : `, ${R.snotel.km} km away`}`;
  $('summary-hint').innerHTML = `Bars are the ${esc(R.name)} blend, coloured by what falls. The likely range for each 12 hours is in Day &amp; night below; hover or tap a bar for the day's range and odds.${alta ? ' <a href="scorecard.html">How accurate has it been? Scorecard →</a>' : ''}`;
  $('models-hint').textContent = `Running total of snow at ${R.name} by model, after each model's ${R.name} correction. The grey band covers the middle 80% of the 82 ensemble runs' running totals.`;
  const today = localKey(new Date()).slice(0, 10);
  $('opening').textContent = R.opening && R.opening > today
    ? `Opens ${new Date(R.opening + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} (Ski Utah)`
    : R.opening ? '' : 'Opening day not announced yet (Ski Utah)';
  renderCams();
}

// YouTube cams load as a still frame and only start the player when tapped, so the page stays light
function renderCams() {
  const c = R.cams;
  const yt = c.youtube.map(v => `<button class="cam" data-yt="${esc(v.id)}" title="Play ${esc(v.name)} live">
      <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault_live.jpg" alt="" loading="lazy">
      <span class="cam-play" aria-hidden="true">▶</span><span class="cam-name">${esc(v.name)}</span></button>`).join('');
  $('cams').innerHTML = `${yt ? `<div class="cam-grid">${yt}</div>` : ''}
    <a class="cam-link" href="${esc(c.page)}" target="_blank" rel="noopener"><b>${yt ? `More on ${esc(R.name)}'s site ↗` : `Open ${esc(R.name)}'s live cams ↗`}</b><small>${esc(c.label)}</small></a>
    <p class="hint">${yt ? `${esc(R.name)} streams these on YouTube; they play here in YouTube's own player.`
      : `${esc(R.name)} publishes its cams as pictures on its own site rather than as a stream other apps can show, so this opens their page.`}</p>`;
}
document.addEventListener('click', ev => {
  const b = ev.target.closest('.cam[data-yt]');
  if (!b) return;
  const f = document.createElement('iframe');
  f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(b.dataset.yt)}?autoplay=1&mute=1&playsinline=1`;
  f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  f.allowFullscreen = true;
  f.title = b.title;
  f.className = 'cam-frame';
  b.replaceWith(f);
});

// ---------- tooltip ----------
const tip = document.createElement('div');
tip.className = 'tip'; tip.hidden = true; document.body.appendChild(tip);
function showTip(ev, html) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, ev.clientX + 14) + 'px';
  tip.style.top = Math.max(8, ev.clientY - r.height - 10) + 'px';
}
function hideTip() { tip.hidden = true; }
document.addEventListener('pointerover', ev => { const t = ev.target.closest('[data-tip]'); if (t) showTip(ev, esc(t.dataset.tip)); });
document.addEventListener('pointerout', ev => { if (ev.target.closest('[data-tip]')) hideTip(); });
document.addEventListener('focusin', ev => {
  const t = ev.target.closest('[data-tip]'); if (!t) return;
  const r = t.getBoundingClientRect(); showTip({ clientX: r.left, clientY: r.top }, esc(t.dataset.tip));
});
document.addEventListener('focusout', hideTip);

// ---------- boot ----------
async function load(force) {
  $('status').textContent = 'Loading forecast…';
  try {
    if (!R) { R = await resortById(RESORT_ID); renderHeader(); }
    const res = await fetchAll(force, R.id);
    const b = build(res);
    renderSummary(b); renderPeriods(b); renderHourly(b); renderModels(b);
    renderObserved(res.data); renderNws(res.data); renderMethod(b, res.data);
    const errs = Object.entries(res.errors);
    const when = new Date(res.at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    $('status').innerHTML = `Updated ${when}` + (errs.length ? ` · <span class="warn">couldn't reach: ${errs.map(([k]) => k).join(', ')}</span>` : '');
    window.resortForecast = b; // handy for poking at numbers in the console
  } catch (e) {
    $('status').innerHTML = `<span class="warn">Forecast failed to load: ${esc(e.message)}</span>`;
    console.error(e);
  }
}

$('refresh').addEventListener('click', () => load(true));
$('jump').addEventListener('click', ev => {
  const d = ev.target.dataset.day; if (!d) return;
  const th = $(`h-${d}`) || $('hourly').querySelector('th.now');
  if (th) $('hourly').scrollTo({ left: th.offsetLeft - 160, behavior: 'smooth' });
});
load(false);
