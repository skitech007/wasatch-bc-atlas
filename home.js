// Home: Alta 15-day snow (forecast-data.js does the maths) and today's avalanche danger chip.
const $ = id => document.getElementById(id);

function renderChart(b) {
  $('chart').innerHTML = snowBars(b.days);
  $('legend').innerHTML = snowLegend();
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

function renderStorm(b) {
  const el = $('storm');
  const s = biggestStorm(b.days);
  if (!s) { el.innerHTML = '<h2>Next storm</h2><div class="big">None</div><p>No day with 2"+ in the next 15 days.</p>'; return; }
  const inDays = s.from === 0 ? 'starts today' : s.from === 1 ? 'starts tomorrow' : `in ${s.from} days`;
  el.innerHTML = `<h2>${s.first ? 'Next storm' : 'Biggest storm'}</h2>
    <div class="big">${Math.round(s.total)}" <small>${s.when}</small></div>
    <p>${inDays}; most on <b>${dow(s.peak.date)}</b> (${Math.round(s.peak.snow)}")${s.pow >= 10 ? `. <span class="pow">${Math.round(s.pow)}% chance</span> of a 6"+ day` : ''}.</p>`;
}

function renderToday(b) {
  const { label, day, night } = dayAhead(b);
  const el = $('today');
  const t = v => v == null ? '–' : Math.round(v) + '°';
  const lvl = day?.snowLevel ?? day?.fz;
  el.innerHTML = `<h2>${label} at Alta</h2>
    <div class="big">${t(day?.tempF)} <small>/ ${t(night?.tempF)}</small></div>
    <p>Wind <b>${day?.ws == null ? '–' : SNOW.compass(day.wd) + ' ' + Math.round(day.ws)}</b> mph${day?.wg ? `, gusts ${Math.round(day.wg)}` : ''}${lvl ? ` · ${day?.snowLevel != null ? 'snow level' : 'freezing'} <b>${(Math.round(lvl / 100) * 100).toLocaleString()}′</b>` : ''}</p>
    <p><a href="https://www.alta.com/weather" target="_blank" rel="noopener">Snow stake &amp; cams on alta.com ↗</a></p>`;
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
