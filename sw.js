// Offline shell: the app's own pages and scripts come from the network when there is one and from
// this cache when there isn't. Live data (forecasts, tiles, /api) is never cached here.
const CACHE = 'atlas-shell-v2';
const SHELL = [
  './', 'index.html', 'home.css', 'home.js', 'backcountry.html', 'backcountry.css', 'app.css', 'app.js', 'dem.js', 'tile-worker.js',
  'risk.js', 'sun.js', 'avalanche.js', 'forecast.html', 'forecast.css', 'forecast.js', 'forecast-data.js', 'snow.js',
  'scorecard.html', 'scorecard.js', 'badge.svg', 'alta-mountain.svg', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png',
  'data/alta_calibration.json', 'data/avalanche_paths.geojson', 'data/uac_zones.geojson', 'data/uac_routes.json',
  'data/lcc_tours.geojson', 'data/nhd_streams.geojson',
];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
