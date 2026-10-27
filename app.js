/* Wasatch BC Atlas — MapLibre GL 5.24
 * Every number shown comes from a cited source: AWS Terrain Tiles (USGS 3DEP)
 * for elevation, slope and aspect; UGRC/SGID for avalanche paths and zones;
 * UAC route pages for route ratings.
 */
'use strict';

const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';

/* ---------- storage (best effort) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('wbca.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wbca.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ---------- when the map can't draw, say why instead of leaving a dark screen ---------- */
function mapError(html) {
  const el = document.getElementById('map-error');
  el.innerHTML = html + '<button type="button" onclick="location.reload()">Reload</button>';
  el.hidden = false;
}
const WEBGL_HELP = `<b>The map can't draw: 3D graphics (WebGL) are switched off in this browser for this page.</b>
  <p>Chrome switches WebGL off for a site after a graphics crash; quitting and reopening Chrome clears that.
  If the map is still blank, turn on Settings → System → <i>Use graphics acceleration when available</i> and relaunch.
  <code>chrome://gpu</code> should list WebGL as “Hardware accelerated”.</p>`;
if (typeof maplibregl === 'undefined') {
  mapError('<b>The map library didn’t load.</b><p>You may be offline, or an extension or network filter blocked it.</p>');
  throw new Error('MapLibre did not load');
}

/* ---------- analysis tiles: wbca://mode/z/x/y?k=mask&s=minSlope, rendered in workers ---------- */
const workers = Array.from({ length: Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)) }, () => new Worker('tile-worker.js'));
const pending = new Map();
let jobId = 0;
workers.forEach(w => w.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.error ? p.reject(new Error(data.error)) : p.resolve({ data: data.png });
});
maplibregl.addProtocol('wbca', (params, abort) => {
  const u = new URL(params.url.replace('wbca://', 'http://x/'));
  const [, mode, z, x, y] = u.pathname.split('/');
  const id = ++jobId;
  // same tile column/row always goes to the same worker so its DEM cache gets reused
  const w = workers[(+x * 7 + +y * 13) % workers.length];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    abort.signal.addEventListener('abort', () => { pending.delete(id); reject(new DOMException('aborted', 'AbortError')); });
    w.postMessage({ id, mode, z: +z, x: +x, y: +y, mask: +(u.searchParams.get('k') || 0), minSlope: +(u.searchParams.get('s') || 30) });
  });
});

/* ---------- point sampling ---------- */
function lngLatToTile(lng, lat, z) {
  const n = 2 ** z, lr = lat * Math.PI / 180;
  const fx = (lng + 180) / 360 * n;
  const fy = (1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n;
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, q: Math.min(255, Math.floor((fx - x) * 256)), r: Math.min(255, Math.floor((fy - y) * 256)) };
}

async function sampleAt(lng, lat, z = SAMPLE_Z) {
  const t = lngLatToTile(lng, lat, z);
  const g = await paddedGrid(z, t.x, t.y);
  if (!g) return null;
  const i = (t.r + 1) * 258 + (t.q + 1);
  const [slope, aspect] = hornAt(g, i, cellSize(z, t.y, t.r));
  return { elev: g[i], slope, aspect };
}

/* ---------- geometry helpers ---------- */
function haversine(a, b) {
  const R = 6371008.8, toR = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toR, dLng = (b[0] - a[0]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function densify(coords, step = 15) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    if (i === 0) { out.push(coords[0]); continue; }
    const a = coords[i - 1], b = coords[i], d = haversine(a, b);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return out;
}

function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));
}
function bboxOf(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = c => { if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else c.forEach(walk); };
  walk(geom.coordinates);
  return b;
}

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const aspectLabel = a => isNaN(a) ? 'flat' : `${ASPECTS[sectorOf(a)]} (${fmt(a)}°)`;

/* ---------- state ---------- */
const state = {
  mode: store.get('mode', 'slope'),
  mask: store.get('mask', 0),
  minSlope: store.get('minSlope', 30),
  route: store.get('route', []),
  routeName: store.get('routeName', null),
  pins: store.get('pins', []),
  tours: null,
  streams: null,
  drawing: false,
  pinning: false,
  avyPaths: null,
  zones: null,
};

/* ---------- map ---------- */
const BASEMAPS = {
  topo: `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`,
  imagerytopo: `${USGS}/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}`,
  imagery: `${USGS}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`,
};

let map;
try { map = new maplibregl.Map({
  container: 'map',
  center: store.get('center', [-111.655, 40.595]),
  zoom: store.get('zoom', 12.3),
  pitch: store.get('pitch', 55),
  bearing: store.get('bearing', 15),
  maxPitch: 80,
  hash: false,
  attributionControl: { compact: true },
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      base: { type: 'raster', tiles: [BASEMAPS.topo], tileSize: 256, maxzoom: 16, attribution: '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank">USGS The National Map</a>' },
      dem: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAX_Z, attribution: '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">AWS Terrain Tiles / USGS 3DEP</a>' },
      demhs: { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAX_Z },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#1a2028' } },
      { id: 'base', type: 'raster', source: 'base' },
      { id: 'hillshade', type: 'hillshade', source: 'demhs', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#26303a' } },
    ],
    sky: { 'sky-color': '#9cc3e6', 'horizon-color': '#dfe9f2', 'fog-color': '#dfe9f2', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 },
  },
}); } catch (e) {
  mapError(/webgl/i.test(e.message) ? WEBGL_HELP : `<b>The map couldn’t start.</b><p>${esc(e.message)}</p>`);
  throw e;
}
// The graphics card can drop the map mid-session (out of memory, a GPU reset). MapLibre 5.24's own
// recovery throws and comes back without the slope shading, so ask for a reload instead.
map.on('webglcontextlost', () => mapError('<b>The graphics card dropped the map.</b><p>Reload to redraw it. Your route, tour, pins and view are kept.</p>'));
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');

function analysisTiles() {
  const q = state.mode === 'match' ? `?k=${state.mask}&s=${state.minSlope}` : '';
  return [`wbca://${state.mode}/{z}/{x}/{y}${q}`];
}

map.once('style.load', async () => {
  map.setTerrain({ source: 'dem', exaggeration: +document.getElementById('exag').value });

  map.addSource('analysis', { type: 'raster', tiles: analysisTiles(), tileSize: 256, minzoom: 11, maxzoom: DEM_MAX_Z });
  map.addLayer({ id: 'analysis', type: 'raster', source: 'analysis', paint: { 'raster-opacity': 0.6, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } });
  // Avalanche terrain tiles from tools/terrain_wasatch.py (zooms 11–14, over-zoomed above)
  for (const id of ['ates', 'runout']) {
    map.addSource(id, { type: 'raster', tiles: [`wbca://${id}/{z}/{x}/{y}`], tileSize: 256, minzoom: RUNOUT_MIN_Z, maxzoom: RUNOUT_MAX_Z });
    map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } });
  }

  const [paths, zones] = await Promise.all([
    fetch('data/avalanche_paths.geojson').then(r => r.json()),
    fetch('data/uac_zones.geojson').then(r => r.json()),
  ]);
  state.avyPaths = paths;
  state.zones = zones;
  paths.features.forEach(f => { f.bbox = bboxOf(f.geometry); });
  zones.features.forEach(f => { f.bbox = bboxOf(f.geometry); });

  map.addSource('zones', { type: 'geojson', data: zones });
  map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': '#5fb3ff', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } });
  map.addSource('zone-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: zones.features.map(f => ({ type: 'Feature', properties: f.properties, geometry: { type: 'Point', coordinates: labelPoint(f) } })) } });
  map.addLayer({ id: 'zones-label', type: 'symbol', source: 'zone-labels', layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 13 }, paint: { 'text-color': '#cfe6ff', 'text-halo-color': '#0b1a2a', 'text-halo-width': 1.5 } });

  map.addSource('avy', { type: 'geojson', data: paths, generateId: true });
  map.addLayer({ id: 'avy-fill', type: 'fill', source: 'avy', paint: { 'fill-color': '#ff3b6b', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.35, 0.14] } });
  map.addLayer({ id: 'avy-line', type: 'line', source: 'avy', paint: { 'line-color': '#ff3b6b', 'line-width': 1.2, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'avy-label', type: 'symbol', source: 'avy', minzoom: 13, filter: ['has', 'name'], layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 11, 'symbol-placement': 'point' }, paint: { 'text-color': '#ffd6df', 'text-halo-color': '#3a0010', 'text-halo-width': 1.2 } });

  map.addSource('tours', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'tours-line', type: 'line', source: 'tours', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#c084fc', 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'tours-hit', type: 'line', source: 'tours', paint: { 'line-color': '#000', 'line-width': 16, 'line-opacity': 0 } });
  map.addLayer({ id: 'tours-label', type: 'symbol', source: 'tours', minzoom: 12, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Open Sans Semibold'], 'text-size': 12 }, paint: { 'text-color': '#ecd9ff', 'text-halo-color': '#2a0a3a', 'text-halo-width': 1.4 } });

  map.addSource('tour-marks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'tour-marks-dot', type: 'circle', source: 'tour-marks', paint: { 'circle-radius': ['match', ['get', 'kind'], 'death', 4, 5], 'circle-color': ['match', ['get', 'kind'], 'death', '#2b0a12', '#ffffff'], 'circle-stroke-color': ['match', ['get', 'kind'], 'death', '#ff6b8a', '#7c3aed'], 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'tour-marks-label', type: 'symbol', source: 'tour-marks', layout: { 'text-field': ['case', ['==', ['get', 'kind'], 'death'], ['concat', '† ', ['get', 'name']], ['get', 'name']], 'text-font': ['Open Sans Semibold'], 'text-size': ['match', ['get', 'kind'], 'death', 10, 12], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': ['match', ['get', 'kind'], 'death', '#ffb3c2', '#ffffff'], 'text-halo-color': '#1a0a2a', 'text-halo-width': 1.5 } });

  map.addSource('route', { type: 'geojson', data: routeGeoJSON() });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0b0f14', 'line-width': 6 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffcf4a', 'line-width': 3 } });
  map.addLayer({ id: 'route-pts', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#ffcf4a', 'circle-stroke-color': '#0b0f14', 'circle-stroke-width': 1.5 } });

  bindUI();
  applyLayerToggles();
  refreshAnalysis();
  renderLegend();
  renderPins();
  updateRoute();
  loadUacRoutes();
  loadTours();
  loadAltaSnow();
  fetch('data/nhd_streams.geojson').then(r => r.json()).then(g => {
    state.streams = g.features.flatMap(f => (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates])
      .map(line => ({ name: f.properties.name, line, bbox: bboxOf({ coordinates: line }) })));
    if (state.route.length > 1) updateRoute();
  }).catch(() => {});
  if (location.hash === '#avalanche') globalThis.openAvalanche?.();
});

