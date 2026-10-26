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
    <div class="obs"><b>${last ? last.gain + '"' : '–'}</b><span>Last 24h${last ? ` · ${last.depth ?? '–'}" base` : ''}</span></div>
    <div><b>${tot(0, 5)}"</b><span>Next 5 days</span></div>
    <div><b>${tot(5, 10)}"</b><span>Days 6–10</span></div>
    <div><b>${tot(10, 15)}"</b><span>Days 11–15</span></div>`;
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
