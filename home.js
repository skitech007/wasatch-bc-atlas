// Home: Alta 15-day snow (forecast-data.js does the maths) and today's avalanche danger chip.
const $ = id => document.getElementById(id);

function likely(ens, blend) {
  if (!ens || blend == null) return null;
  return [Math.max(0, blend - (ens.p50 - ens.p25)), blend + (ens.p75 - ens.p50)];
}

function renderChart(b) {
  const max = Math.max(4, ...b.days.map(d => Math.max(d.snow || 0, likely(d.ens, d.snow)?.[1] || 0)));
  $('chart').innerHTML = b.days.map((d, i) => {
    const v = d.snow || 0;
    const lr = likely(d.ens, d.snow);
    const wh = lr && lr[1] >= 0.5 ? `<em style="bottom:${100 * lr[0] / max}%;height:${Math.max(1, 100 * (lr[1] - lr[0]) / max)}%"></em>` : '';
    const label = v >= 0.5 ? Math.round(v) + '"' : v > 0.05 ? 'T' : '';
    const tip = `${dow(d.date)} ${dom(d.date)}: ${v.toFixed(1)}"` + (lr ? `, likely ${Math.round(lr[0])}–${Math.round(lr[1])}"` : '');
    return `<div class="col${i === 0 ? ' today' : ''}${i === 5 || i === 10 ? ' wk' : ''}" title="${tip}">
      <span class="v">${label}</span>
      <div class="area"><i class="${v >= POWDER_IN - 0.5 ? 'powder' : ''}" style="height:${Math.max(1, 100 * v / max)}%"></i>${wh}</div>
      <span class="d">${i === 0 ? 'Tdy' : dow(d.date).slice(0, 2)}<br><b>${dom(d.date)}</b></span>
    </div>`;
  }).join('');
}

function renderTotals(b, data) {
  const tot = (a, z) => Math.round(b.days.slice(a, z).reduce((s, d) => s + (d.snow || 0), 0));
  const obs = snotelDaily(data.snotel);
  const last = obs.at(-1);
  $('totals').innerHTML = `
    <div class="obs"><b>${last ? last.gain + '"' : '–'}</b><span>Last 24h</span></div>
    <div><b>${tot(0, 5)}"</b><span>Next 5 days</span></div>
    <div><b>${tot(5, 10)}"</b><span>Days 6–10</span></div>
    <div><b>${tot(10, 15)}"</b><span>Days 11–15</span></div>`;
}

// The biggest run of consecutive 2"+ days in the next 15. A day under 2" ends a storm, so the 1–2"
// days the ensemble average spreads past day 7 do not chain into one long "storm"
function renderStorm(b) {
  const runs = [];
  let cur = null;
  b.days.forEach((d, i) => {
    if ((d.snow || 0) >= 2) {
      cur ||= { from: i, to: i, total: 0, peak: d, pow: 0 };
      cur.to = i; cur.total += d.snow;
      if (d.snow > cur.peak.snow) cur.peak = d;
      cur.pow = Math.max(cur.pow, d.ens?.pPowder ?? 0);
    } else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  const el = $('storm');
  if (!runs.length) { el.innerHTML = '<h2>Next storm</h2><div class="big">None</div><p>No day with 2"+ in the next 15 days.</p>'; return; }
  const s = runs.reduce((a, r) => r.total > a.total ? r : a);
  const first = b.days[s.from].date, last = b.days[s.to].date;
  const when = s.from === s.to ? `${dow(first)} ${dom(first)}` : `${dow(first)} ${dom(first)} – ${dow(last)} ${dom(last)}`;
  const inDays = s.from === 0 ? 'starts today' : s.from === 1 ? 'starts tomorrow' : `in ${s.from} days`;
  el.innerHTML = `<h2>${runs.length > 1 && s !== runs[0] ? 'Biggest storm' : 'Next storm'}</h2>
    <div class="big">${Math.round(s.total)}" <small>${when}</small></div>
    <p>${inDays}; most on <b>${dow(s.peak.date)}</b> (${Math.round(s.peak.snow)}")${s.pow >= 10 ? `. <span class="pow">${Math.round(s.pow)}% chance</span> of a 6"+ day` : ''}.</p>`;
}

function renderToday(b) {
  const day = b.periods.find(p => p.isDay && p.date === b.today), night = b.periods.find(p => !p.isDay && p.date === b.today);
  const el = $('today');
  const t = v => v == null ? '–' : Math.round(v) + '°';
  const lvl = day?.snowLevel ?? day?.fz;
  el.innerHTML = `<h2>Today at Alta</h2>
    <div class="big">${t(day?.tempF)} <small>/ ${t(night?.tempF)}</small></div>
    <p>Wind <b>${day?.ws == null ? '–' : SNOW.compass(day.wd) + ' ' + Math.round(day.ws)}</b> mph${day?.wg ? `, gusts ${Math.round(day.wg)}` : ''}${lvl ? ` · ${day?.snowLevel != null ? 'snow level' : 'freezing'} <b>${(Math.round(lvl / 100) * 100).toLocaleString()}′</b>` : ''}</p>`;
}

async function renderAvy() {
  const chip = $('avy-chip');
  try {
    const a = await fetchAvalanche();
    const lvl = a.zone?.level, dg = DANGER[lvl];
    chip.hidden = false;
    if (dg) {
      chip.style.cssText = `background:${dg.color};color:${dg.ink};${dg.border ? `border-color:${dg.border}` : ''}`;
      chip.innerHTML = `<span>Avalanche · Salt Lake</span><b>${lvl} ${dg.name}</b>`;
    } else {
      chip.style.cssText = 'background:var(--btn);color:var(--text);border-color:var(--line)';
      chip.innerHTML = '<span>Avalanche · Salt Lake</span><b>No rating yet</b>';
    }
  } catch {
    chip.hidden = true;   // no worker locally, or the feed is down: the chip just stays hidden
  }
}

async function load(force) {
  $('status').textContent = 'Loading forecast…';
  try {
    const raw = await fetchAll(force);
    const b = build(raw);
    renderChart(b);
    renderTotals(b, raw.data);
    renderStorm(b);
    renderToday(b);
    const t = new Date(raw.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('status').textContent = `15-day snow · 9,895 ft · updated ${t}`;
  } catch (e) {
    $('status').textContent = `Forecast unavailable: ${e.message}`;
  }
}

$('refresh').onclick = () => load(true);
load(false);
renderAvy();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