/* hover / click on avalanche paths and zones */
let hoverId = null;
map.on('mousemove', 'avy-fill', e => {
  if (state.drawing || state.pinning) return;
  map.getCanvas().style.cursor = 'pointer';
  const id = e.features[0].id;
  if (hoverId !== null && hoverId !== id) map.setFeatureState({ source: 'avy', id: hoverId }, { hover: false });
  hoverId = id;
  map.setFeatureState({ source: 'avy', id }, { hover: true });
});
map.on('mouseleave', 'avy-fill', () => {
  if (!state.drawing && !state.pinning) map.getCanvas().style.cursor = '';
  if (hoverId !== null) map.setFeatureState({ source: 'avy', id: hoverId }, { hover: false });
  hoverId = null;
});

map.on('click', e => {
  if (state.drawing) { addRoutePoint([e.lngLat.lng, e.lngLat.lat]); return; }
  if (state.pinning) { addPin(e.lngLat); return; }
  const tourHit = map.getLayer('tours-hit') && map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ['tours-hit'] })[0];
  if (tourHit) { selectTour(tourHit.properties.id); return; }
  const feats = map.queryRenderedFeatures(e.point, { layers: ['avy-fill', 'zones-line'].filter(l => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') });
  const avy = feats.find(f => f.layer.id === 'avy-fill');
  if (avy) {
    const p = avy.properties;
    const rows = [['Size', p.size], ['Return interval', p.return_interval], ['Start zone elev', p.start_elev], ['Vertical fall', p.vertical_fall], ['Start zone aspect', p.start_aspect]]
      .filter(([, v]) => v).map(([k, v]) => `<div>${k}: <b>${esc(v)}</b></div>`).join('');
    new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat)
      .setHTML(`<b>${esc(p.name || 'Unnamed avalanche path')}</b>${rows || '<div class="muted">No more attributes in the source data.</div>'}<div class="muted small" style="margin-top:4px">Source: SGID Avalanche Paths (1989)</div>`)
      .addTo(map);
    return;
  }
});
// one label per zone: the centre of the bbox if it falls inside, else the widest horizontal chord through it
function labelPoint(f) {
  const b = f.bbox, c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (inPolygon(c, f.geometry)) return c;
  let best = c, bestW = 0;
  for (let k = 1; k < 20; k++) {
    const lat = b[1] + (b[3] - b[1]) * k / 20;
    let run = 0, start = null;
    for (let j = 0; j <= 100; j++) {
      const lng = b[0] + (b[2] - b[0]) * j / 100, on = inPolygon([lng, lat], f.geometry);
      if (on && start === null) start = lng;
      if ((!on || j === 100) && start !== null) { const w = lng - start; if (w > bestW) { bestW = w; best = [(start + lng) / 2, lat]; } start = null; }
    }
  }
  return best;
}
const inBbox = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];

/* cursor readout */
const readout = document.getElementById('readout');
let readoutSeq = 0, readoutTimer = null;
map.on('mousemove', e => {
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(async () => {
    const seq = ++readoutSeq;
    const s = await sampleAt(e.lngLat.lng, e.lngLat.lat);
    if (seq !== readoutSeq || !s) return;
    const zone = state.zones && state.zones.features.find(f => inBbox([e.lngLat.lng, e.lngLat.lat], f.bbox) && inPolygon([e.lngLat.lng, e.lngLat.lat], f.geometry));
    readout.textContent = `${fmt(s.elev * FT)} ft · ${fmt(s.slope)}° · ${aspectLabel(s.aspect)}${zone ? ' · UAC ' + zone.properties.name : ''}`;
  }, 60);
});
map.on('mouseout', () => { readout.textContent = ''; });

map.on('moveend', () => {
  const c = map.getCenter();
  store.set('center', [+c.lng.toFixed(5), +c.lat.toFixed(5)]);
  store.set('zoom', +map.getZoom().toFixed(2));
  store.set('pitch', +map.getPitch().toFixed(1));
  store.set('bearing', +map.getBearing().toFixed(1));
  document.getElementById('zoom-hint').hidden = map.getZoom() >= 11 || state.mode === 'none';
});

/* ---------- UI ---------- */
function bindUI() {
  const $ = id => document.getElementById(id);

  bindSheet();
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.onclick = () => openTab(b.dataset.tab));
  openTab(store.get('tab', 'tours'), false);
  $('guide-jump').onclick = () => {
    const tab = $('tab-plan');
    if ($('panel').dataset.state === 'peek') setSheet('half');
    tab.scrollTo({ top: $('tour-guide').offsetTop - 8, behavior: 'smooth' });
  };

  $('pace').value = String(store.get('pace', 1000));
  $('pace').onchange = () => { store.set('pace', +$('pace').value); updateRoute(); renderTours(); };
  $('start-time').value = store.get('startTime', '07:00');
  $('start-time').onchange = () => { store.set('startTime', $('start-time').value); updateRoute(); };

  $('light').value = store.get('light', 'map');
  $('light-time').value = store.get('lightTime', localDateTimeValue(new Date()));
  $('light').onchange = () => { store.set('light', $('light').value); applyLight(); };
  $('light-time').onchange = () => { store.set('lightTime', $('light-time').value); applyLight(); };
  applyLight();
  setInterval(() => { if ($('light').value === 'now') applyLight(); }, 5 * 60e3);

  $('basemap').value = store.get('basemap', 'topo');
  $('basemap').onchange = () => { store.set('basemap', $('basemap').value); map.getSource('base').setTiles([BASEMAPS[$('basemap').value]]); };
  map.getSource('base').setTiles([BASEMAPS[$('basemap').value]]);

  $('exag').oninput = () => {
    $('exag-out').textContent = (+$('exag').value).toFixed(1) + '×';
    if ($('terrain3d').checked) map.setTerrain({ source: 'dem', exaggeration: +$('exag').value });
  };
  $('terrain3d').onchange = () => {
    map.setTerrain($('terrain3d').checked ? { source: 'dem', exaggeration: +$('exag').value } : null);
    if (!$('terrain3d').checked) map.easeTo({ pitch: 0 });
  };
  ['hillshade', 'avypaths', 'zones', 'ates', 'runout'].forEach(id => {
    $(id).checked = store.get('layer.' + id, $(id).checked);
    $(id).onchange = () => { store.set('layer.' + id, $(id).checked); applyLayerToggles(); };
  });

  document.querySelectorAll('input[name=mode]').forEach(r => {
    r.checked = r.value === state.mode;
    r.onchange = () => { state.mode = r.value; store.set('mode', state.mode); refreshAnalysis(); };
  });
  $('opacity').oninput = () => map.setPaintProperty('analysis', 'raster-opacity', +$('opacity').value);

  $('minslope').value = state.minSlope;
  $('minslope').onchange = () => {
    state.minSlope = Math.min(50, Math.max(20, +$('minslope').value || 30));
    $('minslope').value = state.minSlope;
    store.set('minSlope', state.minSlope); refreshAnalysis();
  };
  buildRose();
  document.querySelectorAll('[data-rose]').forEach(b => b.onclick = () => {
    const k = b.dataset.rose;
    if (k === 'all') state.mask = 0xffffff;
    if (k === 'none') state.mask = 0;
    if (k === 'north') { state.mask = 0; for (let band = 0; band < 3; band++) for (const s of [7, 0, 1, 2]) state.mask |= 1 << (band * 8 + s); }
    if (k === 'upper') state.mask = 0xff << 16;
    roseChanged();
  });

  $('draw-btn').onclick = () => setDrawing(!state.drawing);
  $('pin-btn').onclick = () => setPinning(!state.pinning);
  $('undo-btn').onclick = () => { state.route.pop(); updateRoute(); };
  $('clear-btn').onclick = () => {
    if (state.route.length && !confirm('Clear the current route?')) return;
    state.route = []; state.routeName = null; state.tourId = null; markTour(null); updateRoute(); renderGuide();
  };
  $('gpx-out').onclick = exportGPX;
  $('gpx-in').onchange = e => { const f = e.target.files[0]; if (f) f.text().then(importGPX); e.target.value = ''; };

  document.addEventListener('keydown', e => {
    if (!state.drawing || e.target.matches('input, select, textarea')) return;
    if (e.key === 'Enter' || e.key === 'Escape') setDrawing(false);
    if (e.key === 'Backspace') { e.preventDefault(); state.route.pop(); updateRoute(); }
  });

  document.querySelectorAll('#rating-filter input').forEach(i => i.onchange = renderUacList);
}

