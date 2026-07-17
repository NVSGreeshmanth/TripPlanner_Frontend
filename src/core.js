// ── Core: shared primitives + state (single source of truth) ─────────────────
// Everything here is imported by app.js and the feature modules. It has NO imports
// of its own (no circular refs). Holds: backend URL + fetch wrapper, tiny DOM/HTML
// helpers, persistent storage, and the folded state objects. Mutable `let`s that
// get REASSIGNED (lang, currentJourneyData…) intentionally stay in app.js — ES
// module imports are read-only bindings, so an importer can't reassign them.

export const APP_VERSION = 'v1';

// ── Backend — auto-detects local proxy (python proxy.py) vs deployed Render ──
// Same-origin ONLY when the page is served BY the python proxy (port 3001, hosts
// both static app + API). Vite dev/preview pick any free port and have NO API, so
// they must use Render (else /stops returns HTML → JSON.parse fails). Netlify
// (non-localhost) → Render.
const _isLocalhost  = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const _onLocalProxy = _isLocalhost && location.port === '3001';
export const PROXY = _onLocalProxy
  ? `${location.protocol}//${location.host}`
  : 'https://nsw-planner.onrender.com';

// ── Shared-secret header for the proxy's optional APP_SECRET gate ─────────────
// If you set APP_SECRET on Render, set the SAME value here so every proxy call
// carries X-App-Key. Empty = gate off (default). NOTE: a secret in client JS is
// visible in the bundle — it blocks casual bots, not a determined attacker.
export const APP_KEY = '';
if (APP_KEY) {
  const _origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.startsWith(PROXY)) {
      const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
      h.set('X-App-Key', APP_KEY);
      init = { ...init, headers: h };
    }
    return _origFetch(input, init);
  };
}

// ── Tiny constants + helpers ─────────────────────────────────────────────────
export const REFRESH_MS = 30000;   // live-refresh cadence for journey/departure polls
export const MOT_ICONS = { 1:'🚆', 2:'🚇', 4:'🚊', 5:'🚌', 7:'🚎', 9:'⛴', 11:'🚐' };

// Cached-DOM accessor — replaces 170+ raw document.getElementById.
export function byId(id) { return document.getElementById(id); }
// HTML-escape untrusted strings before interpolating into innerHTML (third-party
// feed text: alert title/description, stop names, headsigns).
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Only allow http(s) links from feed data — blocks javascript:/data: URL injection.
export function safeUrl(u) {
  try {
    const parsed = new URL(String(u), location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch { return ''; }
}
// A departure/stop event is realtime if TfNSW marks it controlled or gives an
// estimated time.
export function _evIsRealtime(ev) { return !!ev?.isRealtimeControlled || !!ev?.departureTimeEstimated; }

// ── Persistent storage with in-memory fallback ────────────────────────────────
// localStorage may be unavailable (sandboxed iframe, private browsing). We try it
// first; on any error we silently use the in-memory store.
const _memStore = {};
export function _lsGet(key, def) {
  try { const v = localStorage.getItem(key); return v !== null ? v : def; }
  catch { return key in _memStore ? _memStore[key] : def; }
}
// Parsed-JSON memo, invalidated on every write (all writes funnel through _lsSet).
const _jsonCache = new Map();
export function _lsSet(key, val) {
  _jsonCache.delete(key);
  try { localStorage.setItem(key, val); _memStore[key] = val; }
  catch { _memStore[key] = val; }
}
export function _lsGetJSON(key, fallback) {
  if (_jsonCache.has(key)) return _jsonCache.get(key);
  let v;
  try { v = JSON.parse(_lsGet(key, JSON.stringify(fallback))); }
  catch { v = fallback; }
  _jsonCache.set(key, v);
  return v;
}

// ── Folded state objects (see MODULE STATE MAP in app.js) ────────────────────
// Objects (never reassigned) → safe to share: importers mutate .props, not the
// binding.
export const state = { from: { name: '', id: '' }, to: { name: '', id: '' }, dep: { name: '', id: '' } };
export const jr = {
  showPast: false, sig: '', struct: '', cards: new Map(),
};
export const depState = {
  mode: '', expanded: new Set(), lastFetch: null, sig: '',
  timer: null, updTimer: null, modeTimer: null, countTimer: null,
};
export const pref = {
  theme:  _lsGet('nsw_theme', 'light'),
  accent: _lsGet('nsw_accent', 'default'),
  font:   _lsGet('nsw_font', 'default'),
  elegantLoaded: false,
};
export const wxState     = { data: null, lastFetch: Date.now() };
export const nearbyState = { ctx: 'dep', data: [] };
export const navState    = { tabRouteActive: false, ovStack: [] };
export const trackState  = { uids: [], data: new Map(), liveBusy: false, lastPoll: 0, lastVP: 0 };
export const homeState = { view: 'home', timer: null, agoTimer: null, updatedAt: null,
                           cache: {}, favTimer: null, favAgoTimer: null, favUpdatedAt: null };
export const svState = { stops: new Map(), open: false, uid: null, refreshTimer: null,
                         legsFullStops: [], expandedLegs: new Set(), scrolledToBoard: false, refreshPending: false,
                         // legKeys whose FULL terminus-to-terminus working is shown. Default
                         // is the ridden segment only: the feed's stop list follows the
                         // vehicle into its return working, so a 2-stop ride was rendering
                         // ~60 rows that then doubled back on themselves.
                         allStops: new Set(),
                         // legKey auto-expanded because the journey has exactly ONE transit
                         // leg — there is no choice to present, so the leg list is skipped.
                         autoLeg: null };
