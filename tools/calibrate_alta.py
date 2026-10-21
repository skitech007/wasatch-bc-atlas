"""Measure how much each weather model under- or over-forecasts precipitation at Alta,
separately for forecasts made 1 to 7 days ahead.

Compares Open-Meteo's Previous Runs archive (what each model forecast N days before) for
the Alta forecast point with water measured at the NRCS Atwater SNOTEL (1308:UT:SNTL,
8,750 ft, in Alta). Writes data/alta_calibration.json.

Run: python3 -I tools/calibrate_alta.py
"""
import json, urllib.request, datetime as dt, pathlib
from collections import defaultdict

LAT, LON, ELEV_M = 40.5884, -111.6386, 3016  # 9,895 ft, OpenSnow's Alta forecast point
STATION = '1308:UT:SNTL'
MODELS = ['ncep_nbm_conus', 'ecmwf_ifs025', 'gfs_global', 'gem_seamless']
LEADS = range(1, 8)
# Winter months only, when Alta's precipitation is mostly snow. The Previous Runs archive starts in 2024.
SEASONS = [('2024-11-15', '2025-04-15'), ('2025-11-15', '2026-04-15')]


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'wasatch-bc-atlas'})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def observed(start, end):
    """Daily water (in) from the SNOTEL accumulated-precipitation gauge."""
    s = (dt.date.fromisoformat(start) - dt.timedelta(days=1)).isoformat()
    d = get(f'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets={STATION}'
            f'&elements=PREC&duration=DAILY&beginDate={s}&endDate={end}')
    vals = [(v['date'][:10], v.get('value')) for v in d[0]['data'][0]['values']]
    out = {}
    for (_, a), (d1, b) in zip(vals, vals[1:]):
        if a is None or b is None:
            continue
        inc = b - a
        if 0 <= inc < 6:  # drop gauge resets and spikes
            out[d1] = inc
    return out


def forecast(start, end):
    """{model: {lead: {date: inches}}} from hourly previous-run forecasts summed by local day."""
    hourly = [f'precipitation_previous_day{n}' for n in LEADS]
    d = get('https://previous-runs-api.open-meteo.com/v1/forecast'
            f'?latitude={LAT}&longitude={LON}&elevation={ELEV_M}&start_date={start}&end_date={end}'
            f'&hourly={",".join(hourly)}&models={",".join(MODELS)}&precipitation_unit=inch&timezone=America/Denver')
    h = d['hourly']
    out = {m: {n: defaultdict(float) for n in LEADS} for m in MODELS}
    seen = {m: {n: defaultdict(int) for n in LEADS} for m in MODELS}
    for i, t in enumerate(h['time']):
        day = t[:10]
        for m in MODELS:
            for n in LEADS:
                v = h[f'precipitation_previous_day{n}_{m}'][i]
                if v is not None:
                    out[m][n][day] += v
                    seen[m][n][day] += 1
    # Keep only complete days
    return {m: {n: {day: v for day, v in out[m][n].items() if seen[m][n][day] == 24} for n in LEADS} for m in MODELS}


pairs = {m: {n: [] for n in LEADS} for m in MODELS}
observed_total = 0.0
for start, end in SEASONS:
    obs = observed(start, end)
    observed_total += sum(obs.values())
    fc = forecast(start, end)
    for m in MODELS:
        for n in LEADS:
            for day, o in obs.items():
                f = fc[m][n].get(day)
                if f is not None:
                    pairs[m][n].append((o, f))
    print(start, 'done')

factors, mae, totals = {}, {}, {}
for m in MODELS:
    factors[m], mae[m], totals[m] = {}, {}, {}
    for n in LEADS:
        p = pairs[m][n]
        o = sum(x for x, _ in p); f = sum(y for _, y in p)
        k = o / f if f else 1.0
        factors[m][n] = round(k, 3)
        mae[m][n] = round(sum(abs(x - y * k) for x, y in p) / len(p), 3) if p else None
        totals[m][n] = {'observed': round(o, 2), 'forecast': round(f, 2), 'days': len(p)}

# Blend weights per lead day go as 1 / daily error after correction
weights = {}
for n in LEADS:
    inv = {m: 1 / mae[m][n] for m in MODELS if mae[m][n]}
    s = sum(inv.values())
    for m in MODELS:
        weights.setdefault(m, {})[n] = round(inv.get(m, 0) / s, 3)

out = {
    'what': "Observed ÷ forecast precipitation at Alta, per model and lead day (forecast made N days ahead). "
            "Multiply a model's forecast water by its factor.",
    'observed': f'NRCS SNOTEL {STATION} (Atwater, Alta, 8,750 ft), daily accumulated precipitation, differenced',
    'forecast': 'Open-Meteo Previous Runs API, point 40.5884, -111.6386 at 3,016 m',
    'seasons': [f'{a} to {b}' for a, b in SEASONS],
    'observed_in': round(observed_total, 2),
    'generated': dt.date.today().isoformat(),
    'factors': factors,
    'daily_mae_in': mae,
    'blend_weights': weights,
    'totals': totals,
}
path = pathlib.Path(__file__).resolve().parent.parent / 'data' / 'alta_calibration.json'
path.write_text(json.dumps(out, indent=2) + '\n')
for m in MODELS:
    print(f'{m:16}', ' '.join(f'd{n}:×{factors[m][n]:.2f}/w{weights[m][n]:.2f}' for n in LEADS))