/* ---------- panel: tabs, and the bottom sheet on phones ---------- */
function openTab(name, expand = true) {
  if (!document.getElementById('tab-' + name)) name = 'tours';
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + name; });
  store.set('tab', name);
  const sheet = document.getElementById('panel');
  if (expand && sheet.dataset.state === 'peek') setSheet('half');
}
function setSheet(st) {
  document.getElementById('panel').dataset.state = st;
  store.set('sheet', st);
}
function bindSheet() {
  const sheet = document.getElementById('panel'), handle = document.getElementById('sheet-handle');
  const order = ['peek', 'half', 'full'];
  sheet.dataset.state = store.get('sheet', 'peek');
  let startY = null, startT = 0, moved = false;
  const offsetOf = () => {
    const m = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
    return m.m42;
  };
  handle.addEventListener('pointerdown', e => {
    startY = e.clientY; startT = offsetOf(); moved = false;
    handle.setPointerCapture(e.pointerId); sheet.classList.add('dragging');
  });
  handle.addEventListener('pointermove', e => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    sheet.style.transform = `translateY(${Math.max(0, startT + dy)}px)`;
  });
  const end = e => {
    if (startY == null) return;
    sheet.classList.remove('dragging'); sheet.style.transform = '';
    const dy = e.clientY - startY; startY = null;
    const i = order.indexOf(sheet.dataset.state);
    if (!moved) setSheet(order[(i + 1) % 3]);
    else if (dy < -40) setSheet(order[Math.min(2, i + 1)]);
    else if (dy > 40) setSheet(order[Math.max(0, i - 1)]);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* ---------- hillshade light: map convention or the real sun ---------- */
const localDateTimeValue = d => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
function applyLight() {
  const mode = document.getElementById('light').value, note = document.getElementById('light-note');
  document.getElementById('light-time').hidden = mode !== 'time';
  if (mode === 'map') {
    map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'viewport');
    map.setPaintProperty('hillshade', 'hillshade-illumination-direction', 335);
    note.innerHTML = 'Maps light terrain from the northwest so ridges read correctly. In the northern hemisphere the real sun comes from the south, so pick <b>Real sun</b> to see which slopes are actually being warmed.';
    return;
  }
  const when = mode === 'now' ? new Date() : new Date(document.getElementById('light-time').value);
  if (isNaN(when)) return;
  const c = map.getCenter(), sun = sunPosition(when, c.lat, c.lng);
  map.setPaintProperty('hillshade', 'hillshade-illumination-anchor', 'map');
  map.setPaintProperty('hillshade', 'hillshade-illumination-direction', Math.round(sun.azimuth));
  try { map.setPaintProperty('hillshade', 'hillshade-illumination-altitude', Math.max(1, Math.round(sun.altitude))); } catch { /* older style spec */ }
  const t = when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  note.innerHTML = sun.altitude <= 0
    ? `${t}: the sun is below the horizon. Shading shows where it set.`
    : `${t}: sun ${Math.round(sun.altitude)}° up, from the ${ASPECTS[sectorOf(sun.azimuth)]} (${Math.round(sun.azimuth)}°). Bright slopes are the ones it is warming. Position from the US Naval Observatory's approximate formula.`;
}

function applyLayerToggles() {
  const vis = (ids, on) => ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  vis(['hillshade'], document.getElementById('hillshade').checked);
  vis(['avy-fill', 'avy-line', 'avy-label'], document.getElementById('avypaths').checked);
  vis(['zones-line', 'zones-label'], document.getElementById('zones').checked);
  vis(['ates'], document.getElementById('ates').checked);
  vis(['runout'], document.getElementById('runout').checked);
  document.getElementById('ates-key').hidden = !document.getElementById('ates').checked;
  document.getElementById('runout-key').hidden = !document.getElementById('runout').checked;
}

function refreshAnalysis() {
  map.setLayoutProperty('analysis', 'visibility', state.mode === 'none' ? 'none' : 'visible');
  if (state.mode !== 'none') map.getSource('analysis').setTiles(analysisTiles());
  document.getElementById('zoom-hint').hidden = map.getZoom() >= 11 || state.mode === 'none';
  renderLegend();
}

function renderLegend() {
  const el = document.getElementById('legend');
  const sw = c => `<i style="background:rgb(${c.join(',')})"></i>`;
  if (state.mode === 'slope') el.innerHTML = SLOPE_CLASSES.map(([, , c, l]) => sw(c) + `<span>${l}</span>`).join('');
  else if (state.mode === 'aspect') el.innerHTML = ASPECTS.map((a, i) => sw(ASPECT_COLORS[i]) + `<span>${a}</span>`).join('') + '<span></span><span class="muted">slopes of 10° or more</span>';
  else if (state.mode === 'match') {
    const n = popcount(state.mask);
    el.innerHTML = sw(MATCH_COLOR) + `<span>≥ ${state.minSlope}° and in a rose band you picked (${n}/24 picked)</span>` + (n ? '' : '<span></span><span class="muted">Nothing picked: tap the rose.</span>');
  } else if (state.mode === 'safe') {
    el.innerHTML = sw(SAFE_COLOR) + `<span>Under ${SAFE_MAX_SLOPE}° and outside every runout reach (nothing steep above). Cody's terrain for high-danger days.</span>`
      + '<span></span><span class="muted">Only drawn inside the terrain model (Millcreek to Alta). No shading ≠ safe: it means not checked or not low-angle.</span>';
  } else el.innerHTML = '';
}
function setMode(mode) {
  state.mode = mode; store.set('mode', mode);
  const r = document.querySelector(`input[name=mode][value=${mode}]`);
  if (r) r.checked = true;
  refreshAnalysis();
}
const popcount = m => { let n = 0; while (m) { n += m & 1; m >>>= 1; } return n; };

/* ---------- rose ---------- */
function buildRose() {
  const svg = document.getElementById('rose');
  const radii = [[70, 100], [40, 70], [10, 40]]; // band 0 (low) outer … band 2 (upper) inner
  const toXY = (r, deg) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
  let html = '';
  for (let band = 0; band < 3; band++) {
    const [r0, r1] = radii[band];
    for (let s = 0; s < 8; s++) {
      const a0 = s * 45 - 22.5, a1 = s * 45 + 22.5;
      const [x0, y0] = toXY(r1, a0), [x1, y1] = toXY(r1, a1), [x2, y2] = toXY(r0, a1), [x3, y3] = toXY(r0, a0);
      const bandName = ['below 8,000′', '8,000–9,500′', 'above 9,500′'][band];
      html += `<path data-bit="${band * 8 + s}" d="M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z"><title>${ASPECTS[s]} · ${bandName}</title></path>`;
    }
  }
  ASPECTS.forEach((a, s) => { const [x, y] = toXY(106, s * 45); if (s % 2 === 0) html += `<text x="${x}" y="${y}">${a}</text>`; });
  svg.innerHTML = html;
  svg.querySelectorAll('path').forEach(p => p.onclick = () => { state.mask ^= 1 << +p.dataset.bit; roseChanged(); });
  paintRose();
}
function paintRose() {
  document.querySelectorAll('#rose path').forEach(p => p.classList.toggle('on', !!((state.mask >> +p.dataset.bit) & 1)));
}
function roseChanged() {
  store.set('mask', state.mask);
  paintRose();
  if (state.mode !== 'match') {
    state.mode = 'match'; store.set('mode', 'match');
    document.querySelector('input[name=mode][value=match]').checked = true;
  }
  refreshAnalysis();
}

