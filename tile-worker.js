/* Renders slope / aspect / rose-match tiles off the main thread. */
importScripts('dem.js');

self.onmessage = async ({ data: { id, mode, z, x, y, mask, minSlope } }) => {
  try {
    const png = await renderTile(z, x, y, mode, mask, minSlope);
    self.postMessage({ id, png }, [png]);
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};
