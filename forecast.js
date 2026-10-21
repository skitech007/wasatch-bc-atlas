// Alta snow forecast page: renders the summary, day/night, hourly, model and observed views.
// Data and maths come from forecast-data.js.

// ---------- shared bits ----------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = v => v == null ? '–' : Math.round(v).toString();
const in2 = v => v == null ? '–' : v.toFixed(2);
const isPowder = v => v != null && v >= POWDER_IN - 0.5;
// Likely range: the ensembles' middle half, scaled so it sits around the blend. The blend sets
// the amount, the ensembles say how sure we are.
function likely(ens, blend) {
  if (!ens || blend == null) return null;
  return [Math.max(0, blend - (ens.p50 - ens.p25)), blend + (ens.p75 - ens.p50)];
}
function snowRange(ens, blend) {
  const r = likely(ens, blend);
  if (r) {
    const lo = Math.round(r[0]), hi = Math.round(r[1]);
    if (hi <= 0) return '0"';
    return lo === hi ? `${lo}"` : `${lo}–${hi}"`;
  }
  return blend == null ? '–' : `${Math.round(blend)}"`;
}
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
  const max = Math.max(4, ...b.days.map(d => Math.max(d.snow || 0, likely(d.ens, d.snow)?.[1] || 0)));
  $('summary').innerHTML = groups.map(([a, z, label]) => {
    const ds = b.days.slice(a, z);
    const tot = ds.reduce((s, d) => s + (d.snow || 0), 0);
    const anyMissing = ds.some(d => d.snow == null);
    return `<section class="sgroup">
      <header><span>${label}</span><b>${Math.round(tot)}"${anyMissing ? '<sup title="Some models end before these days">*</sup>' : ''}</b></header>
      <div class="bars">${ds.map(d => {
        const v = d.snow || 0, h = Math.max(2, 100 * v / max);
        const tip = `${dow(d.date)} ${dom(d.date)}: ${v.toFixed(1)}" blended`
          + (d.ens ? ` · likely ${snowRange(d.ens, d.snow)} · ${Math.round(d.ens.pPowder)}% chance of ${POWDER_IN}"+` : '');
        // Whisker: the likely range
        const lr = likely(d.ens, d.snow);
        const wh = lr && lr[1] >= 0.5
          ? `<em style="bottom:${100 * lr[0] / max}%;height:${Math.max(1, 100 * (lr[1] - lr[0]) / max)}%"></em>` : '';
        return `<div class="bar" tabindex="0" data-tip="${esc(tip)}">
          <span class="bv">${v >= 0.5 ? Math.round(v) + '"' : v > 0.05 ? 'T' : ''}</span>
          <div class="area"><i class="${isPowder(v) ? 'powder' : ''}" style="height:${h}%"></i>${wh}</div>
          <span class="bd">${dow(d.date)[0]}<br>${dom(d.date)}</span>
        </div>`;
      }).join('')}</div>
    </section>`;
  }).join('');
  // Powder odds strip
  $('odds').innerHTML = b.days.map(d => {
    const p = d.ens?.pPowder;
    return `<div class="odd" style="${chanceBg(p)}" data-tip="${esc(`${dow(d.date)} ${dom(d.date)}: ${p == null ? 'no ensemble' : Math.round(p) + '% of ' + d.ens.n + ' ensemble runs give ' + POWDER_IN + '"+'}`)}">
      <span>${p == null ? '–' : Math.round(p) + '%'}</span></div>`;
  }).join('');
}

function renderPeriods(b) {
  const rows = b.periods.map(p => {
    const [ic, icTitle] = icon(p);
    const rangeTxt = snowRange(p.ens, p.snow);
    const blended = p.snow >= 0.05 ? `${p.snow.toFixed(1)}"` : '';
    const barW = Math.min(100, 100 * (likely(p.ens, p.snow)?.[1] ?? p.snow) / 10);
    const cls = isPowder(p.snow) ? 'powder' : p.frac != null && p.frac < 0.9 && p.water >= 0.01 ? 'mixed' : '';
    return `<tr class="${p.isDay ? 'day' : 'night'}">
      ${p.isDay || p === b.periods[0] ? `<th rowspan="${p.isDay && b.periods[b.periods.indexOf(p) + 1] ? 2 : 1}" class="pday">${dow(p.date)}<small>${dom(p.date)}</small></th>` : ''}
      <td class="pn">${p.isDay ? 'Day' : 'Night'}</td>
      <td class="snowcell ${cls}"><i style="width:${barW}%"></i><b>${rangeTxt}</b><small>${blended}</small></td>
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
  rows.push(`<tr class="blendrow"><th>Alta blend</th>${b.days.map(d => `<td class="${isPowder(d.snow) ? 'pw' : ''}">${d.snow == null ? '·' : d.snow.toFixed(1)}</td>`).join('')}
    <td class="tot">${Math.round(b.days.reduce((s, d) => s + (d.snow || 0), 0))}"</td></tr>`);
  $('models').innerHTML = `<table class="mtable"><thead><tr><th>Snow by day, inches <small>(Alta-corrected)</small></th>
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
    <p class="hint">New snow here is the rise in measured depth at the Atwater SNOTEL (8,750 ft, at Alta), midnight to midnight. Settling makes this read a little low in big storms.</p>`;
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

function renderMethod(b, data) {
  const c = data.calib;
  if (!c) return;
  const leads = Object.keys(c.factors[MODELS[0].id]);
  $('method-factors').innerHTML = MODELS.map(m => `<tr><th><i class="key" style="background:${m.color}"></i>${m.name}</th>
    ${leads.map(n => `<td title="${c.totals[m.id][n].forecast}&quot; forecast vs ${c.totals[m.id][n].observed}&quot; measured over ${c.totals[m.id][n].days} days · blend weight ${Math.round(100 * c.blend_weights[m.id][n])}%">×${c.factors[m.id][n].toFixed(2)}</td>`).join('')}</tr>`).join('');
  $('method-seasons').textContent = c.seasons.map(s => s.slice(0, 4) + '–' + s.slice(16, 18)).join(' and ');
}

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
    const res = await fetchAll(force);
    const b = build(res);
    renderSummary(b); renderPeriods(b); renderHourly(b); renderModels(b);
    renderObserved(res.data); renderNws(res.data); renderMethod(b, res.data);
    const errs = Object.entries(res.errors);
    const when = new Date(res.at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    $('status').innerHTML = `Updated ${when}` + (errs.length ? ` · <span class="warn">couldn't reach: ${errs.map(([k]) => k).join(', ')}</span>` : '');
    window.altaForecast = b; // handy for poking at numbers in the console
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
