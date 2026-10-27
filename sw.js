// Offline shell: the app's own pages and scripts come from the network when there is one and from
// this cache when there isn't. /api (live forecasts and avalanche data) is never cached here.
// Map tiles and map fonts go in a second cache, cache-first, so a tour viewed (or
// saved with "Save for offline") at home still draws with no signal on the skin track. The app's own
// terrain-class tiles (/tiles/) stay in the shell cache, so a rebuild replaces them.
const CACHE = 'atlas-shell-v4';
const TILES = 'atlas-tiles-v1';
const TILE_MAX = 12000;          // entries kept; the oldest go first past this
const SHELL = [
  './', 'index.html', 'home.css', 'home.js', 'backcountry.html', 'backcountry.css', 'app.css', 'app.js', 'dem.js', 'tile-worker.js',
  'risk.js', 'sun.js', 'avalanche.js', 'forecast.html', 'forecast.css', 'forecast.js', 'forecast-data.js', 'snow.js',
  'scorecard.html', 'scorecard.js', 'badge.svg', 'alta-mountain.svg', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png',
  'data/alta_calibration.json', 'data/avalanche_paths.geojson', 'data/uac_zones.geojson', 'data/uac_routes.json',
  'data/tours.geojson', 'data/nhd_streams.geojson', 'lib/maplibre-gl-5.24.0.js', 'lib/maplibre-gl-5.24.0.css',
];
const isTile = u => u.hostname === 'basemap.nationalmap.gov' || u.hostname === 'demotiles.maplibre.org'
  || (u.hostname === 's3.amazonaws.com' && u.pathname.startsWith('/elevation-tiles-prod/'));

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim())));

let puts = 0;
async function trim(c) {
  const keys = await c.keys();
  if (keys.length > TILE_MAX) await Promise.all(keys.slice(0, keys.length - TILE_MAX + 1000).map(k => c.delete(k)));
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (isTile(u)) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) { await c.put(e.request, r.clone()); if (++puts % 300 === 0) trim(c); }
      return r;
    }));
    return;
  }
  if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