/* ---------- route ---------- */
function setDrawing(on) {
  state.drawing = on;
  if (on) setPinning(false);
  const b = document.getElementById('draw-btn');
  b.textContent = on ? 'Finish' : 'Draw route';
  b.classList.toggle('active', on);
  document.getElementById('draw-hint').hidden = !on;
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  on ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
  map.getSource('route')?.setData(routeGeoJSON());
}

function addRoutePoint(ll) {
  if (state.routeName && !state.routeName.endsWith('(edited)')) state.routeName += ' (edited)';
  state.route.push([+ll[0].toFixed(6), +ll[1].toFixed(6)]);
  updateRoute();
}

function routeGeoJSON() {
  // vertex dots only for hand-drawn routes; long imported tracks just show the line
  const showPts = state.drawing || (!state.routeName && state.route.length <= 500);
  const feats = !showPts ? [] : state.route.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
  if (state.route.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.route }, properties: {} });
  return { type: 'FeatureCollection', features: feats };
}

// Avalanche terrain at a point from the zoom-14 terrain tile: { runout, ates }, or null outside the model
async function terrainAt(lng, lat) {
  const t = lngLatToTile(lng, lat, RUNOUT_MAX_Z);
  const tile = await terrainTileRaw(RUNOUT_MAX_Z, t.x, t.y);
  if (!tile) return null;
  const v = tile[t.r * 256 + t.q];
  return { runout: v >> 3, ates: v & 7 };
}
// Name of an NHD stream within `m` metres of the point ('' for an unnamed one), or null
function nearStream(p, m = 25) {
  if (!state.streams) return null;
  const kx = Math.cos(p[1] * Math.PI / 180) * 111320, ky = 110540, pad = m / ky * 1.5;
  for (const s of state.streams) {
    const b = s.bbox;
    if (p[0] < b[0] - pad * 1.4 || p[0] > b[2] + pad * 1.4 || p[1] < b[1] - pad || p[1] > b[3] + pad) continue;
    for (let i = 1; i < s.line.length; i++) {
      const ax = (s.line[i - 1][0] - p[0]) * kx, ay = (s.line[i - 1][1] - p[1]) * ky;
      const bx = (s.line[i][0] - p[0]) * kx, by = (s.line[i][1] - p[1]) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) <= m) return s.name || '';
    }
  }
  return null;
}
const mi = m => fmt(m / 1609.344, 2);
const hm = h => { const t = Math.round(h * 60); return t < 60 ? `${t} min` : `${Math.floor(t / 60)} h${t % 60 ? ' ' + (t % 60) + ' min' : ''}`; };

