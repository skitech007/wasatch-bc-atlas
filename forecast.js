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
const wind = (dir, spd) => spd == null ? '–' : `${SNOW.compass(dir)}${Math.round(spd)}`;
// Colour ramp for precip chance and snow cells (one hue, light to dark)
const chanceBg = c => c == null || c < 5 ? '' : `background: color-mix(in oklab, var(--s1) ${Math.round(c * 0.55)}%, transparent)`;

// ---------- renderers ----------
function renderSummary(b) {
  const groups = [[0, 5, 'Next 1–5 days'], [5, 10, 'Days 6–10'], [10, 15, 'Days 11–15']];
  const max = Math.max(4, ...b.days.map(d => d.snow || 0));
  $('summary').innerHTML = groups.map(([a, z, label]) => {
    const ds = b.days.slice(a, z);
    const tot = ds.reduce((s, d) => s + (d.snow || 0), 0);
    const anyMissing = ds.some(d => d.snow == null);
    // The 6"+ odds sit under their own five bars, so each number lines up with its day
    const odds = ds.map(d => {
      const p = d.ens?.pPowder;
      return `<span class="odd${p >= 40 ? ' hot' : ''}" style="${chanceBg(p)}" data-tip="${esc(`${dow(d.date)} ${dom(d.date)}: ${p == null ? 'no ensemble' : Math.round(p) + '% of ' + d.ens.n + ' ensemble runs give ' + POWDER_IN + '"+'}`)}">${p == null ? '–' : Math.round(p)}</span>`;
    }).join('');
    return `<section class="sgroup">
      <header><span>${label}</span><b class="${tot >= 12 ? 'pow' : ''}">${Math.round(tot)}"${anyMissing ? '<sup title="Some models end before these days">*</sup>' : ''}</b></header>
      ${snowBars(ds, { max, marks: [], todayFirst: a === 0, tipAttr: 'data-tip' })}
      <div class="odds-row"><span class="odds-cap">% chance of ${POWDER_IN}"+</span>${odds}</div>
    </section>`;
  }).join('');
  $('legend').innerHTML = snowLegend();
}

