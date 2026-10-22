"""Measure how each weather model misses at Alta, for forecasts made 1 to 7 days ahead.

Three corrections, all against the NRCS Atwater SNOTEL (1308:UT:SNTL, 8,750 ft, in Alta):
  1. Precipitation: observed ÷ forecast water, per model and lead day.
  2. Storm direction: how that ratio changes with the 700 mb wind direction (NW, W, SW, other),
     per model, shrunk toward 1 when a direction has few wet days.
  3. Temperature: mean observed − forecast °F, per model, lead day, and day/night.

Forecasts come from Open-Meteo's Previous Runs archive (what each model said N days before);
past 700 mb wind direction from Open-Meteo's archived short-range GFS. Wind can't be calibrated
here (no SNOTEL near Alta measures wind); the nightly worker learns it from Hidden Peak instead.
Writes data/alta_calibration.json.

Run: python3 -I tools/calibrate_alta.py
"""
import json, math, urllib.request, datetime as dt, pathlib
from collections import defaultdict

FC_LAT, FC_LON, FC_ELEV_M = 40.5884, -111.6386, 3016   # 9,895 ft, OpenSnow's Alta forecast point
ST_LAT, ST_LON, ST_ELEV_M = 40.5912, -111.6378, 2667   # Atwater SNOTEL, 8,750 ft
STATION = '1308:UT:SNTL'
MODELS = ['ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global', 'gem_seamless']
LEADS = range(1, 8)
# Winter months only, when Alta's precipitation is mostly snow. The Previous Runs archive starts in 2024.
SEASONS = [('2024-11-15', '2025-04-15'), ('2025-11-15', '2026-04-15')]
MST = dt.timedelta(hours=-7)  # SNOTEL reports in local standard time all year
SHRINK_DAYS = 15              # a direction needs about this many wet days before its multiplier counts fully


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'wasatch-bc-atlas'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def snotel(element, duration, start, end):
    d = get(f'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets={STATION}'
            f'&elements={element}&duration={duration}&beginDate={start}&endDate={end}')
    return [(v['date'], v.get('value')) for v in d[0]['data'][0]['values']]


def observed_water(start, end):
    """Daily water (in) from the accumulated-precipitation gauge, by MST date."""
    s = (dt.date.fromisoformat(start) - dt.timedelta(days=1)).isoformat()
    vals = [(d[:10], v) for d, v in snotel('PREC', 'DAILY', s, end)]
    out = {}
    for (_, a), (d1, b) in zip(vals, vals[1:]):
        if a is not None and b is not None and 0 <= b - a < 6:  # drop gauge resets and spikes
            out[d1] = b - a
    return out


def observed_temps(start, end):
    """Hourly °F keyed by UTC hour 'YYYY-MM-DDTHH:00', with sensor glitches dropped."""
    out, prev = {}, None
    for d, v in snotel('TOBS', 'HOURLY', f'{start}%2000:00', f'{end}%2023:00'):
        if v is None or not -40 < v < 85 or (prev is not None and abs(v - prev) > 15):
            prev = v if v is not None else prev
            continue
        prev = v
        utc = dt.datetime.fromisoformat(d) - MST
        out[utc.strftime('%Y-%m-%dT%H:00')] = v
    return out


def previous_runs(lat, lon, elev, var, start, end, unit=''):
    hourly = [f'{var}_previous_day{n}' for n in LEADS]
    d = get('https://previous-runs-api.open-meteo.com/v1/forecast'
            f'?latitude={lat}&longitude={lon}&elevation={elev}&start_date={start}&end_date={end}'
            f'&hourly={",".join(hourly)}&models={",".join(MODELS)}{unit}&timezone=GMT')
    return d['hourly']


def mst_date(utc_key):
    return (dt.datetime.fromisoformat(utc_key) + MST).date().isoformat()


def flow_by_day(start, end):
    """Speed-weighted mean 700 mb wind direction per MST day, from archived short-range GFS."""
    d = get('https://historical-forecast-api.open-meteo.com/v1/forecast'
            f'?latitude={FC_LAT}&longitude={FC_LON}&start_date={start}&end_date={end}'
            '&hourly=wind_direction_700hPa,wind_speed_700hPa&models=gfs_global&timezone=GMT')
    h = d['hourly']
    acc = defaultdict(lambda: [0.0, 0.0])
    for t, wd, ws in zip(h['time'], h['wind_direction_700hPa'], h['wind_speed_700hPa']):
        if wd is None or ws is None:
            continue
        a = acc[mst_date(t)]
        a[0] += ws * math.sin(math.radians(wd)); a[1] += ws * math.cos(math.radians(wd))
    return {day: (math.degrees(math.atan2(x, y)) + 360) % 360 for day, (x, y) in acc.items()}


def sector(deg):
    """Wasatch storm flow: NW favours Little Cottonwood; W and SW are the usual prefrontal flows."""
    if deg >= 285 or deg < 15: return 'NW'
    if deg >= 225: return 'W'
    if deg >= 135: return 'SW'
    return 'other'


