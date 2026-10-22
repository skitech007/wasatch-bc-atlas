// Snow maths for the Alta forecast: turns model water and temperature into inches of snow.
// Shared by forecast.js; plain functions with no page state so they can be checked in isolation.

const SNOW = (() => {
  // Rain/snow split from air temperature at the forecast point. Jennings et al. 2018
  // (Nature Communications 9:1148) put the 50% snow point near 1 °C across the Northern
  // Hemisphere, higher in the dry interior West; we ramp linearly from all snow at 0 °C
  // (32 °F) to all rain at 3 °C (37.4 °F), so the 50% point sits at 1.5 °C (34.7 °F).
  const ALL_SNOW_F = 32, ALL_RAIN_F = 37.4;
  function snowFraction(tempF) {
    if (tempF == null) return null;
    if (tempF <= ALL_SNOW_F) return 1;
    if (tempF >= ALL_RAIN_F) return 0;
    return (ALL_RAIN_F - tempF) / (ALL_RAIN_F - ALL_SNOW_F);
  }

  // Kuchera snow ratio: uses the warmest temperature in the column (here the 2 m temperature at
  // 9,895 ft and, where the model has it, the 700 hPa temperature, which sits near Alta's ridgeline).
  // SLR = 12 + 2(271.16 − T) when T > 271.16 K, else 12 + (271.16 − T). Clamped to 3–25.
  function kuchera(...tempsF) {
    const t = tempsF.filter(v => v != null);
    if (!t.length) return null;
    const k = (Math.max(...t) - 32) * 5 / 9 + 273.15;
    const slr = k > 271.16 ? 12 + 2 * (271.16 - k) : 12 + (271.16 - k);
    return Math.min(25, Math.max(3, slr));
  }

  // One hour of one model: corrected water, how much fell as snow, and inches of snow.
  function hour({ water, tempF, temp700F }, factor) {
    if (water == null || tempF == null) return null;
    const w = water * factor;
    const frac = snowFraction(tempF);
    const slr = kuchera(tempF, temp700F);
    return { water: w, frac, slr, snow: w * frac * slr };
  }

  // Weighted mean over whichever models have a value; weights renormalise as models drop out.
  function blend(values, weights) {
    let s = 0, ws = 0;
    for (const [m, v] of Object.entries(values)) {
      if (v == null || !weights[m]) continue;
      s += v * weights[m]; ws += weights[m];
    }
    return ws ? s / ws : null;
  }

  // Wind direction can't be averaged as a plain number (350° and 10° average to north, not south).
  function blendDirection(dirs, weights) {
    let x = 0, y = 0, ws = 0;
    for (const [m, d] of Object.entries(dirs)) {
      if (d == null || !weights[m]) continue;
      x += Math.sin(d * Math.PI / 180) * weights[m];
      y += Math.cos(d * Math.PI / 180) * weights[m];
      ws += weights[m];
    }
    if (!ws) return null;
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = d => d == null ? '' : COMPASS[Math.round(d / 22.5) % 16];

  return { snowFraction, kuchera, hour, blend, blendDirection, quantile, compass };
})();

// When imported as a module (the worker), make SNOW a global as it already is in the browser
globalThis.SNOW = SNOW;
