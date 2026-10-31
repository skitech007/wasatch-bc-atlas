// Daily snow as solid bars, one colour per day: blue snow, purple snow/rain mix, green rain, and
// orange for a 6"+ day. Shared by the home screen, the resorts list and each resort's forecast page.
// Days come from build() in forecast-data.js.

// What falls: from the share of the water that comes down as snow (null when dry)
function precipType({ snow, water, frac }) {
  if ((snow || 0) < 0.05 && (water || 0) < 0.01) return 'none';
  if (frac == null || frac >= 0.85) return 'snow';
  return frac <= 0.15 ? 'rain' : 'mix';
}
const PTYPE_NAME = { snow: 'Snow', mix: 'Snow/rain mix', rain: 'Rain', none: 'Dry' };
// Colour (used as class t-<colour>): orange wins for a day that rounds to 6"+
const snowClass = d => (d.snow ?? 0) >= POWDER_IN - 0.5 ? 'pow' : precipType(d);
const snowLabel = v => v == null ? '' : v >= 0.5 ? Math.round(v) + '"' : v > 0.05 ? 'T' : '';

// Likely range: the ensembles' middle half, scaled so it sits around the blend. The blend sets
// the amount, the ensembles say how sure we are.
function likelyRange(ens, blend) {
  if (!ens || blend == null) return null;
  return [Math.max(0, blend - (ens.p50 - ens.p25)), blend + (ens.p75 - ens.p50)];
}
function rangeText(ens, blend) {
  const r = likelyRange(ens, blend);
  if (r) {
    const lo = Math.round(r[0]), hi = Math.round(r[1]);
    if (hi <= 0) return '0"';
    return lo === hi ? `${lo}"` : `${lo}–${hi}"`;
  }
  return blend == null ? '–' : `${Math.round(blend)}"`;
}

// days: build().days (or a slice). max: inches at full height, so separate groups share a scale.
// marks: indexes that start a new 5-day block (dashed line before them). tipAttr: 'data-tip' on
// pages with their own tooltip (forecast.js), else the browser's title. tight: drop the inch mark
// from the labels (on by default past 10 columns; the forecast summary's three side-by-side
// groups of 5 are just as narrow on a phone).
function snowBars(days, { max, marks = [5, 10], todayFirst = true, compact = false, tipAttr = 'title', tight = days.length > 10 } = {}) {
  const top = max ?? Math.max(4, ...days.map(d => d.snow || 0));
  return `<div class="sb${compact ? ' compact' : ''}" style="--n:${days.length}">${days.map((d, i) => {
    const v = d.snow || 0, cls = snowClass(d), type = precipType(d);
    const lr = likelyRange(d.ens, d.snow);
    const tip = `${dow(d.date)} ${dom(d.date)}: ${v.toFixed(1)}" ${type === 'none' ? '' : PTYPE_NAME[type].toLowerCase()}`
      + (lr && lr[1] >= 0.5 ? ` · likely ${rangeText(d.ens, d.snow)}` : '')
      + (d.ens ? ` · ${Math.round(d.ens.pPowder)}% chance of ${POWDER_IN}"+` : '');
    // Compact rows (the resorts list) only label the 6"+ days, without the inch mark so neighbours
    // don't touch; the group totals carry the rest
    // Tight rows drop the inch mark too (the legend says inches), so two-digit neighbours like
    // 14 and 18 never run together on a 390 pt phone
    const lab = tight ? snowLabel(v).replace('"', '') : snowLabel(v);
    const label = compact ? (cls === 'pow' ? Math.round(v) : '') : type === 'rain' && v < 0.5 ? '<small>rain</small>' : lab;
    const isToday = todayFirst && i === 0;
    return `<div class="sb-col${isToday ? ' today' : ''}${marks.includes(i) ? ' wk' : ''}" ${tipAttr}="${tip.replace(/"/g, '&quot;')}">
      <div class="sb-area"><i class="t-${cls}" style="height:${type === 'none' ? 0 : Math.max(4, Math.min(100, 100 * v / top))}%">${label === '' ? '' : `<span class="sb-v">${label}</span>`}</i></div>
      <span class="sb-d">${isToday ? 'Tdy' : dow(d.date).slice(0, compact ? 1 : 2)}<br><b>${dom(d.date)}</b></span>
    </div>`;
  }).join('')}</div>`;
}

const snowLegend = () => `<div class="sb-legend"><span><i class="t-snow"></i>Snow</span><span><i class="t-mix"></i>Mix</span><span><i class="t-rain"></i>Rain</span><span><i class="t-pow"></i>${POWDER_IN}"+ day</span><span class="sb-unit">Inches</span></div>`;

// Weather glyph for a period or hour: inline SVG from theme.js, with a text name for screen readers
function wxKind({ snow, water, frac, cc, isDay }) {
  if (snow >= 0.1 && frac >= 0.5) return ['snow', 'Snow'];
  if (water >= 0.01 && frac < 0.5) return ['rain', 'Rain'];
  if (water >= 0.01) return ['snow', 'Light snow'];
  if (cc == null) return ['', ''];
  if (cc < 25) return isDay ? ['clear', 'Clear'] : ['night', 'Clear'];
  if (cc < 60) return isDay ? ['partly', 'Partly cloudy'] : ['cloud', 'Partly cloudy'];
  return ['cloud', 'Cloudy'];
}
function wxIcon(x) {
  const [k, name] = wxKind(x);
  return k ? `<span class="wx wx-${k}" role="img" aria-label="${name}" title="${name}">${globalThis.ICON?.wx?.[k] || ''}</span>` : '';
}

// Today's day and night periods, or tomorrow's once today's daytime is over (after 6 pm)
function dayAhead(b) {
  const pick = date => ({ day: b.periods.find(p => p.isDay && p.date === date), night: b.periods.find(p => !p.isDay && p.date === date) });
  const t = pick(b.today);
  return t.day ? { label: 'Today', ...t } : { label: 'Tomorrow', ...pick(addDays(b.today, 1)) };
}

// The biggest run of consecutive 2"+ days in the next 15. A day under 2" ends a storm, so the 1–2"
// days the ensemble average spreads past day 7 do not chain into one long "storm".
// Returns null when no day reaches 2"; `first` says whether it is also the next storm.
function biggestStorm(days) {
  const runs = [];
  let cur = null;
  days.forEach((d, i) => {
    if ((d.snow || 0) >= 2) {
      cur ||= { from: i, to: i, total: 0, peak: d, pow: 0 };
      cur.to = i; cur.total += d.snow;
      if (d.snow > cur.peak.snow) cur.peak = d;
      cur.pow = Math.max(cur.pow, d.ens?.pPowder ?? 0);
    } else if (cur) { runs.push(cur); cur = null; }
  });
  if (cur) runs.push(cur);
  if (!runs.length) return null;
  const s = runs.reduce((a, r) => r.total > a.total ? r : a);
  const a = days[s.from].date, z = days[s.to].date;
  return { ...s, first: s === runs[0], when: s.from === s.to ? `${dow(a)} ${dom(a)}` : `${dow(a)} ${dom(a)} – ${dow(z)} ${dom(z)}` };
}
