// Shared by every page, loaded in <head> before the CSS paints:
// 1. the theme (dark, or "glare": high-contrast light for sun on snow), remembered per device
// 2. stroke icons as inline SVG, so nothing depends on emoji or a remote icon font (the app runs offline)
// 3. a "No signal" bar when the phone goes offline
(function () {
  const KEY = 'wbca.theme';
  const get = () => { try { return localStorage.getItem(KEY) === 'glare' ? 'glare' : 'dark'; } catch { return 'dark'; } };
  const apply = t => {
    const root = document.documentElement;
    if (t === 'glare') root.dataset.theme = 'glare'; else delete root.dataset.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'glare' ? '#ffffff' : '#0b0f14';
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.setAttribute('aria-pressed', String(t === 'glare'));
      b.title = t === 'glare' ? 'Switch to dark' : 'Glare mode: high contrast for bright sun';
      b.innerHTML = ICON[t === 'glare' ? 'moon' : 'sun'];
    });
    document.dispatchEvent(new CustomEvent('themechange', { detail: t }));
  };

  const P = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = window.ICON = {
    back: P('<path d="M15 18l-6-6 6-6"/>'),
    chev: P('<path d="M9 18l6-6-6-6"/>'),
    refresh: P('<path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/>'),
    sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: P('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    star: P('<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/>'),
    mountain: P('<path d="M3 20l6.5-11 4 6.5 2.5-4L21 20z"/><path d="M8 11.5l1.5 1.5 1.5-1.5"/>'),
    lift: P('<path d="M3 5l18-3M12 3.5V9"/><rect x="7" y="9" width="10" height="8" rx="2"/><path d="M7 13h10"/>'),
    chart: P('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
    alert: P('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>'),
    wifiOff: P('<path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.6 5.2A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 5-2.4M17.5 11.3A10 10 0 0 1 19 12.5M8.5 16.2a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/>'),
    info: P('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/></svg>',
    external: P('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
    layers: P('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
    focus: P('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><path d="M8 15c2-4 6-4 8-6"/>'),
  };
  // Weather glyphs for the forecast tables: one stroke style, readable at 20 px
  ICON.wx = {
    clear: P('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
    night: P('<path d="M20 13.5A8 8 0 1 1 10.5 4a6 6 0 0 0 9.5 9.5z"/>'),
    partly: P('<path d="M8 3.5v1.5M3.5 8H5M4.8 4.8l1 1M11.2 4.8l-1 1"/><path d="M5.6 10.6A3.5 3.5 0 0 1 11.4 7"/><path d="M7 19h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2A3 3 0 0 0 7 19z"/>'),
    cloud: P('<path d="M7 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2A3 3 0 0 0 7 18z"/>'),
    snow: P('<path d="M7 14h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2A3 3 0 0 0 7 14z"/><path d="M8 18h.01M12 17h.01M16 18h.01M10 21h.01M14 21h.01" stroke-width="2.6"/>'),
    rain: P('<path d="M7 14h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.4 2A3 3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>'),
  };

  apply(get());
  document.addEventListener('DOMContentLoaded', () => {
    apply(get());
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-theme-toggle]');
      if (!b) return;
      const next = get() === 'glare' ? 'dark' : 'glare';
      try { localStorage.setItem(KEY, next); } catch { /* private mode: applies for this page only */ }
      apply(next);
    });
    // static icons written as <i data-icon="name"></i> in the HTML
    document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = ICON[el.dataset.icon] || ''; });
    // Bars stuck under the top bar (the forecast's jump nav) follow its real height, which grows
    // when a long subtitle wraps to two lines on a narrow phone
    const tb = document.querySelector('.topbar');
    if (tb && 'ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px')).observe(tb);
    // No-signal bar
    const bar = document.createElement('div');
    bar.className = 'offline-bar'; bar.setAttribute('role', 'status');
    bar.innerHTML = '<i></i>No signal · showing saved data';
    bar.hidden = navigator.onLine !== false;
    document.body.appendChild(bar);
    addEventListener('online', () => { bar.hidden = true; });
    addEventListener('offline', () => { bar.hidden = false; });
  });
})();
