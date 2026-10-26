// Avalanche data shared by the home page and the backcountry map: UAC Salt Lake danger (via the
// worker's /api/avalanche, which reads avalanche.org's public API) and the weather red flags.

// North American Public Avalanche Danger Scale: names and colours (avalanche.org)
const DANGER = [
  null,
  { name: 'Low', color: '#50b848', ink: '#0b1a06' },
  { name: 'Moderate', color: '#fff200', ink: '#1d1a00' },
  { name: 'Considerable', color: '#f7941e', ink: '#1f1000' },
  { name: 'High', color: '#ed1c24', ink: '#fff' },
  { name: 'Extreme', color: '#231f20', ink: '#fff', border: '#ed1c24' },
];
const UAC_SALT_LAKE = 'https://utahavalanchecenter.org/forecast/salt-lake';

// Red-flag thresholds, each with its source
const FLAGS = {
  newSnowIn: 12,      // avalanche.org, "Loading / Loading Rate": a foot of new snow in 24 hours
  waterIn: 1,         // avalanche.org, same page: an inch of snow water equivalent in 24 hours
  windMph: 15,        // Avalanche Canada glossary, "wind transport": 25–40 km/h builds wind slabs best
};

async function fetchAvalanche(asOf) {
  const key = 'avy-v1' + (asOf || '');
  try {
    const c = JSON.parse(localStorage.getItem(key));
    if (c && Date.now() - c.at < 30 * 60e3) return c.data;
  } catch { /* storage unavailable */ }
  const r = await fetch('api/avalanche' + (asOf ? `?asOf=${asOf}` : ''), { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${r.status} from the avalanche feed`);
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* quota */ }
  return data;
}

// Wind blowing FROM `deg` loads the slopes facing the same way it blows TO (the lee side)
function leeAspects(deg) {
  if (deg == null) return [];
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const to = (deg + 180) % 360;
  const i = Math.round(to / 45) % 8;
  return [names[(i + 7) % 8], names[i], names[(i + 1) % 8]];
}

// Atwater SNOTEL daily series → [{date, depth, gain, water}]
function snotelDaily(snotel) {
  const d = snotel?.[0]?.data;
  if (!d) return [];
  const series = code => Object.fromEntries((d.find(e => e.stationElement.elementCode === code)?.values || []).map(v => [v.date.slice(0, 10), v.value]));
  const D = series('SNWD'), P = series('PREC'), T = series('TOBS');
  const dates = Object.keys(D).sort();
  return dates.slice(1).map((dt, i) => {
    const prev = dates[i];
    const dd = D[dt] != null && D[prev] != null ? D[dt] - D[prev] : null;
    const pw = P[dt] != null && P[prev] != null ? P[dt] - P[prev] : null;
    return { date: dt, depth: D[dt], gain: dd != null && dd > 0 ? dd : 0, change: dd, water: pw != null && pw >= 0 && pw < 6 ? pw : null, temp: T[dt] };
  });
}

Object.assign(globalThis, { DANGER, UAC_SALT_LAKE, FLAGS, fetchAvalanche, leeAspects, snotelDaily });