// Day & night as a list: snow block, temperature and weather on the first line, then snow ratio,
// snow level, precip chance and wind under it. On a wide screen the second line becomes columns.
function renderPeriods(b) {
  const byDate = [];
  b.periods.forEach(p => { const g = byDate.at(-1); if (g && g.date === p.date) g.ps.push(p); else byDate.push({ date: p.date, ps: [p] }); });
  const lvl = p => p.snowLevel != null ? `${(Math.round(p.snowLevel / 100) * 100).toLocaleString()}′`
    : p.fz != null ? `<span title="Freezing level (models); NWS snow level runs out after ~7 days">FzL ${(Math.round(p.fz / 100) * 100).toLocaleString()}′</span>` : '–';
  const row = p => {
    const type = precipType(p);
    const likelyHi = likelyRange(p.ens, p.snow)?.[1] ?? p.snow;
    // A rain period shows its rain, not a snow range
    const chip = type === 'rain' && (p.water || 0) >= 0.01
      ? `<span class="snow-chip t-rain">Rain</span><small>${in2(p.water)}" water</small>`
      : `<span class="snow-chip t-${likelyHi >= 0.5 ? snowClass(p) : 'none'}" title="${PTYPE_NAME[type]}">${rangeText(p.ens, p.snow)}</span>${p.snow >= 0.05 ? `<small>${p.snow.toFixed(1)}" likely</small>` : ''}`;
    return `<div class="prow ${p.isDay ? 'day' : 'night'}">
      <span class="pn">${p.isDay ? 'Day' : 'Night'}</span>
      <span class="pchip">${chip}</span>
      <span class="ptemp">${r0(p.tempF)}°</span>
      ${wxIcon(p) || '<span class="wx"></span>'}
      <span class="pmeta">
        <span><span class="lbl">Ratio </span><b>${p.slr ? Math.round(p.slr) + ':1' : '–'}</b></span>
        <span><span class="lbl">Snow lvl </span><b>${lvl(p)}</b></span>
        <span><span class="lbl">Precip </span><b>${p.chance == null ? '–' : Math.round(p.chance) + '%'}</b></span>
        <span><span class="lbl">Wind </span><b>${wind(p.wd, p.ws)}</b>${p.wg ? ` <span class="lbl">g</span><span class="lbl">${r0(p.wg)}</span>` : ''}</span>
        <span class="x"><b>${r0(p.wg)}</b></span>
        <span class="x"><b>${r0(p.app)}°</b></span>
        <span class="x"><b>${in2(p.water)}"</b></span>
      </span>
    </div>`;
  };
  $('periods').innerHTML = `<div class="phead"><span></span><span>Snow · likely range</span><span>Temp</span><span></span><span>Ratio</span><span>Snow level</span><span>Precip</span><span>Wind mph</span><span>Gust</span><span>Feels</span><span>Water</span></div>
    <div class="plist">${byDate.map(g => `<div class="pday-group"><div class="pday-label">${g.date === b.today ? 'Today' : dow(g.date)}<small>${new Date(g.date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</small></div><div>${g.ps.map(row).join('')}</div></div>`).join('')}</div>`;
}

// Hourly: one day at a time (chips pick the day), hours down the page so nothing scrolls sideways
let hourlyDay = null;
function renderHourly(b) {
  const days = b.days.map(d => d.date);
  if (!hourlyDay || !days.includes(hourlyDay)) hourlyDay = b.today;
  $('jump').innerHTML = days.map(d => `<button role="tab" data-day="${d}" aria-selected="${d === hourlyDay}">${d === b.today ? 'Today' : dow(d) + ' ' + dom(d)}</button>`).join('');
  const hs = b.hours.filter(h => dateOf(h.t) === hourlyDay);
  const snowBg = h => h.snow >= 0.05 ? `background: color-mix(in oklab, var(--c-snow) ${Math.min(75, 20 + Math.round(h.snow * 60))}%, transparent)` : '';
  $('hourly').innerHTML = `<div class="hhead"><span>Time</span><span></span><span>Temp</span><span>Snow"</span><span>Prec</span><span>Wind mph</span><span class="sl">Snow lvl</span><span class="x">Feels</span><span class="x">Cloud</span><span class="x">Ratio</span></div>
    <div class="hlist">${hs.map(h => {
      const hr = hourOf(h.t), now = h.t === b.nowKey;
      return `<div class="hrow${now ? ' now' : ''}"${now ? ' id="h-now"' : ''}>
        <span class="t">${hourLabel(hr)}${now ? '<small>Now</small>' : ''}</span>
        ${wxIcon({ ...h, isDay: hr >= 7 && hr < 19 }) || '<span></span>'}
        <span class="tmp">${r0(h.tempF)}°</span>
        <span class="sn${h.snow >= 0.05 ? '' : ' zero'}" style="${snowBg(h)}">${h.snow == null ? '–' : h.snow.toFixed(1)}</span>
        <span class="pc">${h.chance == null ? '–' : Math.round(h.chance) + '%'}</span>
        <span class="wd"><b>${wind(h.wd, h.ws)}</b>${h.wg ? ` g${r0(h.wg)}` : ''}</span>
        <span class="sl">${h.snowLevel != null ? (Math.round(h.snowLevel / 100) * 100).toLocaleString() : h.fz != null ? 'FzL ' + (Math.round(h.fz / 100) * 100).toLocaleString() : '–'}</span>
        <span class="x">${r0(h.app)}°</span>
        <span class="x">${r0(h.cc)}%</span>
        <span class="x">${h.slr ? Math.round(h.slr) + ':1' : '–'}</span>
      </div>`;
    }).join('') || '<p class="muted">No hourly data for this day.</p>'}</div>`;
  $('hourly-day').textContent = hourlyDay === b.today ? 'Today' : `${dow(hourlyDay)} ${dom(hourlyDay)}`;
  $('jump').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
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
  const alta = R.id === 'alta';
  // Monograms for every resort: resort logos are trademarks
  $('badge').innerHTML = `<span class="mono ${LCC(R) ? 'lcc' : 'bcc'}">${monogram(R)}</span>`;
  $('obs-where').textContent = `· ${R.snotel.name} SNOTEL${R.snotel.km < 1 ? `, ${R.name}` : `, ${R.snotel.km} km away`}`;
  $('summary-hint').innerHTML = `Bars are the ${esc(R.name)} blend, coloured by what falls. Each day runs 6 pm the night before to 6 pm. The likely range for each 12 hours is in Day &amp; night; tap a bar for the day's range and odds.${alta ? ' <a href="scorecard.html">How accurate has it been? Scorecard →</a>' : ''}`;
  $('models-hint').textContent = `Running total of snow at ${R.name} by model, after each model's ${R.name} correction. The grey band covers the middle 80% of the 82 ensemble runs' running totals.`;
  const today = localKey(new Date()).slice(0, 10);
  $('opening').innerHTML = R.opening && R.opening > today
    ? `<span class="pill warn" title="Opening day from Ski Utah">Opens ${new Date(R.opening + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>`
    : R.opening ? '' : '<span class="pill" title="Ski Utah">Opening TBA</span>';
  renderCams();
}

// YouTube cams load as a still frame and only start the player when tapped, so the page stays light
function renderCams() {
  const c = R.cams;
  const yt = c.youtube.map(v => `<button class="cam" data-yt="${esc(v.id)}" title="Play ${esc(v.name)} live">
      <img src="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault_live.jpg" alt="" loading="lazy">
      <span class="cam-play" aria-hidden="true">${ICON.play}</span><span class="cam-name">${esc(v.name)}</span></button>`).join('');
  $('cams').innerHTML = `${yt ? `<div class="cam-grid">${yt}</div>` : ''}
    <a class="cam-link" href="${esc(c.page)}" target="_blank" rel="noopener"><span><b>${yt ? `More on ${esc(R.name)}'s site` : `Open ${esc(R.name)}'s live cams`}</b><small>${esc(c.label)}</small></span>${ICON.external}</a>
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
  $('refresh').classList.add('spin');
  try {
    if (!R) { R = await resortById(RESORT_ID); renderHeader(); }
    const res = await fetchAll(force, R.id);
    const b = build(res);
    renderSummary(b); renderPeriods(b); renderHourly(b); renderModels(b);
    renderObserved(res.data); renderNws(res.data); renderMethod(b, res.data);
    const errs = Object.entries(res.errors);
    const when = new Date(res.at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    const down = errs.filter(([k]) => k !== 'corrections');
    $('status').innerHTML = `${ft(R.point.ft)} ft · updated ${when}` + (down.length ? ` · <span class="warn">${down.length} source${down.length > 1 ? 's' : ''} down</span>` : '');
    $('alerts').insertAdjacentHTML('beforeend', down.length ? `<div class="alert"><b>Some sources didn't answer:</b> ${esc(down.map(([k]) => k).join(', '))}. The rest of the blend is shown.</div>` : '');
    window.resortForecast = b; // handy for poking at numbers in the console
  } catch (e) {
    const off = navigator.onLine === false;
    $('status').innerHTML = `<span class="warn">${off ? 'No signal' : 'Forecast unavailable'}</span>`;
    $('summary').innerHTML = `<div class="banner ${off ? 'info' : 'danger'}">${ICON[off ? 'wifiOff' : 'alert']}<div><b>${off ? 'No signal' : 'Forecast failed to load'}</b>${off ? 'This forecast loads when you are back in coverage.' : esc(e.message)}</div></div>`;
    ['periods', 'hourly'].forEach(id => { $(id).innerHTML = ''; });
    console.error(e);
  } finally {
    $('refresh').classList.remove('spin');
  }
}

$('refresh').addEventListener('click', () => load(true));
$('jump').addEventListener('click', ev => {
  const d = ev.target.closest('[data-day]')?.dataset.day; if (!d || !window.resortForecast) return;
  hourlyDay = d; renderHourly(window.resortForecast);
});
load(false);
