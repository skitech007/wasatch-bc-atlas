// Where the sun is, for "real sun" hillshading. US Naval Observatory "Approximate Solar Coordinates"
// (accurate to about a degree for 1800–2200), plus the standard altitude/azimuth conversion.
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 864e5 - 10957.5;                 // days since 2000-01-01 12:00 UTC
  const g = (357.529 + 0.98560028 * d) * rad;                 // mean anomaly
  const q = 280.459 + 0.98564736 * d;                         // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;                  // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;   // hours
  const H = ((gmst * 15 + lon) * rad - ra);                    // local hour angle
  const phi = lat * rad;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { altitude: alt / rad, azimuth: (az / rad + 360) % 360 };
}
globalThis.sunPosition = sunPosition;