let routeSeq = 0;
async function updateRoute() {
  store.set('route', state.route);
  store.set('routeName', state.routeName);
  if (map.getSource('route')) map.getSource('route').setData(routeGeoJSON());
  const seq = ++routeSeq;
  const statsEl = document.getElementById('route-stats'), profEl = document.getElementById('profile'), checksEl = document.getElementById('route-checks');
  const nameEl = document.getElementById('route-name');
  nameEl.hidden = !state.routeName; nameEl.textContent = state.routeName || '';
  if (state.route.length < 2) { statsEl.innerHTML = ''; profEl.innerHTML = ''; checksEl.innerHTML = ''; return; }
  statsEl.innerHTML = '<div class="stat wide"><span>Working out stats…</span></div>';

  const pts = densify(state.route, 15);
  const [samples, terr] = await Promise.all([Promise.all(pts.map(p => sampleAt(p[0], p[1]))), Promise.all(pts.map(p => terrainAt(p[0], p[1])))]);
  if (seq !== routeSeq) return;

  const bins = [0, 0, 0, 0, 0];               // <25, 25–30, 30–35, 35–40, 40+
  const atesD = [0, 0, 0, 0, 0], aspD = Array(8).fill(0), bandD = [0, 0, 0];
  let dist = 0, gain = 0, loss = 0, maxSlope = 0, maxSlopeAt = 0, steepDist = 0, minE = Infinity, maxE = -Infinity;
  let near30 = 0, covered = 0, overhead = 0, trap = 0, southSteep = 0, roseHit = 0;
  const trapNames = new Set();
  const prof = [];
  for (let i = 0; i < pts.length; i++) {
    const s = samples[i], tr = terr[i];
    const d = i ? haversine(pts[i - 1], pts[i]) : 0;
    dist += d;
    if (!s) continue;
    if (i && samples[i - 1]) { const dz = s.elev - samples[i - 1].elev; dz > 0 ? gain += dz : loss -= dz; }
    if (s.slope > maxSlope) { maxSlope = s.slope; maxSlopeAt = dist; }
    if (s.slope >= 30) steepDist += d;
    bins[s.slope < 25 ? 0 : s.slope < 30 ? 1 : s.slope < 35 ? 2 : s.slope < 40 ? 3 : 4] += d;
    if (s.slope >= 27 && s.slope < 30) near30 += d;
    bandD[bandOf(s.elev)] += d;
    if (s.slope >= 28 && !isNaN(s.aspect)) {
      aspD[sectorOf(s.aspect)] += d;
      if ([3, 4, 5].includes(sectorOf(s.aspect))) southSteep += d;
    }
    if (state.mask && s.slope >= state.minSlope && !isNaN(s.aspect) && (state.mask >> (bandOf(s.elev) * 8 + sectorOf(s.aspect))) & 1) roseHit += d;
    if (tr) {
      covered += d; atesD[tr.ates] += d;
      // under slopes that can slide: inside the typical reach, not a start zone itself, and not
      // protected by forest (AutoATES still rates it challenging or worse)
      if (tr.runout === 2 && tr.ates >= 2) {
        overhead += d;
        const st = nearStream(pts[i]);
        if (st != null) { trap += d; if (st) trapNames.add(st); }
      }
    }
    minE = Math.min(minE, s.elev); maxE = Math.max(maxE, s.elev);
    prof.push([dist, s.elev, s.slope]);
  }

  const crossed = new Map();
  if (state.avyPaths) {
    for (const f of state.avyPaths.features) {
      for (const p of pts) {
        if (inBbox(p, f.bbox) && inPolygon(p, f.geometry)) {
          crossed.set(f.properties.name || 'Unnamed path', (crossed.get(f.properties.name || 'Unnamed path') || 0) + 1);
          break;
        }
      }
    }
  }
  const nCrossed = [...crossed.values()].reduce((a, b) => a + b, 0);
  const names = [...crossed.entries()].map(([n, c]) => c > 1 ? `${n} ×${c}` : n);

  const pace = +document.getElementById('pace').value || 1000;
  const hours = gain * FT / pace;
  const [sh, sm] = (document.getElementById('start-time').value || '07:00').split(':').map(Number);
  const top = new Date(2000, 0, 1, sh, sm + Math.round(hours * 60));
  const topStr = top.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  statsEl.innerHTML = `
    <div class="stat"><b>${mi(dist)} mi</b><span>Distance</span></div>
    <div class="stat"><b>${fmt(gain * FT)} ft</b><span>Gain (↓ ${fmt(loss * FT)} ft)</span></div>
    <div class="stat"><b>${fmt(maxE * FT)} ft</b><span>High point (low ${fmt(minE * FT)} ft)</span></div>
    <div class="stat"><b>${hm(hours)}</b><span>Up, at ${fmt(pace)} ft/hr</span></div>`;
  renderProfile(prof);

  // ---- checks, the way Cody Townsend works through a plan ----
  const checks = [];
  const add = (level, title, body, src) => checks.push(`<div class="check ${level}"><b>${title}</b>${body}${src ? `<small>${src}</small>` : ''}</div>`);
  add('info', `Your day: about ${hm(hours)} up`, `${fmt(gain * FT)} ft at ${fmt(pace)} ft/hr. Leave at ${document.getElementById('start-time').value || '07:00'}, top around <b style="display:inline">${topStr}</b>. Add time for route-finding, transitions and the exit.`,
    "Cody Townsend's rule of thumb: vertical ÷ your hourly pace.");

  if (covered > dist * 0.5) {
    const worst = atesD.reduce((w, v, k) => v > 15 ? k : w, 0);
    const bar = atesD.map((v, k) => v > 0 && ATES_COLORS[k] ? `<i style="width:${100 * v / covered}%;background:rgb(${ATES_COLORS[k].join(',')})" title="${ATES_NAMES[k]} ${mi(v)} mi"></i>` : '').join('');
    add(worst >= 3 ? 'bad' : worst === 2 ? 'warn' : 'ok', `Terrain class: up to ${ATES_NAMES[worst]}`,
      `<div class="ates-bar">${bar}</div>${atesD.map((v, k) => v > 15 ? `${ATES_NAMES[k]} ${mi(v)} mi` : '').filter(Boolean).join(' · ')}`,
      'Avalanche Terrain Exposure Scale, computed with the AutoATES v2.0 method (not field-checked here).');
    if (overhead > 15) {
      add(overhead > 400 ? 'bad' : 'warn', `Overhead hazard: ${mi(overhead)} mi, about ${hm(hours * overhead / dist)}`,
        'Ground where a slide from the steep slopes above could reach you, outside dense trees. Keep the time here short; Cody turned around on a warm day rather than sit under hazard for hours.',
        'Typical (24° alpha) runout reach, AutoATES method.');
    } else add('ok', 'No overhead hazard flagged under the line', 'Nothing in the typical runout reach outside dense trees. Check the steep ground you climb itself, and the bigger-event reach on the map.', '');
  } else {
    add('info', 'Outside the terrain model', 'Terrain class and overhead hazard are only computed from Millcreek to Alta.', '');
  }

  add(nCrossed ? 'warn' : 'ok', `${nCrossed} mapped avalanche path${nCrossed === 1 ? '' : 's'} crossed`, esc(names.join(', ') || 'None in the 1989 survey'), 'Utah SGID Avalanche Paths (1989).');

  if (trap > 15) add('bad', `Terrain trap: ${mi(trap)} mi in a creek bed under overhead hazard`,
    `${trapNames.size ? 'Along ' + esc([...trapNames].join(', ')) + '. ' : ''}Hard to escape and a deep burial if something comes down. Cody's Pinchot Creek lesson: stay out of the creek bed when there's hazard above.`,
    'Streams from the USGS National Hydrography Dataset (within 25 m).');

  const binColors = [[110, 120, 130], ...SLOPE_CLASSES.slice(1, 4).map(c => c[2]), [90, 0, 160]];
  add(maxSlope >= 30 ? 'warn' : 'ok', `Steepest ${fmt(maxSlope)}° (at ${mi(maxSlopeAt)} mi)`,
    `<div class="slope-bins">${bins.map((v, k) => v > 0 ? `<i style="width:${100 * v / dist}%;background:rgb(${binColors[k].join(',')})"></i>` : '').join('')}</div>`
    + `Under 25°: ${mi(bins[0])} mi · 25–30°: ${mi(bins[1])} · 30–35°: ${mi(bins[2])} · 35–40°: ${mi(bins[3])} · 40°+: ${mi(bins[4])}`
    + (near30 > 30 ? `<br><b style="display:inline">${mi(near30)} mi is 27–30°</b>, right at the line. The map can't see a 31° roll inside a "30°" slope, so check with an inclinometer.` : ''),
    `Ground under the line only, from ~10 m USGS 3DEP elevation (z${SAMPLE_Z}), every 15 m.`);

  const today = await (globalThis.altaToday?.() ?? null);
  if (seq !== routeSeq) return;
  const steepAsp = aspD.map((v, k) => v > 20 ? `${ASPECTS[k]} ${mi(v)}` : '').filter(Boolean).join(' · ');
  add(southSteep > 30 && today?.highF > 32 ? 'warn' : 'info', 'Sun and warming',
    (southSteep > 30 ? `${mi(southSteep)} mi of 28°+ slopes face SE–SW; these warm first when the sun is out.` : 'Little steep south-facing ground on the line.')
    + (steepAsp ? ` Steep ground by aspect: ${steepAsp} mi.` : '')
    + (today ? `<br>Today at Alta (9,895′): high ${Math.round(today.highF)}°F${today.fz ? `, freezing level ${fmt(Math.round(today.fz / 100) * 100)}′` : ''}${today.snow >= 0.5 ? `, ${Math.round(today.snow)}" new` : ''}.` : ''),
    'Use Map → Hillshade → Real sun to see which slopes the sun is on. Forecast: Alta blend (Resort page).');

  if (state.mask) add(roseHit > 15 ? 'bad' : 'ok', roseHit > 15 ? `${mi(roseHit)} mi in terrain your rose marks dangerous` : 'Clear of the bands you marked on the rose',
    `Slopes of ${state.minSlope}°+ in the aspects and elevations tapped on the avalanche rose (Map tab).`, '');
  else add('info', 'Danger rose not filled in', 'Tap today\'s problem aspects and elevations on the rose (Map tab) and the route is checked against them.', '');
  add('info', 'Elevation bands', `Below 8,000′: ${mi(bandD[0])} mi · 8,000–9,500′: ${mi(bandD[1])} · above 9,500′: ${mi(bandD[2])}`, 'UAC Salt Lake elevation bands.');

  checksEl.innerHTML = checks.join('');
}

function renderProfile(prof) {
  const el = document.getElementById('profile');
  if (prof.length < 2) { el.innerHTML = ''; return; }
  const W = 300, H = 110, pad = { l: 34, r: 4, t: 6, b: 16 };
  const maxD = prof[prof.length - 1][0];
  const es = prof.map(p => p[1] * FT), lo = Math.min(...es), hi = Math.max(...es), span = Math.max(hi - lo, 50);
  const X = d => pad.l + (d / maxD) * (W - pad.l - pad.r);
  const Y = e => pad.t + (1 - (e - lo) / span) * (H - pad.t - pad.b);
  let bars = '';
  for (let i = 1; i < prof.length; i++) {
    const c = slopeColor(prof[i][2]);
    if (c) bars += `<rect x="${X(prof[i - 1][0])}" y="${pad.t}" width="${Math.max(0.6, X(prof[i][0]) - X(prof[i - 1][0]))}" height="${H - pad.t - pad.b}" fill="rgb(${c.join(',')})" opacity="0.35"/>`;
  }
  const line = prof.map(p => `${X(p[0]).toFixed(1)},${Y(p[1] * FT).toFixed(1)}`).join(' ');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile">
    ${bars}
    <polyline points="${line}" fill="none" stroke="#ffcf4a" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <text x="2" y="${pad.t + 8}">${fmt(lo + span)}′</text><text x="2" y="${H - pad.b}">${fmt(lo)}′</text>
    <text x="${W - pad.r}" y="${H - 3}" text-anchor="end">${fmt(maxD / 1609.344, 2)} mi</text>
  </svg>`;
}

/* ---------- pins ---------- */
const pinMarkers = new Map();
function setPinning(on) {
  state.pinning = on;
  if (on) setDrawing(false);
  document.getElementById('pin-btn').classList.toggle('active', on);
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}
async function addPin(ll) {
  setPinning(false);
  const name = prompt('Pin name', `Pin ${state.pins.length + 1}`);
  if (name === null) return;
  const s = await sampleAt(ll.lng, ll.lat);
  state.pins.push({ id: Date.now().toString(36), name: name || 'Pin', lng: +ll.lng.toFixed(6), lat: +ll.lat.toFixed(6), elev: s ? Math.round(s.elev) : null });
  store.set('pins', state.pins);
  renderPins();
}
function renderPins() {
  pinMarkers.forEach(m => m.remove()); pinMarkers.clear();
  const list = document.getElementById('pin-list');
  list.innerHTML = '';
  for (const p of state.pins) {
    const el = document.createElement('div'); el.className = 'pin-marker';
    const pop = new maplibregl.Popup({ offset: 10 }).setHTML(`<b>${esc(p.name)}</b><br>${p.elev != null ? fmt(p.elev * FT) + ' ft · ' : ''}${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`);
    pinMarkers.set(p.id, new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(pop).addTo(map));
    const li = document.createElement('li');
    li.innerHTML = `<a>${esc(p.name)}</a><span class="muted small">${p.elev != null ? fmt(p.elev * FT) + ' ft' : ''}</span><button aria-label="Delete pin">✕</button>`;
    li.querySelector('a').onclick = () => map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14) });
    li.querySelector('button').onclick = () => { state.pins = state.pins.filter(x => x.id !== p.id); store.set('pins', state.pins); renderPins(); };
    list.appendChild(li);
  }
}

/* ---------- GPX ---------- */
async function exportGPX() {
  if (state.route.length < 2 && !state.pins.length) { alert('Nothing to export yet. Draw a route or drop a pin first.'); return; }
  const xmlEsc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const elevs = await Promise.all(state.route.map(c => sampleAt(c[0], c[1])));
  const wpts = state.pins.map(p => `  <wpt lat="${p.lat}" lon="${p.lng}">${p.elev != null ? `<ele>${p.elev}</ele>` : ''}<name>${xmlEsc(p.name)}</name></wpt>`).join('\n');
  const trk = state.route.length > 1 ? `  <trk><name>${xmlEsc(state.routeName || 'Wasatch BC Atlas route')}</name><trkseg>\n${state.route.map((c, i) => `    <trkpt lat="${c[1]}" lon="${c[0]}">${elevs[i] ? `<ele>${elevs[i].elev.toFixed(1)}</ele>` : ''}</trkpt>`).join('\n')}\n  </trkseg></trk>` : '';
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wasatch BC Atlas" xmlns="http://www.topografix.com/GPX/1/1">\n${wpts}\n${trk}\n</gpx>\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = `wasatch-route-${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) { alert("Couldn't read that GPX file."); return; }
  const pts = [...doc.querySelectorAll('trkpt')];
  const line = (pts.length ? pts : [...doc.querySelectorAll('rtept')]).map(n => [+n.getAttribute('lon'), +n.getAttribute('lat')]).filter(c => isFinite(c[0]) && isFinite(c[1]));
  const wpts = [...doc.querySelectorAll('wpt')];
  if (line.length > 1) {
    if (state.route.length > 1 && !confirm('Replace the current route with the imported track?')) return;
    state.route = line.map(c => [+c[0].toFixed(6), +c[1].toFixed(6)]);
    state.routeName = doc.querySelector('trk > name, rte > name')?.textContent || 'Imported GPX';
    state.tourId = null;
    markTour(null);
    updateRoute();
    renderGuide();
    const b = line.reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [180, 90, -180, -90]);
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 80, pitch: map.getPitch() });
  }
  wpts.forEach((n, i) => {
    const ele = n.querySelector('ele');
    state.pins.push({ id: Date.now().toString(36) + i, name: n.querySelector('name')?.textContent || `Waypoint ${i + 1}`, lng: +n.getAttribute('lon'), lat: +n.getAttribute('lat'), elev: ele ? Math.round(+ele.textContent) : null });
  });
  if (wpts.length) { store.set('pins', state.pins); renderPins(); }
  if (line.length < 2 && !wpts.length) alert('No track, route or waypoints found in that GPX file.');
}

