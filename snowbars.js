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

// The bars under snowStrip()'s block headers, one column a day with a big one-letter day label
// (weekends in bold). max: inches at full height. marks: indexes that start a new 5-day block
// (dashed line before them). tipAttr: the attribute that carries each day's hover text.
// numbers: false leaves the bars unlabelled (the resorts list). Labels drop the inch mark (the
// legend says inches), so two-digit neighbours never run together.
function snowBars(days, { max, marks = [5, 10], todayFirst = true, tipAttr = 'title', numbers = true } = {}) {
  const top = max ?? Math.max(4, ...days.map(d => d.snow || 0));
  return `<div class="sb" style="--n:${days.length}">${days.map((d, i) => {
    const v = d.snow || 0, cls = snowClass(d), type = precipType(d);
    const lr = likelyRange(d.ens, d.snow);
    const tip = `${dow(d.date)} ${dom(d.date)}: ${v.toFixed(1)}" ${type === 'none' ? '' : PTYPE_NAME[type].toLowerCase()}`
      + (lr && lr[1] >= 0.5 ? ` · likely ${rangeText(d.ens, d.snow)}` : '')
      + (d.ens ? ` · ${Math.round(d.ens.pPowder)}% chance of ${POWDER_IN}"+` : '');
    const label = !numbers ? '' : type === 'rain' && v < 0.5 ? '<small>rain</small>' : snowLabel(v).replace('"', '');
    return `<div class="sb-col${todayFirst && i === 0 ? ' today' : ''}${marks.includes(i) ? ' wk' : ''}" data-i="${i}" ${tipAttr}="${tip.replace(/"/g, '&quot;')}">
      <div class="sb-area"><i class="t-${cls}" style="height:${type === 'none' ? 0 : Math.max(4, Math.min(100, 100 * v / top))}%">${label === '' ? '' : `<span class="sb-v">${label}</span>`}</i></div>
      <span class="sb-d${/Sat|Sun/.test(dow(d.date)) ? ' we' : ''}">${dow(d.date)[0]}<b>${dom(d.date)}</b></span>
    </div>`;
  }).join('')}</div>`;
}

// The 15 days as a strip you swipe sideways, so each day gets a readable column and a phone shows
// about a week at a time: the snow measured in the last 24 h, then each 5-day block with its total
// over its bars. last: snotelDaily()'s latest day (leave it out to drop that box); station: its
// SNOTEL's name. Call fitStrips() after putting one on the page.
function snowStrip(days, { last, station, numbers = true, tipAttr = 'title' } = {}) {
  const max = Math.max(4, ...days.map(d => d.snow || 0));
  const heads = [[0, 5, 'Next 1–5 days'], [5, 10, 'Days 6–10'], [10, 15, 'Days 11–15']].filter(([a]) => a < days.length).map(([a, z, label]) => {
    const ds = days.slice(a, z), tot = ds.reduce((s, d) => s + (d.snow || 0), 0);
    const short = ds.some(d => d.snow == null) ? '<sup title="Some models end before these days">*</sup>' : '';
    return `<div class="st-g${a ? ' wk' : ''}" style="grid-column:${a + 1} / span ${ds.length}"><span>${label}</span><b class="${tot >= 12 ? 'pow' : ''}">${Math.round(tot)}"${short}</b></div>`;
  }).join('');
  const now = last === undefined ? '' : `<div class="st-now"><span>Last 24 h</span><b class="${last?.gain ? '' : 'dim'}">${last ? last.gain + '"' : '–'}</b><small>${station ? `${station} SNOTEL` : 'SNOTEL'}</small></div>`;
  return `<div class="strip"><div class="st-scroll"><div class="st-track">${now}<div class="st-days" style="--n:${days.length}"><div class="st-heads">${heads}</div>${snowBars(days, { max, numbers, tipAttr })}</div></div></div></div>`;
}
// Fade a strip's right edge while there are more days off screen to swipe to
const fitStrip = s => s.classList.toggle('at-end', s.scrollLeft + s.clientWidth >= s.scrollWidth - 4);
const fitStrips = () => document.querySelectorAll('.st-scroll').forEach(fitStrip);
document.addEventListener('scroll', ev => { if (ev.target.classList?.contains('st-scroll')) fitStrip(ev.target); }, true);
addEventListener('resize', fitStrips);

// A resort's logo on a white tile, over its initials so the initials show if the file is missing
// (logos/ is git-ignored: the logos are the resorts' trademarks, so they aren't in the open repo)
const INITIALS = { alta: 'AL', snowbird: 'SB', brighton: 'BR', solitude: 'SO' };
const resortBadge = r => `<span class="rbadge ${r.canyon === 'Little Cottonwood' ? 'lcc' : 'bcc'}" aria-hidden="true">${INITIALS[r.id] || r.name.slice(0, 2).toUpperCase()}${r.logo ? `<img src="${r.logo}" alt="" onerror="this.remove()">` : ''}</span>`;

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
