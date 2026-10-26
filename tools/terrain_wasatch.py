#!/usr/bin/env python3
"""Terrain products for the Central Wasatch, built once and served as static files.

1. Avalanche terrain, following AutoATES v2.0 (Toft et al. 2024, NHESS 24:1779; code and default
   thresholds from github.com/AutoATES/AutoATES-v2.0, AutoATES_classifier.py):
   - start zones: 28–60° (SAT23; the 60° top is a modelling choice) where tree canopy is 50% or less
     (TREE2, the "sparse" upper bound; AutoATES's own start-zone model also uses forest and wind
     shelter, simplified here to this one forest cut)
   - runout reach by the energy-line (alpha angle) method: 18° (AAT1), 24° (AAT2), 33° (AAT3)
   - how many start-zone cells feed each cell (CC1 = 5, CC2 = 40)
   - ATES class = the worst of slope class (15/18/28/39°), runout class and count class, then
     downgraded for forest with AutoATES's own lookup table (canopy 10/50/65%)
   Tree canopy: USFS/NLCD Tree Canopy Cover 2025 (30 m).
   Output: tiles/runout/{z}/{x}/{y}.png, one byte per pixel = runout class × 8 + ATES class
     runout class: 0 none · 1 extended reach (18°) · 2 typical reach (24°) · 3 start zone
     ATES class:   0 non-avalanche · 1 simple · 2 challenging · 3 complex · 4 extreme
2. Little Cottonwood tours: rough lines from tools/lcc_tours.json, the lowest-cost way across the
   terrain where cost grows with slope, ATES class and mapped avalanche paths.
   That's the "longer but safer" preference Cody Townsend describes, written down as numbers.
   Output: data/lcc_tours.geojson
3. Streams for terrain-trap checks: USGS NHD large-scale flowlines. Output: data/nhd_streams.geojson

Elevation: AWS Terrain Tiles (Terrarium), USGS 3DEP in the US, zoom 13 (~11 m cells here).

Run:  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
      .venv/bin/python -I tools/terrain_wasatch.py
"""
import io
import json
import math
import os
import time
import urllib.parse
import urllib.request

import numpy as np
from numba import njit
from PIL import Image, ImageDraw
from skimage.graph import MCP_Geometric

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'tools', '.cache', 'terrarium')
DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
Z = 13
BBOX = (-111.86, 40.48, -111.50, 40.70)          # west, south, east, north
OUT_ZOOMS = (11, 12, 13, 14)

TCC_URL = 'https://imagery.geoplatform.gov/iipp/rest/services/Vegetation/USFS_EDW_NLCD_TCC_CONUS/ImageServer'
TCC_RASTER_ID = 80                                 # nlcd_tcc_conus ... 2025

# AutoATES v2.0 defaults (AutoATES_classifier.py)
SAT01, SAT12, SAT23, SAT34 = 15, 18, 28, 39
AAT1, AAT2, AAT3 = 18, 24, 33
TREE1, TREE2, TREE3 = 10, 50, 65                   # percent canopy cover ('pcc')
CC1, CC2 = 5, 40
RELEASE_MIN, RELEASE_MAX = float(SAT23), 60.0
ALPHA_TYPICAL, ALPHA_EXTENDED = float(AAT2), float(AAT1)
# AutoATES forest step: (start zone ? 100 : 0) + forest class (10 open … 40 very dense) + ATES class → new ATES class
FOREST_TABLE = {10: 0, 11: 1, 12: 2, 13: 3, 14: 4, 20: 0, 21: 1, 22: 1, 23: 2, 24: 3, 30: 0, 31: 1, 32: 1, 33: 1, 34: 3,
                40: 0, 41: 1, 42: 1, 43: 1, 44: 2, 110: 0, 111: 1, 112: 2, 113: 3, 114: 4, 120: 0, 121: 1, 122: 1, 123: 2,
                124: 3, 130: 0, 131: 1, 132: 1, 133: 2, 134: 3, 140: 0, 141: 1, 142: 1, 143: 2, 144: 2}

# Tour cost: the per-metre cost of crossing a cell. Preferences, not data: they say "prefer lower
# angles, avoid cliffs, avoid ground that slides can reach", in that order.
def slope_cost(s):
    c = 1 + np.clip((s - 15) / 10, 0, None) ** 2   # 1 up to 15°, 2 at 25°, 3.25 at 30°, 5 at 35°
    return np.where(s > 45, c * 25, c)             # cliffs: go around if at all possible