/* ---------- UAC rated routes ---------- */
let uac = null;
const RATING_COLOR = { Green: 'var(--green)', Yellow: 'var(--yellow)', Orange: 'var(--orange)', Red: 'var(--red)' };
async function loadUacRoutes() {
  uac = await fetch('data/uac_routes.json').then(r => r.json());
  document.getElementById('uac-count').textContent = `(${uac.routes.length})`;
  renderUacList();
  renderTours();
  renderGuide();
}

/* ---------- Tours (data/tours.geojson, built by tools/terrain_wasatch.py from tools/tours.json) ---------- */
const AREA_ORDER = ['LCC', 'LCC → BCC', 'LCC (Alta)', 'BCC', 'BCC → Summit Co.', 'Mill Creek'];
const AREA_NAME = { 'LCC': 'Little Cottonwood', 'LCC → BCC': 'From Alta into Big Cottonwood', 'LCC (Alta)': 'Inside Alta Ski Area', 'BCC': 'Big Cottonwood', 'BCC → Summit Co.': 'Big Cottonwood to the Park City ridge', 'Mill Creek': 'Mill Creek' };
const SEEN_LABEL = { onx: 'onX', reddit: 'Reddit', whitecloud: 'White Cloud' };
const SRC_SHORT = { wbs: 'WBSkiing', 'wbs-db': 'WBSkiing list', pp: 'Powder Project', uaco: 'UAC', 'uac-route': 'UAC route', 'uac-list': 'UAC list', onx: 'onX', reddit: 'Reddit', whitecloud: 'White Cloud', 'alta-uphill': 'Alta', 'alta-policy': 'Alta policy', 'slco-millcreek': 'SL County', 'trailsutah-millcreek': 'Trails Utah', sgid: 'SGID', osm: 'OSM' };
const tourById = id => state.tours?.features.find(x => x.properties.id === id);
state.tourId = store.get('tourId', null);

async function loadTours() {
  const list = document.getElementById('tour-list');
  try {
    state.tours = await fetch('data/tours.geojson').then(r => r.json());
  } catch (e) {
    list.innerHTML = `<li class="muted">Tours didn't load (${esc(e.message)}).</li>`;
    return;
  }
  // the map only needs the line and its name; the guide reads the rest from state.tours
  map.getSource('tours')?.setData({ type: 'FeatureCollection', features: state.tours.features.map(f => ({ type: 'Feature', geometry: f.geometry, properties: { id: f.properties.id, name: f.properties.name } })) });
  // a route saved before tours had ids: find its tour by name
  if (!state.tourId && state.routeName) state.tourId = state.tours.features.find(f => f.properties.name === state.routeName.replace(/ \(edited\)$/, ''))?.properties.id || null;
  renderTours();
  renderPhotoIndex();
  renderGuide();
}
function seenChips(seen) {
  return Object.entries(seen || {}).filter(([, v]) => v.length).map(([k, v]) => `<span class="seen-chip ${k}" title="${esc(v.join(' · '))}">${SEEN_LABEL[k]}</span>`).join('');
}
function uacChip(p) {
  const u = p.uac && uac?.routes.find(r => r.name === p.uac);
  if (!u) return '';
  const part = p.uac_match === 'approach';
  return `<span class="uac-chip ${u.rating}${part ? ' part' : ''}" title="UAC route rating: ${esc(u.name)}${part ? ' (shares the approach; UAC did not rate the rest)' : ''}">UAC ${u.rating}${part ? " · approach" : ""}</span>`;
}
function renderTours() {
  if (!state.tours) return;
  const pace = +document.getElementById('pace').value || 1000;
  const list = document.getElementById('tour-list');
  document.getElementById('tour-count').textContent = `(${state.tours.features.length})`;
  const byArea = {};
  state.tours.features.forEach(f => (byArea[f.properties.area] ||= []).push(f));
  list.innerHTML = AREA_ORDER.filter(a => byArea[a]).map(area => `<li class="tour-group">${esc(AREA_NAME[area] || area)}</li>` + byArea[area].map(f => {
    const p = f.properties, a = p.approx, u = p.uac && uac?.routes.find(r => r.name === p.uac);
    const tot = a.ates_mi.reduce((x, y) => x + y, 0) || 1;
    const bar = a.ates_mi.map((v, k) => v > 0 && ATES_COLORS[k] ? `<i style="width:${100 * v / tot}%;background:rgb(${ATES_COLORS[k].join(',')})"></i>` : '').join('');
    const worst = a.ates_mi.reduce((w, v, k) => v >= 0.02 ? k : w, 0);
    return `<li class="tour${state.tourId === p.id ? ' selected' : ''}" tabindex="0" role="button" data-id="${p.id}">
      <div class="tour-top"><b>${esc(p.name)}</b>${uacChip(p)}</div>
      <div class="tour-sub">${seenChips(p.seen)}${esc([p.from, ...p.via].join(' → '))}</div>
      <div class="tour-stats"><span><b>≈${fmt(a.distance_mi, 1)}</b> mi</span><span><b>≈${fmt(a.gain_ft)}</b> ft</span><span><b>${fmt(a.high_ft)}</b> ft top</span><span><b>${hm(a.gain_ft / pace)}</b> up</span><span>max <b>${a.max_slope}°</b></span></div>
      <div class="ates-bar" title="Terrain class along the line">${bar}</div>
      <div class="ates-key"><span>Up to <b>${ATES_NAMES[worst]}</b></span>${p.runs?.length ? `<span>${p.runs.length} named run${p.runs.length > 1 ? 's' : ''}</span>` : ''}${p.slides?.length ? `<span>${p.slides.length} UAC slide report${p.slides.length > 1 ? 's' : ''}</span>` : ''}${u && p.uac_match === 'same' ? `<span>UAC: ${u.distance_mi ?? '–'} mi, ${u.gain_ft ? fmt(u.gain_ft) + ' ft' : '–'}</span>` : ''}</div>
    </li>`;
  }).join('')).join('');
  list.querySelectorAll('.tour').forEach(li => {
    li.onclick = () => selectTour(li.dataset.id);
    li.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTour(li.dataset.id); } };
  });
}
// Every name from Matt's photos, and where it lives in the app
function renderPhotoIndex() {
  const el = document.getElementById('photo-index');
  if (!el || !state.tours) return;
  const rows = { onx: [], reddit: [], whitecloud: [] };
  state.tours.features.forEach(f => Object.entries(f.properties.seen || {}).forEach(([k, names]) => names.forEach(n => rows[k]?.push([n, f.properties]))));
  const skipped = state.tours.not_added || [];
  el.innerHTML = Object.entries(rows).map(([k, r]) => `<h4>${SEEN_LABEL[k]} <span class="muted">(${r.length + skipped.filter(s => s.from === k).length})</span></h4><ul>` +
    r.sort((x, y) => x[0].localeCompare(y[0])).map(([n, p]) => `<li>“${esc(n)}” → <button class="linkish" data-id="${p.id}">${esc(p.name)}</button></li>`).join('') +
    skipped.filter(s => s.from === k).map(s => `<li>“${esc(s.name)}” → <span class="muted">not added: ${esc(s.why)}</span></li>`).join('') + '</ul>').join('');
  el.querySelectorAll('button[data-id]').forEach(b => { b.onclick = () => selectTour(b.dataset.id); });
}
function markTour(id) {
  document.querySelectorAll('.tour').forEach(li => li.classList.toggle('selected', !!id && li.dataset.id === id));
}
function selectTour(id) {
  const f = tourById(id);
  if (!f) return;
  setDrawing(false);
  state.route = f.geometry.coordinates.map(c => [c[0], c[1]]);
  state.routeName = f.properties.name;
  state.tourId = id;
  markTour(id);
  updateRoute();
  renderGuide();
  const b = state.route.concat((f.properties.runs || []).map(r => [r.lon, r.lat]))
    .reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [180, 90, -180, -90]);
  const wide = matchMedia('(min-width: 900px)').matches;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: wide ? { top: 80, bottom: 60, left: 420, right: 60 } : { top: 70, bottom: 260, left: 30, right: 50 }, pitch: map.getPitch(), duration: 900 });
  openTab('plan');
}

