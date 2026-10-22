// Alta forecast scorecard: renders /api/scorecard, which the nightly worker (worker/index.js) builds.

const $ = id => document.getElementById(id);
const f2 = v => v == null ? '<span class="muted">–</span>' : v.toFixed(2);
const f1 = v => v == null ? '<span class="muted">–</span>' : v.toFixed(1);
const r0 = v => v == null ? '<span class="muted">–</span>' : Math.round(v).toString();
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const day = d => `${DOW[new Date(d + 'T12:00:00Z').getUTCDay()]} ${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const leadName = n => n === 1 ? '1 day out' : `${n} days out`;

function renderWater(s) {
  const rows = s.leads.filter(l => l.days).map(l => {
    const cells = [['blend', l.water.blend], ...s.models.map(m => [m.id, l.water.raw[m.id]])];
    const best = Math.min(...cells.map(c => c[1]).filter(v => v != null));
    return `<tr><th>${leadName(l.lead)}<small>${l.days} days · ${l.wetDays} wet</small></th>
      ${cells.map(([id, v]) => `<td class="${v === best ? 'best' : ''} ${id === 'blend' ? 'blendcol' : ''}">${f2(v)}"</td>`).join('')}
      <td class="muted">${l.water.bias == null ? '–' : (l.water.bias > 0 ? '+' : '') + l.water.bias.toFixed(2) + '"'}</td></tr>`;
  });
  $('water').innerHTML = rows.length ? `<table class="mtable score">
    <thead><tr><th></th><th>Alta blend</th>${s.models.map(m => `<th>${m.name} <small>raw</small></th>`).join('')}<th>Blend bias</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>` : `<p class="muted">No scored days yet. The first forecast saved is scored once that day has happened and SNOTEL reports it (usually the next morning).</p>`;
}

function renderTemp(s) {
  const rows = s.leads.filter(l => l.days && (l.temp.hi != null || l.temp.lo != null)).map(l => `<tr><th>${leadName(l.lead)}</th>
    <td class="blendcol ${l.temp.hi <= l.temp.hiRaw ? 'best' : ''}">${f1(l.temp.hi)}°</td><td>${f1(l.temp.hiRaw)}°</td>
    <td class="blendcol ${l.temp.lo <= l.temp.loRaw ? 'best' : ''}">${f1(l.temp.lo)}°</td><td>${f1(l.temp.loRaw)}°</td></tr>`);
  $('temp').innerHTML = rows.length ? `<table class="mtable score">
    <thead><tr><th></th><th>High, corrected</th><th>High, uncorrected</th><th>Low, corrected</th><th>Low, uncorrected</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>` : '<p class="muted">No scored days yet.</p>';
}

function renderRecent(s) {
  const fc = f => f ? `${f2(f.water)}" <small>${f1(f.snow)}" snow · ${r0(f.hi)}°/${r0(f.lo)}°</small>` : '<span class="muted">–</span>';
  $('recent').innerHTML = s.recent.length ? `<table class="mtable score recent">
    <thead><tr><th></th><th>Measured</th><th>Forecast 1 day out</th><th>3 days out</th><th>5 days out</th></tr></thead>
    <tbody>${s.recent.map(o => `<tr><th>${day(o.date)}</th>
      <td class="blendcol">${f2(o.water)}" <small>+${o.depthGain ?? '–'}" depth · ${r0(o.hi)}°/${r0(o.lo)}°</small></td>
      <td>${fc(o.f1)}</td><td>${fc(o.f3)}</td><td>${fc(o.f5)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No measured days saved yet.</p>';
}

function renderWind(s) {
  const w = s.wind;
  if (!w) { $('wind').innerHTML = '<p class="muted">Not started yet: the first nightly run hasn\'t happened.</p>'; return; }
  $('wind').innerHTML = `<p>${w.active
    ? `<b>On.</b> Forecast wind ×${w.speed.toFixed(2)}, gusts ×${w.gust.toFixed(2)}, learned from ${w.days} days (${w.hours} hours) at ${w.station}.`
    : `<b>Learning:</b> ${w.days} of ${w.needDays} days matched so far at ${w.station}${w.speed ? ` (running estimate: wind ×${w.speed.toFixed(2)}, gusts ×${(w.gust ?? 1).toFixed(2)})` : ''}. It switches on by itself at ${w.needDays} days.`}</p>
    <p class="hint">No SNOTEL near Alta measures wind, and the NWS only keeps about a week of station history, so the worker saves Hidden Peak's readings every night and compares them with the wind it forecast 1–7 days earlier. Hidden Peak is an exposed ridgetop, so the corrected wind reads as upper-mountain wind.</p>`;
}

(async () => {
  try {
    const r = await fetch('api/scorecard');
    if (!r.ok) throw new Error(`${r.status}: the scorecard only runs on the deployed site`);
    const s = await r.json();
    $('status').textContent = s.since ? `Tracking since ${day(s.since)} · ${s.snapshots} forecasts saved` : 'No forecasts saved yet';
    renderWater(s); renderTemp(s); renderRecent(s); renderWind(s);
  } catch (e) {
    $('status').innerHTML = `<span class="warn">Couldn't load the scorecard (${e.message}).</span>`;
  }
})();