ATES_COST = {0: 1.0, 1: 1.0, 2: 1.15, 3: 1.4, 4: 2.0}  # by forest-adjusted ATES class
MAPPED_PATH_COST = 1.5


def lon2x(lon, z): return (lon + 180) / 360 * 2 ** z
def lat2y(lat, z):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z
def x2lon(x, z): return x / 2 ** z * 360 - 180
def y2lat(y, z): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** z))))


def fetch(url, path):
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'wasatch-bc-atlas'}), timeout=60) as r:
                    data = r.read()
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
        with open(path, 'wb') as f:
            f.write(data)
    with open(path, 'rb') as f:
        return f.read()


def load_dem():
    x0, x1 = int(lon2x(BBOX[0], Z)), int(lon2x(BBOX[2], Z))
    y0, y1 = int(lat2y(BBOX[3], Z)), int(lat2y(BBOX[1], Z))
    dem = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float64)
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            raw = fetch(DEM_URL.format(z=Z, x=tx, y=ty), os.path.join(CACHE, str(Z), str(tx), f'{ty}.png'))
            a = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float64)
            dem[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    return dem, x0, y0


def cell_sizes(rows, y0):
    py = y0 * 256 + np.arange(rows) + 0.5
    lat = np.arctan(np.sinh(np.pi - 2 * np.pi * py / (256 * 2 ** Z)))
    return 40075016.686 * np.cos(lat) / (256 * 2 ** Z)


def slope_deg(dem, cs):
    p = np.pad(dem, 1, mode='edge')
    a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
    d, f = p[1:-1, :-2], p[1:-1, 2:]
    g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
    k = (8 * cs)[:, None]
    gx = ((c + 2 * f + i) - (a + 2 * d + g)) / k
    gy = ((g + 2 * h + i) - (a + 2 * b + c)) / k
    return np.degrees(np.arctan(np.hypot(gx, gy)))


# Neighbours in circular order (E, NE, N, NW, W, SW, S, SE) so "either side of the steepest" is ±1
DR = np.array([0, -1, -1, -1, 0, 1, 1, 1])
DC = np.array([1, 1, 0, -1, -1, -1, 0, 1])
DIAG = np.array([0, 1, 0, 1, 0, 1, 0, 1])


@njit(cache=True)
def runout(z, release, order, cs, tan_a, dr, dc, diag):
    """Energy-line runout. Cells are visited from the highest down; each reached cell passes its
    energy-line height to its steepest-descent neighbour and the two either side of it, losing
    tan(alpha) per metre travelled. A cell is reached while the energy line is at or above it."""
    H, W = z.shape
    L = np.full((H, W), -1e9)
    reached = np.zeros((H, W), np.bool_)
    for idx in order:
        r = idx // W
        c = idx % W
        zc = z[r, c]
        if release[r, c] and zc > L[r, c]:
            L[r, c] = zc
        if L[r, c] < zc:
            continue
        reached[r, c] = True
        best = -1
        bestdrop = 0.0
        drops = np.zeros(8)
        dists = np.zeros(8)
        for k in range(8):
            nr = r + dr[k]
            nc = c + dc[k]
            if nr < 0 or nr >= H or nc < 0 or nc >= W:
                drops[k] = -1.0
                continue
            d = cs[r] * (1.4142135623730951 if diag[k] else 1.0)
            dists[k] = d
            drops[k] = (zc - z[nr, nc]) / d
            if drops[k] > bestdrop:
                bestdrop = drops[k]
                best = k
        if best < 0:
            continue
        for j in (-1, 0, 1):
            k = (best + j) % 8
            if drops[k] <= 0:
                continue
            nr = r + dr[k]
            nc = c + dc[k]
            e = L[r, c] - tan_a * dists[k]
            if e > L[nr, nc]:
                L[nr, nc] = e
    return reached


def load_canopy(shape, x0, y0):
    """Tree canopy % on exactly the DEM grid (Web Mercator), from the USFS image service."""
    path = os.path.join(ROOT, 'tools', '.cache', f'tcc_{TCC_RASTER_ID}_{Z}_{x0}_{y0}_{shape[1]}x{shape[0]}.tif')
    R = 6378137.0
    world = 2 * math.pi * R
    mx = lambda px: px / (256 * 2 ** Z) * world - math.pi * R
    my = lambda py: math.pi * R - py / (256 * 2 ** Z) * world
    bbox = f'{mx(x0 * 256)},{my(y0 * 256 + shape[0])},{mx(x0 * 256 + shape[1])},{my(y0 * 256)}'
    rule = json.dumps({'mosaicMethod': 'esriMosaicLockRaster', 'lockRasterIds': [TCC_RASTER_ID]})
    url = (f'{TCC_URL}/exportImage?bbox={bbox}&bboxSR=3857&imageSR=3857&size={shape[1]},{shape[0]}&format=tiff'
           f'&pixelType=U8&interpolation=RSP_NearestNeighbor&mosaicRule={urllib.parse.quote(rule)}&f=image')
    a = np.array(Image.open(io.BytesIO(fetch(url, path)))).astype(np.int16)
    return np.where(a > 100, 0, a)


@njit(cache=True)
def feed_counts(z, release, reached, order, dr, dc, diag, cs):
    """How many start-zone cells drain through each cell (steepest descent, inside the reach)."""
    H, W = z.shape
    cnt = np.zeros((H, W), np.int32)
    for idx in order:
        r = idx // W
        c = idx % W
        if release[r, c]:
            cnt[r, c] += 1
        if not reached[r, c] or cnt[r, c] == 0:
            continue
        best = -1
        bestdrop = 0.0
        for k in range(8):
            nr = r + dr[k]
            nc = c + dc[k]
            if nr < 0 or nr >= H or nc < 0 or nc >= W:
                continue
            d = (z[r, c] - z[nr, nc]) / (cs[r] * (1.4142135623730951 if diag[k] else 1.0))
            if d > bestdrop:
                bestdrop = d
                best = k
        if best >= 0 and reached[r + dr[best], c + dc[best]]:
            cnt[r + dr[best], c + dc[best]] += cnt[r, c]
    return cnt


def ates_classes(slope, release, r18, r24, r33, counts, canopy):
    sc = np.zeros(slope.shape, np.int16)
    sc[slope > SAT01] = 1
    sc[slope > SAT12] = 2
    sc[slope > SAT23] = 3
    p = np.pad(slope, 1, mode='edge')
    smooth = sum(p[i:i + slope.shape[0], j:j + slope.shape[1]] for i in range(3) for j in range(3)) / 9
    sc[smooth > SAT34] = 4
    fp = np.where(r33, 3, np.where(r24, 2, np.where(r18, 1, 0)))
    cc = np.where(counts > CC2, 3, np.where(counts > CC1, 2, np.where(counts > 0, 1, 0)))
    ates = np.maximum(np.maximum(sc, fp), cc)
    forest = np.where(canopy <= TREE1, 10, np.where(canopy <= TREE2, 20, np.where(canopy < TREE3, 30, 40)))
    key = np.where(release, 100, 0) + forest + ates
    out = np.zeros(slope.shape, np.uint8)
    for k, v in FOREST_TABLE.items():
        out[key == k] = v
    return out


def write_tiles(cls, x0, y0):
    out = os.path.join(ROOT, 'tiles', 'runout')
    count = 0
    for z in OUT_ZOOMS:
        if z == Z:
            grid, gx0, gy0 = cls, x0, y0
        elif z > Z:
            f = 2 ** (z - Z)
            grid, gx0, gy0 = np.repeat(np.repeat(cls, f, 0), f, 1), x0 * f, y0 * f
        else:
            f = 2 ** (Z - z)
            # tiles at a coarser zoom: pad to whole tiles, then take the worst class in each block
            ox, oy = (x0 % f) * 256, (y0 % f) * 256
            H, W = cls.shape
            Hp = -(-(H + oy) // (256 * f)) * 256 * f
            Wp = -(-(W + ox) // (256 * f)) * 256 * f
            big = np.zeros((Hp, Wp), np.uint8)
            big[oy:oy + H, ox:ox + W] = cls
            grid = big.reshape(Hp // f, f, Wp // f, f).max(axis=(1, 3))
            gx0, gy0 = x0 // f, y0 // f
        th, tw = grid.shape[0] // 256, grid.shape[1] // 256
        for ty in range(th):
            for tx in range(tw):
                t = grid[ty * 256:(ty + 1) * 256, tx * 256:(tx + 1) * 256]
                if not t.any():
                    continue
                d = os.path.join(out, str(z), str(gx0 + tx))
                os.makedirs(d, exist_ok=True)
                Image.fromarray(t.astype(np.uint8)).save(os.path.join(d, f'{gy0 + ty}.png'), optimize=True)
                count += 1
    with open(os.path.join(out, 'meta.json'), 'w') as f:
        json.dump({
            'bbox': BBOX, 'zooms': OUT_ZOOMS, 'source_zoom': Z,
            'encoding': 'byte = runout class * 8 + ATES class',
            'runout_classes': {'0': 'none', '1': f'extended reach (alpha {AAT1}°)', '2': f'typical reach (alpha {AAT2}°)', '3': f'start zone ({SAT23}–60°, canopy ≤ {TREE2}%)'},
            'ates_classes': {'0': 'non-avalanche', '1': 'simple', '2': 'challenging', '3': 'complex', '4': 'extreme'},
            'method': 'AutoATES v2.0 default thresholds (SAT01-34, AAT1-3, TREE1-3, CC1-2) and forest table; simplified start zones (slope + canopy only), energy-line runout along steepest descent ± one direction, feed counts by steepest descent. Not validated for the Wasatch.',
            'elevation': 'AWS Terrain Tiles (Terrarium), USGS 3DEP, zoom 13',
            'canopy': 'USFS/NLCD Tree Canopy Cover 2025 (raster id 80), 30 m',
            'built': time.strftime('%Y-%m-%d'),
        }, f, indent=1)
    return count


def mapped_paths_mask(shape, x0, y0):
    with open(os.path.join(ROOT, 'data', 'avalanche_paths.geojson')) as f:
        gj = json.load(f)
    img = Image.new('L', (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(img)
    to_px = lambda lon, lat: ((lon2x(lon, Z) - x0) * 256, (lat2y(lat, Z) - y0) * 256)
    for feat in gj['features']:
        g = feat['geometry']
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        for poly in polys:
            draw.polygon([to_px(*p) for p in poly[0]], fill=1)
    return np.asarray(img).astype(bool)


def haversine(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    n = np.hypot(*ab) or 1e-12
    q = np.array(pts[1:-1]) - a
    d = np.abs(ab[0] * q[:, 1] - ab[1] * q[:, 0]) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        return rdp(pts[:i + 2], eps)[:-1] + rdp(pts[i + 1:], eps)
    return [pts[0], pts[-1]]


def build_tours(dem, slope, ates, mapped, x0, y0):
    with open(os.path.join(ROOT, 'tools', 'lcc_tours.json')) as f:
        cfg = json.load(f)
    pts = cfg['points']
    cost = slope_cost(slope)
    cost = cost * np.vectorize(ATES_COST.get)(ates)
    cost = np.where(mapped, cost * MAPPED_PATH_COST, cost)
    mcp_cache = {}
    to_rc = lambda p: (int((lat2y(p['lat'], Z) - y0) * 256), int((lon2x(p['lon'], Z) - x0) * 256))
    to_ll = lambda r, c: (x2lon(x0 + (c + 0.5) / 256, Z), y2lat(y0 + (r + 0.5) / 256, Z))
    feats = []
    for t in cfg['tours']:
        stops = [t['from'], *t['via'], t['to']]
        path = []
        for a, b in zip(stops, stops[1:]):
            ra, rb = to_rc(pts[a]), to_rc(pts[b])
            m = mcp_cache.get(a)
            if m is None:
                m = MCP_Geometric(cost, fully_connected=True)
                m.find_costs([ra])
                mcp_cache[a] = m
            leg = m.traceback(rb)
            path.extend(leg if not path else leg[1:])
        ll = [to_ll(r, c) for r, c in path]
        # stats along the full-resolution path (zoom 13 elevation; the app recomputes at zoom 14)
        dist = sum(haversine(ll[i - 1], ll[i]) for i in range(1, len(ll)))
        el = [dem[r, c] for r, c in path]
        gain = sum(max(0, el[i] - el[i - 1]) for i in range(1, len(el)))
        sl = [slope[r, c] for r, c in path]
        cl = [int(ates[r, c]) for r, c in path]
        seg = [haversine(ll[i - 1], ll[i]) for i in range(1, len(ll))]
        by_ates = [round(sum(s for s, k in zip(seg, cl[1:]) if k == a) / 1609.344, 2) for a in range(5)]
        simple = rdp([list(p) for p in ll], 0.00006)
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'LineString', 'coordinates': [[round(x, 6), round(y, 6)] for x, y in simple]},
            'properties': {
                'id': t['id'], 'name': t['name'], 'from': t['from'], 'via': t['via'], 'to': t['to'],
                'uac': t['uac'], 'onx': t['onx'],
                'points': {k: pts[k] for k in stops},
                'approx': {
                    'distance_mi': round(dist / 1609.344, 2), 'gain_ft': int(round(gain * 3.28084, -1)),
                    'high_ft': int(round(max(el) * 3.28084, -1)), 'max_slope': int(round(max(sl))),
                    'ates_mi': by_ates,
                },
            },
        })
        print(f"  {t['name']}: {feats[-1]['properties']['approx']}")
    return {
        'type': 'FeatureCollection', 'features': feats,
        'source': {
            'what': 'Computed rough lines, not surveyed routes. Lowest-cost path across zoom-13 elevation, cost rising with slope, with the forest-adjusted ATES class and inside mapped avalanche paths.',
            'cost': {'slope': '1 up to 15°, 1+((s-15)/10)^2 above, x25 over 45°', 'ates_class': ATES_COST, 'mapped_path': MAPPED_PATH_COST},
            'ates_mi': 'miles in ATES class 0 non-avalanche, 1 simple, 2 challenging, 3 complex, 4 extreme',
            'points': 'OpenStreetMap (© OpenStreetMap contributors, ODbL) and USGS GNIS; ids on each feature',
            'names': 'Tour names from onX Backcountry screenshots and Utah Avalanche Center route-rating pages',
            'elevation': 'AWS Terrain Tiles (Terrarium), USGS 3DEP',
            'built': time.strftime('%Y-%m-%d'),
        },
    }


def fetch_streams():
    url = ('https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query?where=1%3D1'
           f'&geometry={BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326'
           '&outFields=gnis_name,ftype&returnGeometry=true&geometryPrecision=5&f=geojson')
    feats, offset = [], 0
    while True:
        with urllib.request.urlopen(url + f'&resultOffset={offset}&resultRecordCount=1000', timeout=120) as r:
            d = json.load(r)
        page = d.get('features', [])
        feats += [{'type': 'Feature', 'geometry': f['geometry'], 'properties': {'name': f['properties'].get('gnis_name')}}
                  for f in page if f['properties'].get('ftype') in (460, 558)]
        if not d.get('exceededTransferLimit') or not page:
            break
        offset += len(page)
    out = {'type': 'FeatureCollection', 'features': feats, 'source': {
        'name': 'USGS National Hydrography Dataset, large-scale flowlines (stream/river and artificial path)',
        'service': 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6', 'retrieved': time.strftime('%Y-%m-%d')}}
    with open(os.path.join(ROOT, 'data', 'nhd_streams.geojson'), 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    return len(feats)


def main():
    t0 = time.time()
    dem, x0, y0 = load_dem()
    print(f'DEM {dem.shape} from tile {x0},{y0} ({time.time() - t0:.0f}s)')
    cs = cell_sizes(dem.shape[0], y0)
    slope = slope_deg(dem, cs)
    canopy = load_canopy(dem.shape, x0, y0)
    release = (slope >= RELEASE_MIN) & (slope <= RELEASE_MAX) & (canopy <= TREE2)
    order = np.argsort(-dem.ravel(), kind='stable')
    reach = {a: runout(dem, release, order, cs, math.tan(math.radians(a)), DR, DC, DIAG) for a in (AAT1, AAT2, AAT3)}
    r18, r24, r33 = reach[AAT1], reach[AAT2], reach[AAT3]
    cls = np.zeros(dem.shape, np.uint8)
    cls[r18] = 1
    cls[r24] = 2
    cls[release] = 3
    counts = feed_counts(dem, release, r24, order, DR, DC, DIAG, cs)
    ates = ates_classes(slope, release, r18, r24, r33, counts, canopy)
    print(f'canopy median {np.median(canopy):.0f}%; start {release.mean():.1%}, typical reach {r24.mean():.1%}, extended {r18.mean():.1%} ({time.time() - t0:.0f}s)')
    print('ATES share:', {n: f'{(ates == i).mean():.1%}' for i, n in enumerate(['non', 'simple', 'challenging', 'complex', 'extreme'])})
    print(f'tiles written: {write_tiles(cls * 8 + ates, x0, y0)}')
    mapped = mapped_paths_mask(dem.shape, x0, y0)
    tours = build_tours(dem, slope, ates, mapped, x0, y0)
    with open(os.path.join(ROOT, 'data', 'lcc_tours.geojson'), 'w') as f:
        json.dump(tours, f, separators=(',', ':'))
    print(f'streams: {fetch_streams()}  ({time.time() - t0:.0f}s total)')


if __name__ == '__main__':
    main()
