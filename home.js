// Home: avalanche row, Alta 15-day snow (forecast-data.js does the maths), next storm and today.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderChart(b, data) {
  $('chart').innerHTML = snowStrip(b.days, { last: snotelDaily(data.snotel).at(-1) ?? null, station: 'Atwater' });
  $('legend').innerHTML = snowLegend();
  fitStrips();
}

function renderStorm(b) {
  const el = $('storm');
  const s = biggestStorm(b.days);
  if (!s) { el.innerHTML = '<h2 class="eyebrow">Next storm</h2><div class="big">None</div><p>No day with 2"+ in the next 15 days.</p>'; return; }
  const inDays = s.from === 0 ? 'Starts today' : s.from === 1 ? 'Starts tomorrow' : `In ${s.from} days`;
  el.innerHTML = `<h2 class="eyebrow">${s.first ? 'Next storm' : 'Biggest storm'}</h2>
    <div class="big${s.total >= 6 ? ' pow' : ''}">${Math.round(s.total)}"</div><p class="when"><b>${s.when}</b></p>
    <p>${inDays}; most on <b>${dow(s.peak.date)}</b> (${Math.round(s.peak.snow)}")${s.pow >= 10 ? `. <span class="pow">${Math.round(s.pow)}% chance</span> of a 6"+ day` : ''}.</p>`;
}

function renderToday(b) {
  const { label, day, night } = dayAhead(b);
  const t = v => v == null ? '–' : Math.round(v) + '°';
  const lvl = day?.snowLevel ?? day?.fz;
  $('today').innerHTML = `<h2 class="eyebrow">${label} at Alta</h2>
    <div class="big">${t(day?.tempF)} <small>/ ${t(night?.tempF)}</small></div>
    <p>Wind <b>${day?.ws == null ? '–' : SNOW.compass(day.wd) + ' ' + Math.round(day.ws)}</b> mph${day?.wg ? `, gusts ${Math.round(day.wg)}` : ''}${lvl ? ` · <span class="nw">${day?.snowLevel != null ? 'snow level' : 'freezing'} <b>${(Math.round(lvl / 100) * 100).toLocaleString()}′</b></span>` : ''}</p>`;
}

async function renderAvy() {
  const row = $('avy'), dot = row.querySelector('.avy-dot'), name = $('avy-name');
  try {
    const a = await fetchAvalanche();
    const lvl = a.zone?.level, dg = DANGER[lvl];
    if (dg) {
      dot.style.cssText = `background:${dg.color};color:${dg.ink};${dg.border ? `box-shadow:inset 0 0 0 2px ${dg.border}` : ''}`;
      dot.textContent = lvl;
      name.innerHTML = `${dg.name} danger`;
    } else {
      dot.style.cssText = ''; dot.textContent = '–';
      name.innerHTML = 'No rating issued yet<small>UAC rates daily once the season starts</small>';
    }
  } catch {
    dot.style.cssText = ''; dot.innerHTML = ICON.alert;
    name.innerHTML = 'Rating unavailable<small>Open the UAC forecast from the Backcountry map</small>';
  }
}

const clock = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function show(raw) {
  const b = build(raw);
  renderChart(b, raw.data);
  renderStorm(b);
  renderToday(b);
  $('status').textContent = raw.saved ? `9,895 ft · saved ${clock(raw.at)} · updating…` : `9,895 ft · ${clock(raw.at)}`;
  const down = Object.keys(raw.errors || {}).filter(k => k !== 'corrections');
  $('snow-error').innerHTML = down.length ? `<div class="banner warn">${ICON.alert}<div><b>Some sources didn't answer</b>${esc(down.join(', '))}. The rest of the blend is shown.</div></div>` : '';
}

async function load(force) {
  const btn = $('refresh');
  btn.classList.add('spin'); btn.disabled = true;
  $('snow-error').innerHTML = '';
  let saved = null;   // drawn first if the last forecast is too old to reuse, then replaced
  try {
    show(await fetchAll(force, 'alta', s => { saved = s; show(s); }));
  } catch (e) {
    const off = navigator.onLine === false;
    if (saved) {
      $('status').textContent = `9,895 ft · saved ${clock(saved.at)}`;
      $('snow-error').innerHTML = `<div class="banner info">${ICON[off ? 'wifiOff' : 'alert']}<div><b>${off ? 'No signal' : 'Couldn\'t update'}</b>Showing the forecast saved at ${clock(saved.at)}.</div></div>`;
      return;
    }
    $('status').textContent = 'Unavailable';
    $('chart').innerHTML = '';
    $('snow-error').innerHTML = `<div class="banner ${off ? 'info' : 'danger'}">${ICON[off ? 'wifiOff' : 'alert']}<div><b>${off ? 'No signal' : 'Forecast unavailable'}</b>${off ? 'The forecast loads when you are back in coverage.' : esc(e.message)}</div></div>`;
    ['storm', 'today'].forEach(id => { $(id).querySelectorAll('.skeleton').forEach(s => s.remove()); });
  } finally {
    btn.classList.remove('spin'); btn.disabled = false;
  }
}

$('refresh').onclick = () => load(true);
load(false);
renderAvy();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
