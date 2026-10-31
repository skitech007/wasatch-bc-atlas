// Resorts list: one card per resort, like a favourites page. Starred resorts sort to the top; each card
// opens that resort's full forecast (forecast.html?r=<id>). Data and maths come from forecast-data.js.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ft = v => Math.round(v).toLocaleString('en-US');
const deg = v => v == null ? '–' : Math.round(v) + '°';
const MONO = { alta: 'AL', snowbird: 'SB', brighton: 'BR', solitude: 'SO' };

const FAV_KEY = 'wbca.favResorts';
const favs = () => { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; } };
const setFavs = f => { try { localStorage.setItem(FAV_KEY, JSON.stringify(f)); } catch { /* private mode: stars just don't stick */ } };

let resorts = [];
const got = {};   // id -> { raw, b } or { error }

const order = () => {
  const f = favs();
  return [...resorts].sort((a, b) => (f.includes(b.id) - f.includes(a.id)) || resorts.indexOf(a) - resorts.indexOf(b));
};
const shortDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function cardBody(r) {
  const x = got[r.id];
  if (!x) return '<div class="rc-wait" aria-busy="true"><div class="skeleton sk-line" style="width:60%"></div><div class="skeleton" style="height:92px"></div></div>';
  if (x.error) return `<div class="banner warn rc-wait">${ICON.alert}<div><b>Forecast unavailable</b>${esc(x.error)}</div></div>`;
  const { raw, b } = x;
  const last = snotelDaily(raw.data.snotel).at(-1);
  const tot = (a, z) => Math.round(b.days.slice(a, z).reduce((s, d) => s + (d.snow || 0), 0));
  const { label, day, night } = dayAhead(b);
  const st = biggestStorm(b.days);
  const n5 = tot(0, 5);
  const cell = (v, l, c = '') => `<div class="stat-cell ${c}"><b>${v}</b><span>${l}</span></div>`;
  return `<div class="stats-row">${cell(last ? last.gain + '"' : '–', 'Last 24 h', 'dim')}${cell(n5 + '"', 'Next 5 days', n5 >= 12 ? 'pow' : '')}${cell(tot(5, 10) + '"', 'Days 6\u2060–\u206010')}${cell(tot(10, 15) + '"', 'Days 11\u2060–\u206015')}</div>
    ${snowBars(b.days, { compact: true })}
    <p class="rc-line">${st ? `<span class="${st.total >= 6 ? 'pow' : ''}">${st.first ? 'Next storm' : 'Biggest storm'} <b>${Math.round(st.total)}"</b> ${st.when}</span>` : '<span>No storm in 15 days</span>'}<span>${label} <b>${deg(day?.tempF)}</b> / ${deg(night?.tempF)}${day?.ws != null ? ` · ${SNOW.compass(day.wd)} ${Math.round(day.ws)} mph` : ''}</span></p>`;
}

function render() {
  const f = favs(), today = localKey(new Date()).slice(0, 10);
  $('list').innerHTML = order().map(r => {
    const star = f.includes(r.id);
    const opening = !r.opening ? 'Opening TBA' : r.opening > today ? `Opens ${shortDate(r.opening)}` : '';
    return `<article class="rcard">
      <a class="rc-link" href="forecast.html?r=${r.id}" aria-label="${esc(r.name)} full forecast"></a>
      <header>
        <span class="mono ${r.canyon === 'Little Cottonwood' ? 'lcc' : 'bcc'}" aria-hidden="true">${MONO[r.id] || ''}</span>
        <div class="rc-name"><h2>${esc(r.name)}${opening ? ` <span class="pill warn">${opening}</span>` : ''}</h2><p>${esc(r.canyon)} · forecast at ${ft(r.point.ft)} ft</p></div>
        <button class="icon-btn star${star ? ' on' : ''}" data-star="${r.id}" aria-pressed="${star}" aria-label="${star ? 'Unstar' : 'Star'} ${esc(r.name)}">${ICON.star}</button>
      </header>
      ${cardBody(r)}
    </article>`;
  }).join('');
}

async function load(force) {
  $('status').textContent = 'Loading forecasts…';
  $('refresh').classList.add('spin');
  try { resorts = await loadResorts(); } catch (e) { $('status').textContent = `Couldn't load the resort list: ${e.message}`; $('refresh').classList.remove('spin'); return; }
  if (force) resorts.forEach(r => delete got[r.id]);
  render();
  await Promise.all(resorts.map(r => fetchAll(force, r.id)
    .then(raw => { got[r.id] = { raw, b: build(raw) }; })
    .catch(e => { got[r.id] = { error: e.message }; })
    .finally(render)));
  const ok = resorts.filter(r => got[r.id]?.raw);
  const at = Math.min(...ok.map(r => got[r.id].raw.at));
  $('refresh').classList.remove('spin');
  $('status').textContent = ok.length ? `Cottonwood Canyons · updated ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Forecasts unavailable';
}

$('list').addEventListener('click', ev => {
  const btn = ev.target.closest('[data-star]');
  if (!btn) return;
  const id = btn.dataset.star, f = favs();
  setFavs(f.includes(id) ? f.filter(x => x !== id) : [...f, id]);
  render();
});
$('refresh').onclick = () => load(true);
$('legend').innerHTML = snowLegend();
load(false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
