// Resorts list: one card per resort, like a favourites page. Starred resorts sort to the top; each card
// opens that resort's full forecast (forecast.html?r=<id>). Data and maths come from forecast-data.js.
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ft = v => Math.round(v).toLocaleString('en-US');

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
  return snowStrip(b.days, { last: snotelDaily(raw.data.snotel).at(-1) ?? null, station: r.snotel.name, numbers: false });
}

function render() {
  const f = favs(), today = localKey(new Date()).slice(0, 10);
  // Keep each strip where it was swiped to when the list redraws as forecasts arrive
  const kept = Object.fromEntries([...document.querySelectorAll('.rcard')].map(c => [c.dataset.id, c.querySelector('.st-scroll')?.scrollLeft || 0]));
  $('list').innerHTML = order().map(r => {
    const star = f.includes(r.id);
    const opening = !r.opening ? 'Opening TBA' : r.opening > today ? `Opens ${shortDate(r.opening)}` : '';
    return `<article class="rcard" data-id="${r.id}">
      <a class="rc-link" href="forecast.html?r=${r.id}" aria-label="${esc(r.name)} full forecast"></a>
      <header>
        ${resortBadge(r)}
        <div class="rc-name"><div class="rc-title"><h2>${esc(r.name)}</h2>${opening ? `<span class="pill warn">${opening}</span>` : ''}</div><p>${ft(r.point.ft)} ft · ${esc(r.canyon)}</p></div>
        <button class="icon-btn star${star ? ' on' : ''}" data-star="${r.id}" aria-pressed="${star}" aria-label="${star ? 'Unstar' : 'Star'} ${esc(r.name)}">${ICON.star}</button>
      </header>
      ${cardBody(r)}
    </article>`;
  }).join('');
  document.querySelectorAll('.rcard').forEach(c => { const s = c.querySelector('.st-scroll'); if (s) s.scrollLeft = kept[c.dataset.id] || 0; });
  fitStrips();
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
  $('status').innerHTML = ok.length ? `<span class="part">Cottonwood Canyons</span><span class="part">updated ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>` : 'Forecasts unavailable';
}

$('list').addEventListener('click', ev => {
  const btn = ev.target.closest('[data-star]');
  // The strip sits above the card's link so it can be swiped; a tap on it still opens the forecast
  if (!btn) { const card = ev.target.closest('.strip') && ev.target.closest('.rcard'); if (card) location.href = card.querySelector('.rc-link').href; return; }
  const id = btn.dataset.star, f = favs();
  setFavs(f.includes(id) ? f.filter(x => x !== id) : [...f, id]);
  render();
});
$('refresh').onclick = () => load(true);
$('legend').innerHTML = snowLegend();
load(false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
