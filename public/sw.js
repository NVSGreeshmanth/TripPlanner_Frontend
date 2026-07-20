// NSW Journey Planner — Service Worker v2
// Hosted on: https://nswtripplanner.netlify.app/
// API proxy: https://tripplannerau.duckdns.org (OCI A1); Render is the fallback

const CACHE = 'nsw-journey-v159';

// App shell — everything needed to show the UI instantly
const SHELL = [
  './',
  './style.css',
  './app.js',
  './manifest.json'
];

// ── Install: pre-cache the shell ─────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Skip waiting on request from the page (one-tap update) ───────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── Activate: remove old caches ──────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch strategy ────────────────────────────────────────────────────────────
// • Render proxy (onrender.com) → NETWORK ONLY, never cache live data
// • Google Fonts                → NETWORK ONLY (cross-origin, not critical)
// • Everything else (shell)     → CACHE FIRST, update in background
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Never intercept non-GET or cross-origin API calls
  const isApi    = url.includes('tripplannerau.duckdns.org') || url.includes('onrender.com') || url.includes('transport.nsw.gov.au');
  const isFont   = url.includes('fonts.googleapis') || url.includes('fonts.gstatic');
  const isTile   = url.includes('basemaps.cartocdn.com');
  const isNonGet = e.request.method !== 'GET';

  if (isApi || isFont || isTile || isNonGet) {
    // Pass straight through — no caching
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for app shell (HTML, manifest, icons)
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res && res.status === 200 && res.type !== 'opaque') {
            cache.put(e.request, res.clone());
          }
          return res;
        }).catch(() => cached); // offline fallback

        return cached || fresh;
      })
    )
  );
});