# ---------- gather ----------
water_pairs = {m: {n: [] for n in LEADS} for m in MODELS}   # (date, observed, forecast)
temp_err = {m: {n: {'day': [], 'night': []} for n in LEADS} for m in MODELS}
flow = {}
observed_total = 0.0
for start, end in SEASONS:
    obs = observed_water(start, end)
    observed_total += sum(obs.values())
    flow.update(flow_by_day(start, end))

    h = previous_runs(FC_LAT, FC_LON, FC_ELEV_M, 'precipitation', start, end, '&precipitation_unit=inch')
    for m in MODELS:
        for n in LEADS:
            daily, seen = defaultdict(float), defaultdict(int)
            for t, v in zip(h['time'], h[f'precipitation_previous_day{n}_{m}']):
                if v is not None:
                    daily[mst_date(t)] += v; seen[mst_date(t)] += 1
            for day, o in obs.items():
                if seen.get(day) == 24:
                    water_pairs[m][n].append((day, o, daily[day]))

    tobs = observed_temps(start, end)
    h = previous_runs(ST_LAT, ST_LON, ST_ELEV_M, 'temperature_2m', start, end, '&temperature_unit=fahrenheit')
    for i, t in enumerate(h['time']):
        o = tobs.get(t)
        if o is None:
            continue
        local_hour = (dt.datetime.fromisoformat(t) + MST).hour
        part = 'day' if 7 <= local_hour < 19 else 'night'
        for m in MODELS:
            for n in LEADS:
                f = h[f'temperature_2m_previous_day{n}_{m}'][i]
                if f is not None:
                    temp_err[m][n][part].append(o - f)
    print(start, 'done')

# ---------- precipitation by lead ----------
factors, mae, totals = {}, {}, {}
for m in MODELS:
    factors[m], mae[m], totals[m] = {}, {}, {}
    for n in LEADS:
        p = water_pairs[m][n]
        o = sum(x for _, x, _ in p); f = sum(y for _, _, y in p)
        k = o / f if f else 1.0
        factors[m][n] = round(k, 3)
        mae[m][n] = round(sum(abs(x - y * k) for _, x, y in p) / len(p), 3) if p else None
        totals[m][n] = {'observed': round(o, 2), 'forecast': round(f, 2), 'days': len(p)}

weights = {}
for n in LEADS:
    inv = {m: 1 / mae[m][n] for m in MODELS if mae[m][n]}
    s = sum(inv.values())
    for m in MODELS:
        weights.setdefault(m, {})[n] = round(inv.get(m, 0) / s, 3)

# ---------- storm direction ----------
# Pool leads 1–3 (enough wet days, before skill drops off) and compare each direction's
# observed ÷ forecast ratio with the model's overall ratio.
direction, direction_detail = {}, {}
for m in MODELS:
    pooled = [p for n in (1, 2, 3) for p in water_pairs[m][n] if p[0] in flow]
    o_all = sum(x for _, x, _ in pooled); f_all = sum(y for _, _, y in pooled)
    base = o_all / f_all
    direction[m], direction_detail[m] = {}, {}
    for s in ('NW', 'W', 'SW', 'other'):
        ps = [p for p in pooled if sector(flow[p[0]]) == s]
        o = sum(x for _, x, _ in ps); f = sum(y for _, _, y in ps)
        wet = len({d for d, x, _ in ps if x >= 0.1}) / 3  # pooled over 3 leads
        raw = (o / f) / base if f > 0.3 else 1.0
        shrunk = 1 + (raw - 1) * wet / (wet + SHRINK_DAYS)
        direction[m][s] = round(shrunk, 3)
        direction_detail[m][s] = {'raw': round(raw, 3), 'wet_days': round(wet), 'observed_in': round(o / 3, 2)}

# ---------- temperature ----------
temp_bias, temp_mae = {}, {}
for m in MODELS:
    temp_bias[m], temp_mae[m] = {}, {}
    for n in LEADS:
        temp_bias[m][n], temp_mae[m][n] = {}, {}
        for part in ('day', 'night'):
            e = temp_err[m][n][part]
            b = sum(e) / len(e) if e else 0.0
            temp_bias[m][n][part] = round(b, 2)
            temp_mae[m][n][part] = {
                'before': round(sum(abs(x) for x in e) / len(e), 2) if e else None,
                'after': round(sum(abs(x - b) for x in e) / len(e), 2) if e else None,
                'hours': len(e),
            }

out = {
    'what': "How each model misses at Alta, per lead day (forecast made N days ahead).",
    'observed': f'NRCS SNOTEL {STATION} (Atwater, Alta, 8,750 ft): daily accumulated precipitation (differenced) and hourly air temperature',
    'forecast': 'Open-Meteo Previous Runs API; precipitation at 40.5884, -111.6386, 3,016 m; temperature at the Atwater site, 2,667 m',
    'flow': 'Daily speed-weighted 700 mb wind direction from Open-Meteo archived short-range GFS',
    'seasons': [f'{a} to {b}' for a, b in SEASONS],
    'observed_in': round(observed_total, 2),
    'generated': dt.date.today().isoformat(),
    'factors': factors,
    'daily_mae_in': mae,
    'blend_weights': weights,
    'totals': totals,
    'direction_sectors': {'NW': '285°–15°', 'W': '225°–285°', 'SW': '135°–225°', 'other': '15°–135°'},
    'direction_multipliers': direction,
    'direction_detail': direction_detail,
    'temperature_bias_f': temp_bias,
    'temperature_mae_f': temp_mae,
}
path = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'alta_calibration.json'
path.write_text(json.dumps(out, indent=2) + '\n')
for m in MODELS:
    print(f'{m:16}', ' '.join(f'd{n}:×{factors[m][n]:.2f}' for n in LEADS))
    print(' ' * 17 + 'flow ' + ' '.join(f'{s}:×{direction[m][s]:.2f}(raw {direction_detail[m][s]["raw"]:.2f}, {direction_detail[m][s]["wet_days"]}d)' for s in direction[m]))
    print(' ' * 17 + 'temp ' + ' '.join(f'd{n}:{temp_bias[m][n]["day"]:+.1f}/{temp_bias[m][n]["night"]:+.1f}' for n in LEADS)
          + f'  MAE d1 {temp_mae[m][1]["day"]["before"]}→{temp_mae[m][1]["day"]["after"]}')
