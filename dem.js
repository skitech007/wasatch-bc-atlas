/* Shared terrain maths for the page and the tile workers (no DOM).
 * Elevation: AWS Terrain Tiles, Terrarium encoding (USGS 3DEP in the US).
 */
'use strict';

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_MAX_Z = 15;
const SAMPLE_Z = 14;            // point sampling zoom (~7 m/px in the Wasatch)
const EARTH_CIRC = 40075016.686;
const FT = 3.28084;
const BAND_FT = [8000, 9500];  // UAC Salt Lake elevation bands
const ASPECTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/* ---------- DEM tile cache ---------- */
const tileCache = new Map();
function demTile(z, x, y) {
  const n = 2 ** z;
  x = ((x % n) + n) % n;
  if (y < 0 || y >= n) return Promise.resolve(null);
  const k = `${z}/${x}/${y}`;
  if (tileCache.has(k)) {
    const p = tileCache.get(k);
    tileCache.delete(k); tileCache.set(k, p);
    return p;
  }
  const url = DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const p = fetch(url)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
    .then(b => createImageBitmap(b))
    .then(bmp => {
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const e = new Float32Array(65536);
      for (let i = 0; i < 65536; i++) e[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      return e;
    })
    .catch(() => { tileCache.delete(k); return null; });
  tileCache.set(k, p);
  if (tileCache.size > 500) tileCache.delete(tileCache.keys().next().value);
  return p;
}

// 258x258 grid: the tile plus a 1px border from its neighbours, so slope has no seams.
const gridCache = new Map();
function paddedGrid(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (gridCache.has(k)) return gridCache.get(k);
  const offs = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const p = Promise.all(offs.map(([dx, dy]) => demTile(z, x + dx, y + dy))).then(ts => {
    const c = ts[4];
    if (!c) { gridCache.delete(k); return null; }
    const W = 258, g = new Float32Array(W * W);
    for (let r = -1; r <= 256; r++) {
      const ty = r < 0 ? 0 : r > 255 ? 2 : 1;
      for (let q = -1; q <= 256; q++) {
        const tx = q < 0 ? 0 : q > 255 ? 2 : 1;
        let t = ts[ty * 3 + tx], lr = (r + 256) % 256, lq = (q + 256) % 256;
        if (!t) { t = c; lr = Math.min(255, Math.max(0, r)); lq = Math.min(255, Math.max(0, q)); }
        g[(r + 1) * W + (q + 1)] = t[lr * 256 + lq];
      }
    }
    return g;
  });
  gridCache.set(k, p);
  if (gridCache.size > 60) gridCache.delete(gridCache.keys().next().value);
  return p;
}

function cellSize(z, y, r) {
  const n = Math.PI - 2 * Math.PI * (y + (r + 0.5) / 256) / 2 ** z;
  return EARTH_CIRC * Math.cos(Math.atan(Math.sinh(n))) / (256 * 2 ** z);
}

// Horn's method on the 3x3 window centred at grid index i. Returns [slopeDeg, aspectDeg|NaN].
function hornAt(g, i, cs) {
  const W = 258;
  const a = g[i - W - 1], b = g[i - W], c = g[i - W + 1];
  const d = g[i - 1], f = g[i + 1];
  const gg = g[i + W - 1], h = g[i + W], ii = g[i + W + 1];
  const gx = ((c + 2 * f + ii) - (a + 2 * d + gg)) / (8 * cs);   // dz/dx, east positive
  const gs = ((gg + 2 * h + ii) - (a + 2 * b + c)) / (8 * cs);   // dz/dy, south positive
  const slope = Math.atan(Math.hypot(gx, gs)) * 180 / Math.PI;
  const aspect = slope < 1 ? NaN : (Math.atan2(-gx, gs) * 180 / Math.PI + 360) % 360;
  return [slope, aspect];
}

const sectorOf = a => Math.floor(((a + 22.5) % 360) / 45);
const bandOf = elevM => { const ft = elevM * FT; return ft >= BAND_FT[1] ? 2 : ft >= BAND_FT[0] ? 1 : 0; };

/* ---------- colour ramps (display only) ---------- */
const SLOPE_CLASSES = [
  [27, 30, [242, 230, 0], '27–30°'],
  [30, 35, [255, 153, 0], '30–35°'],
  [35, 40, [255, 34, 0], '35–40°'],
  [40, 45, [176, 0, 138], '40–45°'],
  [45, 50, [90, 0, 160], '45–50°'],
  [50, 91, [20, 20, 20], '50°+'],
];
const ASPECT_COLORS = [
  [40, 90, 220], [100, 60, 210], [190, 60, 190], [230, 70, 90],
  [240, 150, 30], [230, 210, 40], [80, 190, 80], [40, 170, 190],
];
const MATCH_COLOR = [226, 40, 30];

function slopeColor(s) {
  for (const [lo, hi, c] of SLOPE_CLASSES) if (s >= lo && s < hi) return c;
  return null;
}

/* ---------- avalanche terrain tiles (tools/terrain_wasatch.py) ----------
 * One byte per pixel = runout class × 8 + ATES class, zooms 11–14, Central Wasatch only.
 * runout: 0 none · 1 extended reach (alpha 18°) · 2 typical reach (24°) · 3 start zone
 * ATES:   0 non-avalanche · 1 simple · 2 challenging · 3 complex · 4 extreme (AutoATES v2.0 method)
 */
const RUNOUT_URL = 'tiles/runout/{z}/{x}/{y}.png';
const RUNOUT_MIN_Z = 11, RUNOUT_MAX_Z = 14;
const ATES_COLORS = [null, [63, 163, 77], [47, 111, 219], [25, 25, 28], [208, 2, 27]];
const ATES_NAMES = ['Non-avalanche', 'Simple', 'Challenging', 'Complex', 'Extreme'];
const RUNOUT_COLORS = [null, [255, 214, 130], [240, 138, 36], [196, 50, 80]];
const SAFE_COLOR = [40, 200, 110];
const SAFE_MAX_SLOPE = 25;      // Cody Townsend: on high-danger days he skis 20–25° with no overhead hazard

const terrainCache = new Map();
function terrainTileRaw(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (terrainCache.has(k)) return terrainCache.get(k);
  const url = new URL(RUNOUT_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y), self.location.href).href;
  const p = fetch(url)
    .then(r => r.ok ? r.blob() : null)
    .then(b => b && createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
    .then(bmp => {
      if (!bmp) return null;
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const v = new Uint8Array(65536);
      for (let i = 0; i < 65536; i++) v[i] = d[i * 4];
      return v;
    })
    .catch(() => null);
  terrainCache.set(k, p);
  if (terrainCache.size > 300) terrainCache.delete(terrainCache.keys().next().value);
  return p;
}
// The tile at any zoom from 11 up: deeper zooms are cut from the zoom-14 tile. null = no coverage.
async function terrainTile(z, x, y) {
  if (z < RUNOUT_MIN_Z) return null;
  if (z <= RUNOUT_MAX_Z) return terrainTileRaw(z, x, y);
  const f = 2 ** (z - RUNOUT_MAX_Z);
  const parent = await terrainTileRaw(RUNOUT_MAX_Z, Math.floor(x / f), Math.floor(y / f));
  if (!parent) return null;
  const ox = (x % f) * 256 / f, oy = (y % f) * 256 / f, out = new Uint8Array(65536);
  for (let r = 0; r < 256; r++) for (let q = 0; q < 256; q++) out[r * 256 + q] = parent[Math.floor(oy + r / f) * 256 + Math.floor(ox + q / f)];
  return out;
}

/* Render one 256px analysis tile to PNG bytes. */
async function renderTile(z, x, y, mode, mask, minSlope) {
  const img = new ImageData(256, 256);
  const put = (i, c) => { const o = i * 4; img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255; };
  if (mode === 'ates' || mode === 'runout') {
    const t = await terrainTile(z, x, y);
    if (t) for (let i = 0; i < 65536; i++) {
      const c = mode === 'ates' ? ATES_COLORS[t[i] & 7] : RUNOUT_COLORS[t[i] >> 3];
      if (c) put(i, c);
    }
    return encodePng(img);
  }
  const [g, terr] = await Promise.all([paddedGrid(z, x, y), mode === 'safe' ? terrainTile(z, x, y) : null]);
  if (mode === 'safe' && !terr) return encodePng(img);
  if (g) {
    const px = img.data;
    for (let r = 0; r < 256; r++) {
      const cs = cellSize(z, y, r);
      for (let q = 0; q < 256; q++) {
        const i = (r + 1) * 258 + (q + 1);
        const [s, a] = hornAt(g, i, cs);
        let c = null;
        if (mode === 'slope') c = slopeColor(s);
        else if (mode === 'aspect') { if (s >= 10 && !isNaN(a)) c = ASPECT_COLORS[sectorOf(a)]; }
        else if (mode === 'match') {
          if (s >= minSlope && !isNaN(a) && (mask >> (bandOf(g[i]) * 8 + sectorOf(a))) & 1) c = MATCH_COLOR;
        }
        else if (mode === 'safe') { if (s < SAFE_MAX_SLOPE && terr[r * 256 + q] >> 3 === 0) c = SAFE_COLOR; }
        if (c) {
          const o = (r * 256 + q) * 4;
          px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
        }
      }
    }
  }
  return encodePng(img);
}
async function encodePng(img) {
  const cv = new OffscreenCanvas(256, 256);
  cv.getContext('2d').putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}