/* the selected tour's runs and nearby avalanche-death locations, on the map */
function showTourMarks(p) {
  const src = map.getSource('tour-marks');
  if (!src) return;
  const feats = p ? [
    ...(p.runs || []).map(r => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { kind: 'run', name: r.name } })),
    ...(p.deaths_near || []).map(d => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: { kind: 'death', name: d.name } })),
  ] : [];
  src.setData({ type: 'FeatureCollection', features: feats });
}

function srcLinks(keys, p) {
  const all = state.tours?.sources || {};
  return (keys || []).map(k => {
    let url = all[k]?.url, title = all[k]?.title || k;
    if (k === 'uac-route') { const u = uac?.routes.find(r => r.name === p.uac); url = u?.url; title = `UAC route rating: ${p.uac}`; }
    const label = SRC_SHORT[k] || SRC_SHORT[k.split(':')[0]] || k;
    return url ? `<a class="src" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${esc(label)}</a>` : `<span class="src" title="${esc(title)}">${esc(label)}</span>`;
  }).join('');
}

/* Save a tour's map for offline use: fetch every basemap, elevation and terrain-class tile around its
   line and runs. The service worker keeps them (sw.js), so the map draws with no signal. */
const tileXY = (lon, lat, z) => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
};
function offlineTiles(p, f) {
  const pts = f.geometry.coordinates.concat((p.runs || []).map(r => [r.lon, r.lat]));
  const b = pts.reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [180, 90, -180, -90]);
  const pad = [0.008, 0.006];                                  // about 650 m around everything
  const W = b[0] - pad[0], S = b[1] - pad[1], E = b[2] + pad[0], N = b[3] + pad[1];
  const urls = [];
  const add = (tpl, z0, z1) => {
    for (let z = z0; z <= z1; z++) {
      const [x0, y0] = tileXY(W, N, z), [x1, y1] = tileXY(E, S, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  };
  add(BASEMAPS[document.getElementById('basemap').value] || BASEMAPS.topo, 11, 16);
  add(DEM_URL, 10, DEM_MAX_Z);
  add(location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + RUNOUT_URL, RUNOUT_MIN_Z, RUNOUT_MAX_Z);   // same URL the tile worker asks for
  return urls;
}
async function saveOffline(btn, p, f) {
  if (!navigator.serviceWorker?.controller) { btn.textContent = 'Offline saving needs the installed app (reload once and try again)'; return; }
  const urls = offlineTiles(p, f);
  let done = 0, bad = 0, i = 0;
  btn.disabled = true;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try { const r = await fetch(u); if (!r.ok) bad++; } catch { bad++; }
      done++;
      if (done % 10 === 0 || done === urls.length) btn.textContent = `Saving map… ${done} / ${urls.length}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const saved = store.get('offline', {});
  saved[p.id] = { at: new Date().toISOString(), tiles: urls.length - bad, missing: bad };
  store.set('offline', saved);
  btn.disabled = false;
  renderGuide();
}

async function renderGuide() {
  const el = document.getElementById('tour-guide');
  const f = state.tourId && tourById(state.tourId);
  store.set('tourId', f ? state.tourId : null);
  showTourMarks(f?.properties);
  document.getElementById('guide-jump').hidden = !f;
  if (!f) { el.innerHTML = ''; return; }
  const p = f.properties, a = p.approx;
  const items = list => (list || []).map(n => `<li>${esc(n.t)} ${srcLinks(n.src, p)}</li>`).join('');
  const start = p.start ? `<p><b>Start:</b> ${esc(p.start.name)}${p.start.road_mi ? ` · ${p.start.road_mi} mi up the canyon road` : ''}${p.start.elev_ft ? ` · ${fmt(p.start.elev_ft)} ft` : ''} ${srcLinks([p.start.src], p)}</p>` : '';
  const pub = (p.published || []).map(x => `<tr><td>${esc(x.what)} ${srcLinks([x.src], p)}</td><td>${x.vert_ft ? fmt(x.vert_ft) + ' ft' : '–'}</td><td>${x.dist_mi ? x.dist_mi + ' mi' : '–'}</td></tr>`).join('');
  const lineSrc = p.line_source === 'computed' ? 'This computed line' : `This line (${esc(p.line_source)})`;
  const runs = (p.runs || []).map((r, i) => {
    const pub = [r.difficulty, r.slope ? `${r.slope}°` : null, r.aspect, r.ski_vert_ft ? `${fmt(r.ski_vert_ft)} ft` : null].filter(Boolean).join(' · ');
    return `<li><button class="linkish run-go" data-i="${i}">${esc(r.name)}</button> ${srcLinks([r.src], p)}
      <div class="run-line">${pub ? `<span>${esc(pub)}</span>` : '<span class="muted">location only</span>'}<span class="muted">map here: ${r.map.slope_med}° (max ${r.map.slope_max}°), faces ${r.map.aspect}, ${fmt(r.map.elev_ft)} ft</span></div>
      ${r.pp ? `<div class="run-line muted">${esc(r.pp)}</div>` : ''}${r.note ? `<div class="run-line muted">${esc(r.note)}</div>` : ''}</li>`;
  }).join('');
  const slides = (p.slides || []).slice().sort((x, y) => y.date.localeCompare(x.date)).map(s => `<tr><td>${esc(s.date)}</td><td>${esc(s.place)}</td><td>${esc(s.trigger)}</td><td>${esc([s.depth, s.width ? s.width + ' wide' : null].filter(Boolean).join(', ') || '–')}</td><td>${esc([s.aspect, s.elev_ft ? fmt(s.elev_ft) + "'" : null].filter(Boolean).join(' ') || '–')}</td><td>${srcLinks([s.src], p)}</td></tr>`).join('');
  const byName = {};
  (p.deaths_near || []).forEach(d => { const g = (byName[d.name] ||= { n: 0, m: d.m }); g.n++; g.m = Math.min(g.m, d.m); });
  const dn = Object.entries(byName);
  const deaths = dn.length ? `<li>WBSkiing marks ${p.deaths_near.length} avalanche-death location${p.deaths_near.length > 1 ? 's' : ''} within 300 m of this line or its runs: ${esc(dn.map(([n, g]) => `${n}${g.n > 1 ? ` (${g.n} entries)` : ''}, ${g.m} m away`).join('; '))}. Marked † on the map. ${srcLinks(['wbs-db'], p)}</li>` : '';
  const used = [...new Set([...(p.notes || []), ...(p.warn || [])].flatMap(n => n.src).concat((p.runs || []).map(r => r.src), (p.slides || []).map(s => s.src), (p.published || []).map(x => x.src), p.start ? [p.start.src] : []))];
  const seen = Object.entries(p.seen || {}).filter(([, v]) => v.length).map(([k, v]) => `${SEEN_LABEL[k]}: ${v.map(x => `“${esc(x)}”`).join(', ')}`).join(' · ');
  el.innerHTML = `
    <div class="guide-head">${uacChip(p)}${seenChips(p.seen)}<span class="muted">${esc(AREA_NAME[p.area] || p.area)}</span></div>
    ${seen ? `<p class="hint">In your photos as ${seen}</p>` : ''}
    <div id="guide-status"></div>
    <div class="offline-row"><button id="save-offline" class="cta">${(() => { const o = store.get('offline', {})[p.id]; return o ? `Saved for offline ${new Date(o.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${fmt(o.tiles)} tiles${o.missing ? ` (${o.missing} failed)` : ''} · save again` : 'Save this tour\'s map for offline'; })()}</button>
      <p class="hint">Downloads the topo, elevation and terrain-class tiles around the line and its runs, so the map, slope shading and route checks work with no signal. Forecasts and avalanche data still need a connection.</p></div>
    <details open><summary>Getting there</summary>${start}
      <table class="mini"><tr><th></th><th>Climb</th><th>Distance</th></tr>${pub}<tr><td>${lineSrc}</td><td>≈${fmt(a.gain_ft)} ft</td><td>≈${fmt(a.distance_mi, 1)} mi</td></tr></table>
      ${p.notes?.length ? `<ul class="guide-list">${items(p.notes)}</ul>` : ''}</details>
    ${p.warn?.length || deaths ? `<details open><summary>Watch out</summary><ul class="guide-list warn">${items(p.warn)}${deaths}</ul></details>` : ''}
    ${runs ? `<details open><summary>Runs <span class="muted">(${p.runs.length})</span></summary><p class="hint">Rating, slope and aspect as the source lists them; “map here” is measured within 40 m of the listed point, which can sit mid-run.</p><ul class="guide-list runs">${runs}</ul></details>` : ''}
    ${slides ? `<details open><summary>Slides reported to UAC <span class="muted">(${p.slides.length})</span></summary><p class="hint">Reports read for this tour, not every slide on record. ${srcLinks(['uac-list'], p)}</p><table class="mini slides"><tr><th>Date</th><th>Where</th><th>Trigger</th><th>Size</th><th>Aspect</th><th></th></tr>${slides}</table></details>` : ''}
    <details><summary>Sources <span class="muted">(${used.length})</span></summary><ul class="guide-list">${used.map(k => {
      const s = state.tours.sources[k] || (k === 'uac-route' ? { title: `UAC route rating: ${p.uac}`, url: uac?.routes.find(r => r.name === p.uac)?.url } : { title: k });
      return `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</li>`;
    }).join('')}<li>Points: ${esc(Object.entries(p.points).map(([n, q]) => `${n}: ${q.source}`).join('; '))}</li></ul></details>`;
  el.querySelector('#save-offline').onclick = e => saveOffline(e.currentTarget, p, f);
  el.querySelectorAll('.run-go').forEach(b => {
    b.onclick = () => { const r = p.runs[+b.dataset.i]; map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 900 }); };
  });
  if (p.status === 'alta-uphill') {
    const box = document.getElementById('guide-status');
    box.innerHTML = '<div class="check info"><b>Alta uphill:</b> checking…</div>';
    try {
      const u = await fetch('/api/uphill').then(r => r.json());
      if (state.tourId !== p.id) return;
      const cls = u.status === 'open' ? 'ok' : u.status === 'closed' ? 'bad' : 'info';
      box.innerHTML = `<div class="check ${cls}"><b>Alta uphill:</b> ${u.text ? esc(u.text) : 'status not found on the page'}${u.updated ? ` <span class="muted">(Alta, updated ${esc(u.updated)})</span>` : ''}${u.summerRoad ? ` ${esc(u.summerRoad)}` : ''} <a href="${esc(u.url)}" target="_blank" rel="noopener">alta.com ↗</a></div>`;
    } catch {
      box.innerHTML = '<div class="check info"><b>Alta uphill:</b> couldn\'t check. Alta can close uphill travel before opening day; <a href="https://www.alta.com/uphill-travel" target="_blank" rel="noopener">check alta.com ↗</a></div>';
    }
  } else if (p.status === 'millcreek-road') {
    document.getElementById('guide-status').innerHTML = `<div class="check bad"><b>Access:</b> the upper Mill Creek road was closed to everyone for reconstruction from March 15, 2026; Trails Utah says it reopens for winter use in November 2026. ${srcLinks(['slco-millcreek', 'trailsutah-millcreek'], p)}</div>`;
  }
}
function renderUacList() {
  if (!uac) return;
  const on = new Set([...document.querySelectorAll('#rating-filter input:checked')].map(i => i.value));
  const order = { Green: 0, Yellow: 1, Orange: 2, Red: 3 };
  const list = document.getElementById('uac-list');
  const routes = uac.routes.filter(r => on.has(r.rating)).sort((a, b) => a.canyon.localeCompare(b.canyon) || order[a.rating] - order[b.rating] || a.name.localeCompare(b.name));
  const v = (x, unit) => x == null ? '<span class="muted">not stated</span>' : `<b>${fmt(x, x % 1 ? 1 : 0)}${unit}</b>`;
  list.innerHTML = routes.map(r => `
    <li>
      <div class="uac-head" tabindex="0" role="button" aria-expanded="false"><span class="chip" style="background:${RATING_COLOR[r.rating]}"></span><span>${esc(r.name)}</span><span class="canyon">${esc(r.canyon)}</span></div>
      <div class="uac-body" hidden>
        Rating: <b>${esc(r.rating)}</b> · Distance ${v(r.distance_mi, ' mi')} · Gain ${v(r.gain_ft, ' ft')} · High point ${v(r.high_point_ft, ' ft')}<br>
        Road mile: ${v(r.road_mi, '')} · Dogs: ${esc(r.dogs || 'not stated')}<br>
        Parking: ${esc(r.parking || 'not stated')}<br>
        ${r.named_hazards?.length ? `Hazards named: ${esc(r.named_hazards.join('; '))}<br>` : ''}
        ${r.features?.length ? `Landmarks: ${esc(r.features.join('; '))}<br>` : ''}
        <a href="${esc(r.url)}" target="_blank" rel="noopener">UAC route page ↗</a>
        ${r.map_img ? `<img loading="lazy" alt="UAC route map for ${esc(r.name)}" data-src="${esc(r.map_img)}">` : ''}
      </div>
    </li>`).join('');
  list.querySelectorAll('.uac-head').forEach(h => {
    const toggle = () => {
      const body = h.nextElementSibling, open = body.hidden;
      body.hidden = !open; h.setAttribute('aria-expanded', open);
      const img = body.querySelector('img[data-src]');
      if (open && img) { img.src = img.dataset.src; img.removeAttribute('data-src'); img.onerror = () => img.remove(); }
    };
    h.onclick = toggle;
    h.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}

/* ---------- Alta snow forecast (data and maths in forecast-data.js) ---------- */
async function loadAltaSnow() {
  const el = document.getElementById('alta-mini');   // the map panel no longer has the mini chart; marker only
  const marker = document.createElement('a');
  marker.className = 'alta-marker'; marker.href = 'forecast.html'; marker.title = 'Alta forecast point, 9,895 ft';
  marker.innerHTML = '<img src="badge.svg" alt=""><span>Alta</span>';
  new maplibregl.Marker({ element: marker, anchor: 'bottom' }).setLngLat([POINT.lon, POINT.lat]).addTo(map);
  try {
    const b = build(await fetchAll(false));
    const max = Math.max(4, ...b.days.map(d => d.snow || 0));
    const tot = (a, z) => Math.round(b.days.slice(a, z).reduce((s, d) => s + (d.snow || 0), 0));
    const next5 = tot(0, 5);
    marker.querySelector('span').textContent = `Alta ${next5}"`;
    marker.title = `Alta: ${next5}" in the next 5 days. Open the full forecast.`;
    if (!el) return;
    el.innerHTML = `<div class="alta-tots">${[[0, 5, '1–5 days'], [5, 10, '6–10'], [10, 15, '11–15']].map(([a, z, l]) => `<div><b>${tot(a, z)}"</b><span>${l}</span></div>`).join('')}</div>
      <div class="alta-bars">${b.days.map(d => {
        const v = d.snow || 0;
        const tip = `${dow(d.date)} ${dom(d.date)}: ${v.toFixed(1)}"${d.ens ? ` · ${Math.round(d.ens.pPowder)}% chance of ${POWDER_IN}"+` : ''}`;
        return `<div title="${esc(tip)}"><i class="${v >= POWDER_IN - 0.5 ? 'powder' : ''}" style="height:${Math.max(2, 100 * v / max)}%"></i><span>${dow(d.date)[0]}</span></div>`;
      }).join('')}</div>`;
    document.getElementById('alta-updated').textContent = `· next 15 days`;
  } catch (e) {
    if (el) el.innerHTML = `<p class="hint">Forecast didn't load (${esc(e.message)}).</p>`;
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
