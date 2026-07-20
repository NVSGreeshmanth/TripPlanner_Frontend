import { t, i18n } from './src/i18n.js';
import { getLineColors } from './src/line_colors.js';
import { button } from './src/components.js';
import './src/motion.js';   // scroll-reveal + press/hover gestures (Motion, vanilla)
import {
  wxInfo, weatherPillHtml, weatherHomeHtml, fetchWeather, _maybeRefreshWeather, setWeatherRepaint,
} from './src/weather.js';
import { loadAlerts, renderAlerts, toggleAlerts } from './src/alerts.js';
import { applyAccent, setAccent, applyFont, setFont } from './src/prefs.js';
import {
  _buildFormationFull, _indexByRoute, _vpCache, _vpModesFor, closeNearby, countdown,
  findNearby, loadDepartures, loadVehiclePos, renderDepartures, setDepMode, vpMatchesRoute,
  setDepSearchMode, checkRoute, clearRouteInput, selectRouteVehicle, stopRouteWatch,
} from './src/vehicles.js';
import {
  _ovDismiss, _ovOpen, _svBack, _svToggleLeg, _svToggleAllStops, closeStopsView, openStopsView, refreshStopsView,
  showToast, toggleSvTrack, usefulDisasm,
} from './src/stops.js';
import {
  _trackStale, getFavStops, persistTracked, renderFavStopChips, renderHome, restoreTracked,
  startHomeTimer, stopHomeTimer, toggleFavStop, updateDepStar, removeTracked, toggleTracked,
  untrackFromHome,
} from './src/tracking.js';
// ── Core primitives (moved to src/core.js so feature modules can import them) ─
import {
  APP_VERSION, PROXY, APP_KEY, REFRESH_MS, MOT_ICONS,
  byId, esc, safeUrl, _evIsRealtime,
  _lsGet, _lsSet, _lsGetJSON,
  state, jr, depState, pref, wxState, nearbyState, navState, trackState, homeState, svState,
} from './src/core.js';

// Sum of vehicle-position cache timestamps — a cheap "did any VP feed change?"
// epoch used by the render skip-guards. Stays here (depends on _vpCache).
export function _vpEpochSum() { let e = 0; _vpCache.forEach(c => { e += c.ts || 0; }); return e; }

// ── Window bridge (runs at module load, BEFORE any DOM init) ──────────────────
// Under the Vite ES-module build, top-level functions are module-scoped: the
// inline on*="fn()" handlers in index.html + rendered HTML, and the test harness,
// can't see them. Expose them on window/globalThis. Every name below is a hoisted
// `function`/`async function` declaration, so referencing them here — above their
// definitions — is safe (declarations are initialised before the module body runs).
// Placed at the TOP so it executes even if the bottom-of-file DOM init throws in a
// stub/test context. Harmless no-op when loaded as a classic script.
function _installWindowBridge() {
  Object.assign(globalThis, {
    // Inline on*="" handlers (index.html + rendered HTML)
    _navTab, _svBack, _svToggleLeg, _svToggleAllStops, clearDataSheet, clearInput, closeFavRes, closeJourneyView,
    closeNearby, closeSheet, closeStopsView, doSearch, findNearby, goHome,
    loadDepartures, manualRefreshDepart, manualRefreshJourney, onDepartAtChange, onFocus,
    onInput, onKey, openJourneyFromFab, openJourneyView, openSheet, openStopsView,
    removeFav, retryWhenOnline, searchFav, setAccent, setAmPm, setDepMode,
    setDepartNow, setFont, setLang, setMode, setTheme, setTimeFmt,
    showDepartAt, swapStations, toggleAlerts, toggleFavStop, toggleLang, toggleSvTrack,
    addFavJ, removeFavJ, untrackFromHome, setDepSearchMode, checkRoute, clearRouteInput, selectRouteVehicle,
    // Test surface (tests/test_app_logic.cjs)
    delayMins, isWalkLeg, _indexByRoute, _vpByRouteName, countdown, estArr, estDep,
    stableUid, vpMatchesRoute, renderJourneys, renderDepartures, refreshStopsView,
    renderHome, renderFavsPage, startHomeTimer, stopHomeTimer, applyTheme, applyAccent,
    applyFont, _evIsRealtime,
  });
  // currentJourneyData is a mutable `let` — expose via getter/setter so callers read
  // its LIVE value (not a stale snapshot) and the harness can seed it before a render.
  try {
    Object.defineProperty(globalThis, 'currentJourneyData', {
      configurable: true,
      get: () => currentJourneyData,
      set: (v) => { currentJourneyData = v; },
    });
  } catch {}
}
_installWindowBridge();

// ═════════════════════════════════════════════════════════════════════════════
// MODULE STATE MAP — every top-level mutable global grouped by the view/concern
// that OWNS it. (This file is a single browser script, so state is global; this
// map is the ownership contract until the globals are folded into namespaced
// objects behind a test harness.) Search a name to find which subsystem owns it.
//
//   Network/online : serverReady warmPromise _warmTimer _isOnline
//                     _offlineToastTimer _pendingSearchOnReconnect
//                     _jsonCache resolveCache stopSearchCache _memStore
//   Journey view   : currentJourneyData currentPastJourneyData journeyTimer
//                     lastFetchTime updatedTimer departAt
//                     jr{} = { showPast, sig, struct, cards }  ← folded cluster
//   Departures     : modeSearchTimer activeMode(shared)
//                     depState{} = { mode, expanded, lastFetch, sig, timer, updTimer, modeTimer, countTimer }
//   Home           : homeState{} = { view, timer, agoTimer, updatedAt, cache, favTimer, favAgoTimer, favUpdatedAt }
//   Stops overlay  : svState{} = { stops, open, uid, refreshTimer, legsFullStops,
//                     expandedLegs, scrolledToBoard, refreshPending }  ← folded cluster
//   Tracking       : trackState{} = { uids, data, liveBusy, lastPoll, lastVP }  ← folded
//   Vehicle pos    : _vpCache (load-bearing — left global)
//   Nav (history)  : navState{} = { tabRouteActive, ovStack }  ← folded
//   Alerts/weather : alerts  ·  wxState{} = { data, lastFetch }  ← folded
//   Nearby         : nearbyState{} = { ctx, data }  ← folded
//   Prefs/UI       : i18n.lang timeFmt
//                     pref{} = { theme, accent, font, elegantLoaded }  ← folded cluster
//   Toast/misc     : _toastTimer _platHistory
//
// TIMER LEAK WATCH: every *Timer above is hand clear/restarted — always
// clearInterval before reassigning, and clear on view exit (closeStopsView /
// stopHomeTimer / the departures-reset). A missed clear = a leaked interval
// (we hit exactly that with depState.countTimer).
// ═════════════════════════════════════════════════════════════════════════════

export let serverReady = false;
// Setter so modules can flip this shared flag (imports are read-only bindings).
export function setServerReady(v) { serverReady = v; }
let warmPromise = null;
let _warmTimer  = null;  // interval for elapsed counter

function showWarmBanner(show) {
  const banner = byId('warm-banner');
  if (!banner) return;
  if (show) {
    banner.classList.add('show');
    const start = Date.now();
    clearInterval(_warmTimer);
    _warmTimer = setInterval(() => {
      const s = Math.round((Date.now() - start) / 1000);
      const el = byId('warm-elapsed');
      if (el) el.textContent = `— ${s}s`;
      // After 8s add a hint so users don't worry
      const txt = byId('warm-text');
      if (txt && s === 8) { txt.dataset.slow = '1'; txt.textContent = t('warm_slow'); }
    }, 1000);
  } else {
    banner.classList.remove('show');
    clearInterval(_warmTimer);
    const el = byId('warm-elapsed');
    if (el) el.textContent = '';
  }
}

export function warmServer() {
  if (serverReady) return Promise.resolve();
  if (warmPromise) return warmPromise;
  showWarmBanner(true);
  // AbortSignal.timeout requires Chrome 103+/Safari 16+; fall back gracefully on older browsers
  const _sig = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(65000)
    : undefined;
  warmPromise = fetch(PROXY + '/', _sig ? { signal: _sig } : {})
    .then(() => { serverReady = true; showWarmBanner(false); })
    .catch(() => { showWarmBanner(false); warmPromise = null; });
  return warmPromise;
}
warmServer();

// ── Haptic feedback ───────────────────────────────────────────────────────────
export function haptic(pattern = [8]) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

// ── Weather (moved to src/weather.js) ────────────────────────────────────────
// Inject the Home repaint, then kick off the initial fetch + refresh schedule.
setWeatherRepaint(() => { if (byId('page-home')?.style.display !== 'none') renderHome(); });
fetchWeather();
setInterval(fetchWeather, 15 * 60 * 1000);
document.addEventListener('visibilitychange', _maybeRefreshWeather);
window.addEventListener('focus', _maybeRefreshWeather);

// ── GTFS-RT vehicle lookup helpers ───────────────────────────────────────────
// Primary: match by exact trip_id — the trip planner exposes tripCode which
// maps directly to the GTFS-RT trip_id field. This is reliable for trains.
export function _vpByTripId(tripCode, motClass) {
  if (!tripCode) return null;
  for (const mode of _vpModesFor(motClass)) {
    const hit = _vpCache.get(mode)?.byTrip?.get(tripCode);  // O(1) index lookup
    if (hit) return hit;
  }
  return null;
}

// Warm the vehicle-position cache for every mode used by the given journeys, then
// re-render once if fresh data arrived — lets seat/LIVE badges show on the journey
// cards without the user opening show-stops first. Self-limiting: a second pass
// hits the client cache (no ts change) so it won't loop.
async function _prefetchVpForJourneys(jrns) {
  const modes = [...new Set((jrns || []).flatMap(j =>
    (j.legs || []).filter(l => !isWalkLeg(l))
      .flatMap(l => _vpModesFor(l.transportation?.product?.class))))];
  if (!modes.length) return;
  const before = modes.map(m => _vpCache.get(m)?.ts || 0);
  await Promise.all(modes.map(m => loadVehiclePos(m).catch(() => null)));
  const changed = modes.some((m, i) => (_vpCache.get(m)?.ts || 0) !== before[i]);
  if (changed && currentJourneyData) renderJourneys(currentJourneyData, null, false);
}

// The GTFS-RT trip_id for a leg, used to match a live vehicle exactly. TfNSW puts
// this in transportation.properties.RealtimeTripId; fall back to other id fields.
export function _vpTripId(leg) {
  const p = leg?.transportation?.properties || {};
  return p.RealtimeTripId || p.realtimeTripId || p.tripCode
      || leg?.transportation?.id?.split(':')?.[1] || '';
}

// Fallback: match by route name (works for buses where route_id contains the number)
export function _vpByRouteName(routeNm, motClass) {
  if (!routeNm) return null;
  const nmUp = routeNm.toUpperCase();
  let best = null;
  for (const mode of _vpModesFor(motClass)) {
    const hit = _vpCache.get(mode)?.byRoute?.get(nmUp);   // O(1) index lookup
    if (hit && (!best || (hit.ts || 0) > (best.ts || 0))) best = hit;
  }
  return best;
}

// ── Seat availability ────────────────────────────────────────────────────────
// Look up vehicle occupancy from cached VP data. Tries trip_id first, then route name.
// Least-crowded → most. Used to fold per-carriage occupancy into one answer.
const _OCC_RANK = ['empty', 'many', 'few', 'standing', 'crowded', 'full'];
function _vpOccForRoute(routeNm, motClass, tripCode) {
  const v = (tripCode && _vpByTripId(tripCode, motClass)) || _vpByRouteName(routeNm, motClass);
  if (!v) return null;
  if (v.occ) return v.occ;
  // TfNSW often omits VEHICLE-level occupancy while still sending it per carriage
  // (verified 2026-07-17: 13 of 14 live 4-car sets had no v.occ but every one had
  // formation[].occ). Report the QUIETEST carriage — you can walk to it, which is
  // the whole reason the formation is shown.
  const cars = (v.formation || []).map(c => c.occ).filter(Boolean);
  if (!cars.length) return null;
  return cars.slice().sort((a, b) => _OCC_RANK.indexOf(a) - _OCC_RANK.indexOf(b))[0] || null;
}

// Map GTFS-RT occ slug → our internal seat status keys
// NOTE the key/value overlap: the GTFS-RT slug 'empty' and our seat status 'empty'
// are different vocabularies. Carriage-level occupancy DOES emit 'empty' (vehicle
// level never did, which is why this key was missing and every formation-derived
// occupancy silently mapped to undefined → no badge).
const _vpOccToSeat = { empty:'empty', many:'empty', few:'few', standing:'few', crowded:'full', full:'full', closed:'full' };

function getSeatStatus(leg, depIso) {
  // 1. Real TfNSW occupancy from trip planner response
  const occEfa = leg?.properties?.occupancy?.status
              || leg?.occupancy?.status
              || leg?.stopSequence?.[0]?.properties?.occupancy?.status;
  if (occEfa) {
    if (occEfa === 'FULL' || occEfa === 'FEW_SEATS_AVAILABLE') return 'full';
    if (occEfa === 'STANDING_AVAILABLE') return 'few';
    if (occEfa === 'SEATS_AVAILABLE' || occEfa === 'MANY_SEATS_AVAILABLE') return 'empty';
  }

  // 2. Real occupancy from cached vehicle positions (trip_id match first, route name fallback)
  const routeNm  = leg?.transportation?.disassembledName || leg?.transportation?.number || '';
  const motCls   = leg?.transportation?.product?.class;
  const tripCode = _vpTripId(leg);
  if (motCls != null) {
    const vpOcc = _vpOccForRoute(routeNm, motCls, tripCode);
    if (vpOcc) return _vpOccToSeat[vpOcc] || null;
  }

  return null;
}
export function seatBadgeHtml(leg, depIso) {
  const s = getSeatStatus(leg, depIso);
  if (!s) return '';
  const map = { empty:['🟢','Seats free','seat-empty'], few:['🟡','Few seats','seat-few'], full:['🔴','Full','seat-full'] };
  const [ico, lbl, cls] = map[s];
  return `<span class="seat-badge ${cls}">${ico} ${lbl}</span>`;
}
// Shared live-vehicle lookup (GTFS-RT): trip_id match first, then route name —
// the exact same derivation the journey card uses, reused on the Home card.
export function liveVehicleForLeg(leg) {
  const mot = leg?.transportation?.product?.class;
  if (mot == null) return null;
  return _vpByTripId(_vpTripId(leg), mot)
      || _vpByRouteName(leg.transportation?.disassembledName || leg.transportation?.number, mot);
}
export function carsBadgeHtml(leg) {
  const v = liveVehicleForLeg(leg);
  return v?.carriages
    ? `<span class="cars-badge" title="${v.model ? v.model + ' · ' : ''}${v.carriages}-carriage set">🚃 ${v.carriages} ${t('cars')}</span>` : '';
}

// ── Platform change tracking ──────────────────────────────────────────────────
const _platHistory = new Map();
function platChangeBadges(uid, origPlat, destPlat) {
  const prev = _platHistory.get(uid);
  _platHistory.set(uid, { orig: origPlat, dest: destPlat });
  if (!prev) return { orig: '', dest: '' };
  const badge = (was, now) =>
    `<span class="plat-change-alert">⚠ Platform ${was}→${now}</span>`;
  return {
    orig: (prev.orig && origPlat && prev.orig !== origPlat) ? badge(prev.orig, origPlat) : '',
    dest: (prev.dest && destPlat && prev.dest !== destPlat) ? badge(prev.dest, destPlat) : '',
  };
}

// ── FAB helper ────────────────────────────────────────────────────────────────
function openJourneyFromFab() {
  haptic([8]);
  homeState.view = 'journey';
  switchTab('journey');
}
function updateFab() {
  const fab = byId('fab');
  if (!fab) return;
  // Read actual DOM visibility — guards against renderJourneys/applyLang calling this when home is shown
  const vis = id => byId(id)?.style.display === 'block';
  // "New Journey" FAB only makes sense away from the Journey tab itself.
  fab.classList.toggle('show',
    vis('page-depart') ||
    vis('page-favs'));
}

// Keep server warm while app is open — ping every 14 min (Render spins down at 15 min)
setInterval(() => {
  if (document.visibilityState !== 'hidden') fetch(PROXY + '/').catch(() => {});
}, 14 * 60 * 1000);

// ── Clock (Sydney time, to match every other time in the app) ─────────────────
setInterval(() => {
  byId('clock').textContent =
    new Date().toLocaleTimeString(i18n.lang === 'ko' ? 'ko-KR' : 'en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: timeFmt !== '24' });
}, 1000);

// ── Global journey cache for language re-render ───────────────────────────────
export let currentJourneyData = null;
let currentPastJourneyData = null;
// (jr/depState/pref/wxState/nearbyState/navState/trackState/homeState/svState +
//  _lsGet/_lsSet/_lsGetJSON now live in src/core.js — imported at the top.)

// ── i18n ─────────────────────────────────────────────────────────────────────
// (i18n.lang + t() now live in src/i18n.js — imported at the top.)

function toggleLang() {
  setLang(i18n.lang === 'en' ? 'ko' : 'en');
}
function applyLang() {
  // HTML i18n.lang attribute for accessibility
  byId('html-root').lang = i18n.lang === 'ko' ? 'ko' : 'en';
  // Header
  byId('hdr-title').textContent = t('hdr_title');
  byId('hdr-sub').textContent   = t('hdr_sub');
  // All data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = t(el.dataset.i18n));
  // Inputs
  const findTxt = byId('find-btn-txt');
  if (findTxt && !byId('find-btn')?.disabled) findTxt.textContent = t('find');
  byId('from-input').placeholder = t('from_ph');
  byId('to-input').placeholder   = t('to_ph');
  // Swap button
  const swapBtn = document.querySelector('.swap-btn');
  if (swapBtn) swapBtn.textContent = t('swap');
  // Depart pills
  const datNow = byId('dat-now');
  if (datNow) datNow.textContent = t('dat_now');
  const datAt = byId('dat-at-btn');
  if (datAt) datAt.textContent = t('dat_set');
  // Alert footer
  byId('alert-footer').textContent = t('alert_info');
  // Bottom sheet
  const shTitle = byId('sheet-title');
  if (shTitle) shTitle.textContent = t('sheet_title');
  const shClear = byId('sheet-clear-label');
  if (shClear) shClear.textContent = t('sheet_clear');
  const shLangLbl = byId('sheet-lang-label');
  if (shLangLbl) shLangLbl.textContent = t('sheet_lang');
  const shAbout = byId('sheet-about-label');
  if (shAbout) shAbout.textContent = t('sheet_about');
  const shAboutSub = byId('sheet-about-sub');
  if (shAboutSub) shAboutSub.textContent = t('sheet_about_sub');
  const shVer = byId('sheet-version');
  if (shVer) shVer.textContent = t('sheet_version');
  // Warm banner
  const warmTxt = byId('warm-text');
  if (warmTxt && !warmTxt.dataset.slow) warmTxt.textContent = t('warm_starting');
  // Header i18n.lang toggle label — handled by syncLangToggle()
  // Splash
  const splTitle = document.querySelector('.splash-title');
  if (splTitle) splTitle.textContent = t('splash_title');
  const splSub = document.querySelector('.splash-sub');
  if (splSub) splSub.textContent = t('splash_sub');
  // Empty journey state
  const empT = document.querySelector('.journey-empty-t');
  if (empT) empT.textContent = t('plan_t');
  const empS = document.querySelector('.journey-empty-s');
  if (empS) empS.textContent = t('plan_s');
  // Show stops buttons
  document.querySelectorAll('[data-xbtn]').forEach(btn => {
    btn.textContent = t('show_stops');
  });
  // Departures + nearby
  const depIn = byId('dep-input');
  if (depIn) depIn.placeholder = t('dep_search_ph');
  const nearTitle = byId('near-title');
  if (nearTitle) nearTitle.innerHTML =
    '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-0.22em">' +
    '<path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg> ' +
    t('near_title');
  const shTheme = byId('sheet-theme-label');
  if (shTheme) shTheme.textContent = t('sheet_theme');
  const shTf = byId('sheet-timefmt-label');
  if (shTf) shTf.textContent = t('sheet_timefmt');
  renderFavStopChips();
  updateDepStar();
  renderHome();
  if (!currentJourneyData) renderJourneyEmpty();
  if (state.dep.id) loadDepartures(false);
  renderFavsPage();
  updateFavBanner();
  // Re-render journeys preserving doScroll=false intentionally (we're just relabelling)
  if (currentJourneyData) renderJourneys(currentJourneyData, currentPastJourneyData, false);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// Remember whether the "home area" was last showing the dashboard or the journey
// planner, so tapping Home (or the logo) returns you to where you left off instead
// of always snapping back to the dashboard.
function openJourneyView() {
  homeState.view = 'journey';
  switchTab('journey');
  // Present as a full-page route: hide the tab bar and register with the history
  // stack so browser/Android Back returns to Home.
  document.body.classList.add('route-journey');
  _ovOpen('journey', _closeJourneyRoute);
}
export function _closeJourneyRoute() {
  document.body.classList.remove('route-journey');
  homeState.view = 'home';
  switchTab('home');
}
// Back button on the journey page — route through history so Back stays in sync.
function closeJourneyView() {
  if (_ovDismiss('journey')) return;
  _closeJourneyRoute();
}
function showDashboard()   { document.body.classList.remove('route-journey'); homeState.view = 'home'; switchTab('home'); }
function goHome()          { switchTab(homeState.view); }
export function switchTab(tab) {
  haptic([5]);
  _lsSet('nsw_tab', tab);
  ['home', 'journey', 'depart', 'favs'].forEach(p => {
    const pageEl = byId('page-' + p);
    if (!pageEl) return;
    if (p === tab) {
      pageEl.style.display = 'block';
      // Restart the enter animation each time the page is shown
      pageEl.classList.remove('page-enter');
      void pageEl.offsetWidth;            // force reflow so the anim replays
      pageEl.classList.add('page-enter');
    } else {
      pageEl.style.display = 'none';
    }
  });
  // The Journey planner is opened from Home (no dedicated tab), so keep Home lit for it
  const activeTab = tab === 'journey' ? 'home' : tab;
  ['home', 'depart', 'favs'].forEach(p => {
    const tabEl = byId('tab-' + p);
    if (tabEl) tabEl.classList.toggle('active', p === activeTab);
  });
  if (tab === 'home') { renderHome(); startHomeTimer(); } else { stopHomeTimer(); }
  if (tab === 'favs') renderFavsPage();
  if (tab === 'journey' && !currentJourneyData) renderJourneyEmpty();
  // Only poll the departures board while its tab is visible
  if (tab === 'depart') {
    renderFavStopChips();
    if (state.dep.id) loadDepartures(true);
  } else {
    clearInterval(depState.timer); depState.timer = null;
    stopRouteWatch();               // kill the Route-tab live poll + map at once
  }
  // Favourites auto-refresh only runs while on the Favourites tab with a panel open
  if (tab !== 'favs') stopFavTimer();
  updateFab();
}

// Tab navigation that keeps Home as the back-stack base. Opening Departures or
// Favourites pushes ONE history entry, so hardware Back / left-edge-swipe returns
// to Home instead of exiting the app. Switching between non-home tabs reuses the
// same entry (no stacking).
function _navTab(tab) {
  if (tab === 'home') {
    if (navState.tabRouteActive && _ovDismiss('tab')) return;  // Back pops the tab route → Home
    switchTab('home');
    return;
  }
  if (byId('page-' + tab)?.style.display === 'block') return;  // already here
  switchTab(tab);
  if (!navState.tabRouteActive) {
    navState.tabRouteActive = true;
    _ovOpen('tab', () => { navState.tabRouteActive = false; switchTab('home'); });
  }
}

// ── Alerts (moved to src/alerts.js) ──────────────────────────────────────────
loadAlerts();
setInterval(() => { if (!document.hidden) loadAlerts(); }, 60000);

// ── App state ─────────────────────────────────────────────────────────────────
// (`state` now lives in src/core.js — imported at the top.)
let activeMode = '';

// ── Mode selection (with 300 ms debounce to avoid rapid-fire requests) ────────
let modeSearchTimer = null;
function setMode(el, x) {
  activeMode = x;
  document.querySelectorAll('#page-journey .mb').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  // No auto-search on mode change — the new mode is applied on the next
  // "Find Journeys" press (avoids surprise re-queries while picking a mode).
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function cleanStationName(name) {
  if (!name) return '';
  return name.split(',')[0].trim();
}
// FIX: return '' when no platform keyword found — was returning the station name itself
function cleanPlatform(name) {
  if (!name) return '';
  const m = name.match(/(Platform|Stand|Wharf|Track)\s*[A-Z0-9]+/i);
  return m ? m[0] : '';
}
// Short platform/stand label shown on cards. Tries the keyword token first; if the
// disassembled name carries platform info in another form, strips the station-name
// prefix and returns the short remainder. Used in BOTH collapsed cards and the
// expanded stop list so platforms appear consistently (the old collapsed card used
// cleanPlatform only, so platforms vanished when the keyword wasn't present).
export function platLabel(name, disasm, stopObj, mot) {
  // Only rail-type modes have platforms/wharves. Buses/coaches use stands and often
  // carry a bare bay number we must NOT render as "Platform N".
  const RAIL = (mot === 1 || mot === 2 || mot === 4 || mot === 9 || mot === undefined);
  const clean = s => String(s || '')
    .replace(/\b(Platform|Track)\s+[A-Za-z]{1,3}(\d+[A-Za-z]?)\b/i, '$1 $2'); // "Platform CE22" → "Platform 22"
  const pf = stopObj?.properties?.platform || stopObj?.properties?.platformName;
  if (pf) {
    if (/platform|stand|wharf|track|bay/i.test(pf)) return clean(pf);
    if (RAIL) {
      const m = String(pf).match(/^[A-Za-z]{1,3}(\d+[A-Za-z]?)$/);
      return 'Platform ' + (m ? m[1] : pf);
    }
    return '';                                  // bus/coach: bare code is ambiguous (could be route#)
  }
  let d = usefulDisasm(name || '', disasm || '');
  if (!d) return '';
  const km = d.match(/(Platform|Stand|Wharf|Track|Bay|Side|Gate)\s*[A-Za-z0-9]+/i);
  if (km) return clean(km[0]);               // explicit keyword (incl. bus "Stand C")
  if (!RAIL) return '';                       // buses: nothing else counts as a platform
  const base = cleanStationName(name || '');
  if (base && d.startsWith(base)) d = d.slice(base.length).replace(/^[,\s·-]+/, '').trim();
  return d.length && d.length <= 18 ? clean(d) : '';
}
// Platform/stand label for a LEG's boarding (origin) / alighting (destination) stop.
// Wraps platLabel with the repeated stopSequence-vs-origin/destination arg shape
// (was copy-pasted at 8 call sites) so the resolution logic lives in one place.
export function legOriginPlat(leg, mot = leg?.transportation?.product?.class) {
  return platLabel(leg?.origin?.name,
    leg?.stopSequence?.[0]?.disassembledName || leg?.origin?.disassembledName,
    leg?.stopSequence?.[0] || leg?.origin, mot);
}
export function legDestPlat(leg, mot = leg?.transportation?.product?.class) {
  return platLabel(leg?.destination?.name,
    leg?.stopSequence?.at(-1)?.disassembledName || leg?.destination?.disassembledName,
    leg?.stopSequence?.at(-1) || leg?.destination, mot);
}
// ── Sydney timezone layer ───────────────────────────────────────────────────
// This is a NSW app, so every time is interpreted/displayed in Australia/Sydney
// REGARDLESS of the viewer's device timezone. A user opening the app from London
// still sees true Sydney departure times and the correct service window.
// (Comparisons like "in 7 min" already work anywhere — they use absolute instants.
//  What we pin here is the wall-clock face and the date/time we send to TfNSW.)
export const SYD_TZ = 'Australia/Sydney';
const _sydDTF = new Intl.DateTimeFormat('en-GB', {
  timeZone: SYD_TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
// GTFS stop_times are wall-clock "HH:MM:SS" (no date, and hours can be >= 24 for
// trips past midnight). `new Date("17:56:00")` is Invalid → DateTimeFormat throws.
// Detect these and return the hour/minute directly so the timeline still renders.
const _HMS_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
function _hmsParts(v) {
  if (typeof v !== 'string') return null;
  const m = _HMS_RE.exec(v.trim());
  if (!m) return null;
  return { hour: (+m[1]) % 24, minute: +m[2] };
}
// Wall-clock components of an instant, in Sydney → {year,month,day,hour,minute}.
// Accepts a Date, an ISO string, or a bare "HH:MM:SS" GTFS time. Never throws.
export function sydParts(d) {
  const hms = _hmsParts(d);
  if (hms) return hms;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return { hour: 0, minute: 0 };   // guard: don't throw
  const o = {};
  for (const p of _sydDTF.formatToParts(dt)) if (p.type !== 'literal') o[p.type] = +p.value;
  if (o.hour === 24) o.hour = 0;       // some engines emit 24 at midnight
  return o;
}
// Sydney timezone abbreviation right now (AEDT in daylight saving, else AEST)
export function sydAbbr(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-AU', { timeZone: SYD_TZ, timeZoneName: 'short' }).formatToParts(d);
    const tz = parts.find(p => p.type === 'timeZoneName')?.value || '';
    return /AED?T|AES?T/.test(tz) ? tz : 'AEST';
  } catch { return 'AEST'; }
}
export const z2 = n => String(n).padStart(2, '0');
// Human label e.g. "Sydney time · AEDT" — used to make the timezone explicit to users
export function tzNote() { return `${t('syd_time')} · ${sydAbbr()}`; }
// True when the viewer's device is NOT on Sydney time (worth flagging more loudly)
export function deviceOffSydney() {
  try {
    const n = new Date();
    return new Intl.DateTimeFormat('en-GB', { timeZone: SYD_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(n)
        !== new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(n);
  } catch { return false; }
}

// Time display format: '12' (default, with AM/PM) or '24'. Persisted in settings.
let timeFmt = (function () { const v = _lsGet('nsw_timefmt', '12'); return v === '24' ? '24' : '12'; })();
function setTimeFmt(f) {
  timeFmt = f === '24' ? '24' : '12';
  _lsSet('nsw_timefmt', timeFmt);
  syncTimeFmtToggle();
  // Re-render everything that shows a time
  renderHome();
  rerenderJourneys();
  if (state.dep.id && byId('page-depart')?.style.display === 'block') loadDepartures(false);
  renderFavStopChips();
}
function syncTimeFmtToggle() {
  ['12', '24'].forEach(f =>
    byId('tf-' + f)?.classList.toggle('active', timeFmt === f));
}
// {time, ap}: ap is '' in 24h mode, 'AM'/'PM' in 12h mode
export function fmtParts(iso) {
  if (!iso) return { time: '--:--', ap: '' };
  const p = sydParts(iso);   // sydParts accepts Date | ISO string | "HH:MM:SS"
  if (timeFmt === '24') return { time: z2(p.hour) + ':' + z2(p.minute), ap: '' };
  const ap = p.hour < 12 ? 'AM' : 'PM';
  const h12 = p.hour % 12 || 12;
  return { time: h12 + ':' + z2(p.minute), ap };
}
export function fmt(iso) {
  const p = fmtParts(iso);
  return p.ap ? `${p.time} ${p.ap}` : p.time;
}
// Stable card ID — built from PLANNED (scheduled) dep+arr times, not estimated.
// If we used estimated times, a 2-min delay would change the UID between refreshes
// and break expanded-card restoration.
function stableUid(depPlanned, arrPlanned) {
  const k = s => s ? s.replace(/\D/g, '').slice(0, 12) : '0';
  return 'j' + k(depPlanned) + k(arrPlanned).slice(-6);
}

// ── Delay helpers ─────────────────────────────────────────────────────────────
// Returns delay in whole display-minutes: positive = late, negative = early, 0 = on time.
// Computed from the Sydney wall-clock minute of each time so the badge number always
// matches what fmt() displays, for any viewer timezone.
export function delayMins(planned, estimated) {
  if (!planned || !estimated) return 0;
  const p = sydParts(planned), e = sydParts(estimated);
  const pMins = p.hour * 60 + p.minute;
  const eMins = e.hour * 60 + e.minute;
  let diff = eMins - pMins;
  if (diff < -720) diff += 1440; // handle midnight crossover
  if (diff >  720) diff -= 1440;
  return diff;
}

// Estimated departure for a leg — checks leg.origin first, then stopSequence[0]
// as fallback because TfNSW sometimes only populates estimated times at stop level.
export function estDep(leg) {
  return leg?.origin?.departureTimeEstimated
      || leg?.stopSequence?.[0]?.departureTimeEstimated
      || leg?.origin?.departureTimePlanned;
}

// Estimated arrival for a leg — checks leg.destination first, then last stop in sequence.
export function estArr(leg) {
  return leg?.destination?.arrivalTimeEstimated
      || leg?.stopSequence?.at(-1)?.arrivalTimeEstimated
      || leg?.destination?.arrivalTimePlanned;
}
// True when TfNSW reports realtime data for this leg (estimated times or a
// realtime trip id). Light rail & ferry are realtime-controlled but their
// GTFS-RT vehicle feed doesn't match our trip/route lookups, so the vehicle-
// position match alone wrongly marked them "SCHED". This flag fixes that.
export function legIsRealtime(leg) {
  if (!leg) return false;
  const p = leg.transportation?.properties || {};
  if (p.RealtimeTripId || p.realtimeTripId) return true;
  if (leg.origin?.departureTimeEstimated || leg.destination?.arrivalTimeEstimated) return true;
  return (leg.stopSequence || []).some(s => s.departureTimeEstimated || s.arrivalTimeEstimated);
}
// Inline coloured badge shown next to a time. Nothing rendered only if exactly on time.
export function delayBadge(mins) {
  if (!mins) return '';  // 0 / null / undefined = on time, show nothing
  const late  = mins > 0;
  const label = late ? `+${mins}${t('m')}` : `${mins}${t('m')}`;
  const bg    = late ? 'var(--red)' : 'var(--green)';
  return `<span style="font-size:10px;font-weight:700;color:#fff;background:${bg};padding:2px 6px;border-radius:5px;margin:0 6px;vertical-align:middle;">${label}</span>`;
}
// Strikethrough scheduled time shown below when off-schedule.
// Skipped if planned and estimated round to the same displayed minute (avoids duplicate).
export function plannedLine(planned, estimated) {
  const d = delayMins(planned, estimated);
  if (!d || !planned) return '';
  if (fmt(planned) === fmt(estimated)) return ''; // same minute display — don't duplicate
  return `<div style="font-size:10px;color:var(--muted);text-decoration:line-through;margin-top:1px;line-height:1;">${fmt(planned)}</div>`;
}
function dur(a, b) {
  if (!a || !b) return '--';
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  if (isNaN(m)) return '--';
  const h = Math.floor(m / 60), min = m % 60;
  return m < 60 ? m + t('min') : h + t('h') + (min ? ' ' + min + t('m') : '');
}
export function isWalkLeg(l) { const c = l.transportation?.product?.class; return c === 99 || c === 100 || !!l.isWalking; }

// Show or hide the × button based on whether the input has content
export function setClearBtn(side, hasValue) {
  byId(side + '-clear')?.classList.toggle('vis', !!hasValue);
}

// ── Official TfNSW line colours ───────────────────────────────────────────────

// ── Autocomplete ─────────────────────────────────────────────────────────────
// (MOT_ICONS now lives in src/core.js — imported at the top.)
const deb         = {};
const sugData     = {};        // raw stop objects per side for event delegation + keyboard nav
const sugIdx      = {};        // highlighted row index per side
const resolveCache = {};       // memoised stop name → id

// Client-side stop search cache — serves cached results instantly on repeated/backspaced queries.
// Stores unfiltered stops; mode filter applied at render time so cache stays valid across mode changes.
const stopSearchCache = new Map();
const STOP_CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

function onInput(el, side) {
  state[side].id = ''; state[side].name = ''; el.classList.remove('sel');
  const v = el.value.trim();
  setClearBtn(side, v.length > 0);
  // Require 3 letters before searching — avoids the premature "No matching stops".
  if (v.length < 3) {
    clearTimeout(deb[side]);
    if (v.length >= 1) renderSugsMessage(side, t('type_more'));
    else closeSugs(side);
    return;
  }
  clearTimeout(deb[side]);
  deb[side] = setTimeout(() => searchStops(v, side), 150);
}

// FIX #2: removed dead 'board' branch; handles only 'from' and 'to'
function onFocus(side) {
  const el = byId(side + '-input');
  if (!el) return;
  const v = el.value.trim();
  if (v.length >= 3 && !state[side].id) { searchStops(v, side); return; }
  if (!v) showRecentStops(side);   // empty field → quick-pick favourites & recents
}

// Show favourite stops + recently used journey endpoints when an empty field is
// focused, so common stops are one tap away without typing.
function showRecentStops(side) {
  const seen = new Set();
  const items = [];
  getFavStops().forEach(s => {
    if (s.id && !seen.has(s.id)) { seen.add(s.id); items.push({ name: s.name, id: s.id, _fav: true }); }
  });
  getRecents().forEach(j => [j.from, j.to].forEach(s => {
    if (s?.id && !seen.has(s.id)) { seen.add(s.id); items.push({ name: s.name, id: s.id, _recent: true }); }
  }));
  if (items.length) renderSugs(items.slice(0, 6), side, '', t('saved_recent'));
}

// Keyboard nav: Esc closes, arrows navigate, Enter selects or (nothing highlighted) runs search
function onKey(e, side) {
  const box   = byId(side + '-sugs');
  const items = box ? [...box.querySelectorAll('.sug')] : [];
  if (e.key === 'Escape') { closeSugs(side); return; }
  if (e.key === 'ArrowDown' && items.length) {
    e.preventDefault();
    sugIdx[side] = Math.min((sugIdx[side] ?? -1) + 1, items.length - 1);
    items.forEach((it, i) => it.classList.toggle('highlighted', i === sugIdx[side]));
    return;
  }
  if (e.key === 'ArrowUp' && items.length) {
    e.preventDefault();
    sugIdx[side] = Math.max((sugIdx[side] ?? 0) - 1, -1);
    items.forEach((it, i) => it.classList.toggle('highlighted', i === sugIdx[side]));
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const idx = sugIdx[side] ?? -1;
    if (idx >= 0 && items[idx]) {
      const s = sugData[side]?.[idx];
      if (s) selectStop(side, s.name, s.properties?.stopId || s.id);
    } else {
      closeSugs(side);
      doSearch();
    }
  }
}

function closeSugs(side) {
  const el = byId(side + '-sugs');
  if (el) el.style.display = 'none';
  sugIdx[side] = -1;
}

async function searchStops(q, side) {
  const key    = q.toLowerCase();
  const cached = stopSearchCache.get(key);
  let stops;

  if (cached && Date.now() - cached.ts < STOP_CACHE_TTL) {
    // Serve from client cache — feels instant on backspace or repeated queries
    stops = cached.stops;
  } else {
    renderSugsLoading(side);   // show a spinner row while the network call is in flight
    try {
      const r = await timedFetch(PROXY + '/stops?' + new URLSearchParams({ q }));
      if (!r.ok) { renderSugsMessage(side, t('search_failed')); return; }
      const d = await r.json();
      stops = (d?.locations || [])
        .filter(l => l.type === 'stop' || l.type === 'platform')
        .sort((a, b) => (b.isBest?1:0)-(a.isBest?1:0) || (b.matchQuality||0)-(a.matchQuality||0));
      if (stopSearchCache.size >= 150) stopSearchCache.delete(stopSearchCache.keys().next().value);
      stopSearchCache.set(key, { stops, ts: Date.now() });
    } catch { renderSugsMessage(side, t('search_failed')); return; }
  }

  // TfNSW's stop finder has patchy substring matching — e.g. "centra" returns
  // nothing while "centr" and "central" both match "Central Station, Sydney".
  // Fallback: if this query is empty, reuse the longest SHORTER cached query that
  // had results and filter it by the current substring, so typing never regresses.
  if (!stops.length) {
    let best = null;
    for (const [ck, cv] of stopSearchCache) {
      if (ck.length < key.length && key.startsWith(ck) && cv.stops?.length
          && (!best || ck.length > best.key.length)) best = { key: ck, stops: cv.stops };
    }
    if (best) {
      const sub = best.stops.filter(s => (s.name || '').toLowerCase().includes(key));
      if (sub.length) stops = sub;
    }
    // No shorter query cached (fast typing / paste) → retry once with the prefix.
    if (!stops.length && key.length >= 4) {
      try {
        const r2 = await timedFetch(PROXY + '/stops?' + new URLSearchParams({ q: q.slice(0, -1) }));
        if (r2.ok) {
          const d2 = await r2.json();
          const s2 = (d2?.locations || [])
            .filter(l => l.type === 'stop' || l.type === 'platform')
            .sort((a, b) => (b.isBest?1:0)-(a.isBest?1:0) || (b.matchQuality||0)-(a.matchQuality||0));
          const sub = s2.filter(s => (s.name || '').toLowerCase().includes(key));
          if (sub.length) { stops = sub; stopSearchCache.set(key, { stops, ts: Date.now() }); }
        }
      } catch {}
    }
  }

  // Ignore a stale response if the input has since changed
  const liveVal = byId(side + '-input')?.value.trim().toLowerCase();
  if (liveVal && liveVal !== key) return;

  // Mode filter applied at render time so the cached list stays valid when mode changes
  let filtered = stops;
  if (activeMode) {
    const excl = activeMode.split(',');
    filtered = stops.filter(s => {
      const cls = s.productClasses || [];
      return !cls.length || cls.some(c => !excl.includes(c.toString()));
    });
  }
  renderSugs(filtered.slice(0, 7), side, q);
}

const _escHtml = x => (x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Bold the part of a label that matches the typed query, so matches scan fast.
function _highlightMatch(text, q) {
  const esc = _escHtml(text);
  if (!q) return esc;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc;
  return _escHtml(text.slice(0, i)) + '<mark>' + _escHtml(text.slice(i, i + q.length)) + '</mark>' + _escHtml(text.slice(i + q.length));
}

// Transient states inside the dropdown — keeps it visible (and the keyboard up)
// instead of vanishing, so the search always feels responsive.
function renderSugsLoading(side) {
  const box = byId(side + '-sugs');
  if (!box) return;
  box.innerHTML = `<div class="sug-state"><span class="spin-sm"></span>${t('searching')}</div>`;
  box.style.display = 'block';
}
function renderSugsMessage(side, msg) {
  const box = byId(side + '-sugs');
  if (!box) return;
  box.innerHTML = `<div class="sug-state sug-empty">🔍 ${msg}</div>`;
  box.style.display = 'block';
  sugData[side] = []; sugIdx[side] = -1;
}

// FIX #3: no more inline onclick with string interpolation — uses data-idx + event delegation
function renderSugs(stops, side, q, header) {
  const box = byId(side + '-sugs');
  if (!box) return;
  if (!stops.length) {
    if (q) renderSugsMessage(side, t('no_stops'));   // real search → say so
    else box.style.display = 'none';                 // empty-field quick-pick → just hide
    return;
  }
  sugData[side] = stops;
  sugIdx[side] = -1;
  const rows = stops.map((s, i) => {
    const modeIcons = [...new Set((s.productClasses || []).map(c => MOT_ICONS[+c] || '').filter(Boolean))].join('');
    const ic = s._fav ? '⭐' : s._recent ? '🕘' : (modeIcons || '🚉');
    // Split "Central Station, Sydney" → bold primary + muted locality, easier to scan.
    const parts = (s.name || '').split(',').map(x => x.trim()).filter(Boolean);
    const primary = _highlightMatch(parts[0] || s.name || '', q);
    const secondary = _highlightMatch(parts.slice(1).join(', '), q);
    return `<div class="sug" data-idx="${i}" data-side="${side}">
      <span class="sug-ic">${ic}</span>
      <div class="sug-text">
        <span class="sug-name">${primary}</span>
        ${secondary ? `<span class="sug-sub">${secondary}</span>` : ''}
      </div>
      ${s._fav ? `<span class="sug-tag">${t('saved_word')}</span>` : s._recent ? `<span class="sug-tag">${t('recent_word')}</span>` : ''}
    </div>`;
  }).join('');
  box.innerHTML = (header ? `<div class="sug-header">${header}</div>` : '') + rows;
  box.style.display = 'block';
  // Scroll the input into view so the keyboard doesn't cover the dropdown
  const inputEl = byId(side + '-input');
  if (inputEl) setTimeout(() => inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' }), 80);
}

// When the virtual keyboard resizes the viewport, keep the focused input visible
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const focused = document.activeElement;
    if (focused && (focused.id === 'from-input' || focused.id === 'to-input')) {
      setTimeout(() => focused.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    }
  });
}

export function selectStop(side, name, id) {
  haptic([6]);
  state[side] = { name, id };
  const el = byId(side + '-input');
  if (el) { el.value = name; el.classList.add('sel'); }
  setClearBtn(side, true);
  closeSugs(side);
  if (side === 'dep') { depState.expanded.clear(); _lsSet('nsw_dep_stop', JSON.stringify({ name, id })); loadDepartures(true); }
}

// FIX #3: event delegation for suggestion clicks + close all suggestion dropdowns on outside click
document.addEventListener('click', e => {
  const sug = e.target.closest('.sug[data-idx]');
  if (sug) {
    const side = sug.dataset.side;
    const idx = parseInt(sug.dataset.idx, 10);
    const s = sugData[side]?.[idx];
    if (s) selectStop(side, s.name, s.properties?.stopId || s.id);
    return;
  }
  if (!e.target.closest('#from-row')) closeSugs('from');
  if (!e.target.closest('#to-row')) closeSugs('to');
  if (!e.target.closest('.dep-pick-row')) closeSugs('dep');
});

// Clear button: wipe input, reset state, stop timer if both fields now empty
function clearInput(side) {
  const el = byId(side + '-input');
  if (el) { el.value = ''; el.classList.remove('sel'); el.focus(); }
  state[side] = { name: '', id: '' };
  setClearBtn(side, false);
  closeSugs(side);
  if (!state.from.id && !state.to.id) {
    clearInterval(journeyTimer); journeyTimer = null;
    currentJourneyData = null; renderJourneyEmpty(); renderHome();
  }
  if (side === 'dep') {
    _lsSet('nsw_dep_stop', '');
    depState.expanded.clear();
    clearInterval(depState.timer); depState.timer = null;
    clearInterval(depState.updTimer); depState.updTimer = null;
    clearInterval(depState.countTimer); depState.countTimer = null; depState.sig = '';
    const resEl = byId('depart-results');
    if (resEl) resEl.innerHTML = `<div class="journey-empty">
        <div class="journey-empty-ic">🚏</div>
        <div class="journey-empty-t">${t('dep_empty_t')}</div>
        <div class="journey-empty-s">${t('dep_empty_s')}</div>
      </div>`;
  }
}

function swapStations() {
  haptic([10]);
  const f = { ...state.from }, tt = { ...state.to };
  state.from = { ...tt }; state.to = { ...f };
  const fi = byId('from-input'), ti = byId('to-input');
  fi.value = state.from.name; ti.value = state.to.name;
  fi.classList.toggle('sel', !!state.from.id);
  ti.classList.toggle('sel', !!state.to.id);
  setClearBtn('from', !!state.from.name);
  setClearBtn('to',   !!state.to.name);
  // Re-search immediately if both stations are set and results are already visible
  const res = byId('journey-results');
  if (state.from.id && state.to.id && res && res.innerHTML.trim() && !res.querySelector('.err')) {
    res.innerHTML = skeletonCards(4);
    clearInterval(journeyTimer); journeyTimer = null;
    fetchJourneys(true);
    if (!departAt) journeyTimer = setInterval(() => { if (!document.hidden) fetchJourneys(false); }, REFRESH_MS);
  }
}

// FIX #11: memoised ID resolution
async function resolveId(name) {
  if (resolveCache[name]) return resolveCache[name];
  const r = await timedFetch(PROXY + '/stops?' + new URLSearchParams({ q: name }));
  if (!r.ok) return null;
  const d = await r.json();
  const stops = (d?.locations || [])
    .filter(l => l.type === 'stop' || l.type === 'platform')
    .sort((a, b) => (b.isBest ? 1 : 0) - (a.isBest ? 1 : 0) || (b.matchQuality || 0) - (a.matchQuality || 0));
  const id = stops[0]?.properties?.stopId || stops[0]?.id || null;
  if (id) resolveCache[name] = id;
  return id;
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
// Custom modal — avoids the ugly browser-native window.confirm().
// routeLabel: short description shown in the dialog body (e.g. "Parramatta → Central")
function showConfirm(routeLabel, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-icon">⭐</div>
      <div class="confirm-title">${t('confirm_title')}</div>
      <div class="confirm-body">${routeLabel}</div>
      <div class="confirm-btns">
        <button class="confirm-keep" id="conf-keep">${t('confirm_keep')}</button>
        <button class="confirm-remove" id="conf-rm">${t('confirm_remove')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => document.body.removeChild(overlay);
  overlay.querySelector('#conf-keep').onclick = close;
  overlay.querySelector('#conf-rm').onclick   = () => { close(); onConfirm(); };
  // Tap outside to cancel
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}
export function getFavJ() { return _lsGetJSON('nsw_fav_j', []); }
function saveFavJ(arr) { _lsSet('nsw_fav_j', JSON.stringify(arr)); }
function isFavJ(fid, tid) { return getFavJ().some(j => j.from.id === fid && j.to.id === tid); }

function addFavJ() {
  const { id: fid, name: fn } = state.from, { id: tid, name: tn } = state.to;
  if (!fid || !tid) return;
  if (!isFavJ(fid, tid)) { const favs = getFavJ(); favs.push({ from: { name: fn, id: fid }, to: { name: tn, id: tid } }); saveFavJ(favs); }
  updateFavBanner(); renderFavsPage();
}
function removeFavJ() {
  const fid = state.from.id, tid = state.to.id; if (!fid || !tid) return;
  const label = `${state.from.name} → ${state.to.name}`;
  showConfirm(label, () => {
    saveFavJ(getFavJ().filter(j => !(j.from.id === fid && j.to.id === tid)));
    updateFavBanner(); renderFavsPage();
  });
}
// Favourite toggle rendered via the reusable button() component (star icon,
// aria-pressed, 44px). Single source of truth for both first render and the
// in-place update below. Keeps the inline onclick so the window-bridge path
// (addFavJ/removeFavJ) is unchanged.
function _favBtnHtml() {
  const saved = isFavJ(state.from.id, state.to.id);
  // Label already includes a ★ — no icon (avoids a double star).
  return button({
    id: 'fav-banner-btn', label: saved ? t('remove_fav') : t('add_fav'),
    variant: 'secondary', size: 'sm',
    pressed: saved, onclick: saved ? 'removeFavJ()' : 'addFavJ()',
    dataset: { fav: saved ? 'saved' : 'add' },
  });
}
function updateFavBanner() {
  const btn = byId('fav-banner-btn'); if (!btn) return;
  btn.outerHTML = _favBtnHtml();   // full re-render keeps the component markup intact
}
function renderFavsPage() {
  const favs = getFavJ();
  const el = byId('favs-list'); if (!el) return;
  stopFavTimer(); // list rebuild closes all panels; restarts when one is opened
  if (!favs.length) {
    el.innerHTML = `<div class="state"><div class="state-ic">⭐</div>
      <div class="state-t">${t('no_favs_t')}</div>
      <div class="state-s">${t('no_favs_s')}</div></div>`;
    return;
  }
  el.innerHTML = favs.map((j, i) => `
    <div class="fav-card" id="fav-card-${i}">
      <div class="fav-card-top">
        <div style="font-size:20px;flex-shrink:0">🗺</div>
        <div class="fav-route">
          <div class="fav-from">${j.from.name}</div>
          <div class="fav-to">→ ${j.to.name}</div>
        </div>
        <div class="fav-actions">
          <button class="fav-search-btn" id="fsb-${i}" onclick="searchFav(${i})">${t('search')}</button>
          <button class="fav-del-btn" title="Delete" onclick="removeFav(${i})">${t('remove')}</button>
        </div>
      </div>
      <div class="fav-results" id="fav-res-${i}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span class="auto-badge" title="${t('auto_refresh')}"><span class="ldot"></span><span class="fav-updated-txt">${agoText(homeState.favUpdatedAt)}</span></span>
          <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
            <button class="refresh-btn" onclick="searchFav(${i}, this)" aria-label="Refresh"><span>↻</span></button>
            <button onclick="closeFavRes(${i})" style="padding:6px 12px;background:var(--input-bg);border:1px solid var(--border);border-radius:10px;color:var(--sub);font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif">${t('close')}</button>
          </div>
        </div>
        <div id="fav-res-inner-${i}"></div>
      </div>
    </div>`).join('');
}
async function searchFav(i, refreshBtn, quiet) {
  const favs = getFavJ(); const j = favs[i]; if (!j) return;
  const resEl = byId('fav-res-' + i);
  const btn = byId('fsb-' + i);
  resEl.style.display = 'block';
  const innerEl = byId('fav-res-inner-' + i);
  // Quiet refresh (auto): don't flash the spinner — just swap in fresh results
  if (innerEl && !quiet) innerEl.innerHTML = `<div class="spin-wrap"><div class="spin"></div>${t('find')}…</div>`;
  if (!quiet) { btn.classList.add('loading'); btn.textContent = '…'; }
  if (refreshBtn) refreshBtn.classList.add('spinning');
  try {
    const r = await timedFetch(PROXY + '/trip?' + new URLSearchParams({ from: j.from.id, to: j.to.id }));
    if (!r.ok) { if (innerEl && !quiet) innerEl.innerHTML = `<div class="err">Error ${r.status}</div>`; return; }
    homeState.favUpdatedAt = Date.now();   // mark this refresh for the "updated Xs ago" badge
    renderFavResults(await r.json(), j, i);
  } catch (e) { if (innerEl && !quiet) innerEl.innerHTML = `<div class="err">${e.message}</div>`; }
  finally {
    if (!quiet) { btn.classList.remove('loading'); btn.textContent = t('search'); }
    if (refreshBtn) setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
    startFavTimer(); // keep open favourites refreshing
  }
}
// Auto-refresh any open favourite result panels every 30s (live like the board)
function refreshOpenFavs() {
  if (!navigator.onLine) return;
  document.querySelectorAll('.fav-results').forEach(panel => {
    if (panel.style.display === 'block') {
      const i = Number(panel.id.replace('fav-res-', ''));
      if (!Number.isNaN(i)) searchFav(i, null, true);
    }
  });
}
function startFavTimer() {
  if (homeState.favTimer) return;
  homeState.favTimer = setInterval(() => { if (!document.hidden) refreshOpenFavs(); }, REFRESH_MS);
  // Tick the "updated Xs ago" labels every 10s so they feel live between refreshes.
  homeState.favAgoTimer = setInterval(() => {
    document.querySelectorAll('.fav-updated-txt').forEach(el => { el.textContent = agoText(homeState.favUpdatedAt); });
  }, 10000);
}
function stopFavTimer() { clearInterval(homeState.favTimer); homeState.favTimer = null; clearInterval(homeState.favAgoTimer); homeState.favAgoTimer = null; }
function closeFavRes(i) {
  byId('fav-res-' + i).style.display = 'none';
  byId('fsb-' + i).textContent = t('search');
  // No open panels left → stop auto-refreshing
  const anyOpen = [...document.querySelectorAll('.fav-results')].some(p => p.style.display === 'block');
  if (!anyOpen) stopFavTimer();
}
function renderFavResults(data, j, idx) {
  const el = byId('fav-res-inner-' + idx); if (!el) return;
  const jrns = data?.journeys || [];
  if (!jrns.length) { el.innerHTML = `<div class="err">${t('err_no_journeys')}</div>`; return; }
  const now = new Date().toLocaleTimeString(i18n.lang === 'ko' ? 'ko-KR' : 'en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit' });
  let html = `<div style="font-size:12px;color:var(--muted);margin-bottom:12px;font-weight:500;">${j.from.name} → ${j.to.name} · ${now}</div>`;
  jrns.forEach((jrn, si) => {
    const legs = jrn.legs || [];
    const dep = estDep(legs[0]);
    const arr = estArr(legs[legs.length - 1]);
    const firstTL = legs.find(l => !isWalkLeg(l)) || legs[0];
    const lastTL = [...legs].reverse().find(l => !isWalkLeg(l)) || legs[legs.length - 1];
    const origPlat = cleanPlatform(firstTL?.stopSequence?.[0]?.disassembledName || firstTL?.origin?.disassembledName || '');
    const destPlat = cleanPlatform(lastTL?.stopSequence?.at(-1)?.disassembledName || lastTL?.destination?.disassembledName || '');
    const xfers = Math.max(0, legs.filter(l => !isWalkLeg(l)).length - 1);
    const badges = legs.map(l => {
      if (isWalkLeg(l)) return `<span class="lwalk">🚶${Math.round((l.duration || 0) / 60)}${t('m')}</span>`;
      const mot = l.transportation?.product?.class || 0;
      const nm = l.transportation?.disassembledName || l.transportation?.number || '';
      const isOnDemand = l.transportation?.iconId === 23 || l.transportation?.product?.iconId === 23;
      const { bg, fg } = getLineColors(mot, nm);
      const label = isOnDemand ? `${nm || 'On Demand'} 📲` : nm;
      return label ? `<span class="lbadge" style="background:${bg};color:${fg}">${label}</span>` : '';
    }).filter(Boolean).join('<span style="color:var(--muted);font-size:12px;margin:0 2px">›</span>');
    // FIX #4: prefix with fav index to avoid ID collision across multiple open fav cards
    const uid = `fv-${idx}-${si}`;
    // openStopsView() reads this map — populate it here too, else "show stops" on a
    // favourite card is a no-op (the map was only filled by the main journey list).
    if (svState.stops.size >= 50) svState.stops.delete(svState.stops.keys().next().value);
    svState.stops.set(uid, { legs, origName: cleanStationName(firstTL?.origin?.name || ''), destName: cleanStationName(lastTL?.destination?.name || '') });
    html += buildJCard(uid, dep, arr, firstTL, lastTL, origPlat, destPlat, legs, badges, xfers, false, 0, buildFareHtml(jrn.fare));
  });
  el.innerHTML = html;
}
function removeFav(i) {
  const favs = getFavJ(); const j = favs[i]; if (!j) return;
  const label = `${j.from.name} → ${j.to.name}`;
  showConfirm(label, () => {
    favs.splice(i, 1); saveFavJ(favs); renderFavsPage(); updateFavBanner();
  });
}

// ── Live "last updated" counter ───────────────────────────────────────────────
// Shared localized "Updated just now / Xs ago / Xm ago" text from a timestamp.
export function agoText(ts) {
  if (!ts) return t('updated_now');
  const secs = Math.round((Date.now() - ts) / 1000);
  return secs < 10 ? t('updated_now')
       : secs < 60 ? t('updated_secs').replace('{n}', secs)
       : t('updated_mins').replace('{n}', Math.round(secs / 60));
}
let lastFetchTime = null;
let updatedTimer  = null;
function startUpdatedCounter() {
  lastFetchTime = Date.now();
  clearInterval(updatedTimer);
  updatedTimer = setInterval(() => {
    const el = byId('rsub-time');
    if (el && lastFetchTime) el.textContent = agoText(lastFetchTime);
  }, 10000);
}

// ── Journey Search ────────────────────────────────────────────────────────────
let journeyTimer = null;
// The app header (sticky top:0) and the results refresh-bar (sticky under it) have
// variable heights (viewport, theme, font). Measure them into CSS vars so the
// refresh-bar sticks in the right place and the anchored "now" card clears both.
function _syncStickyVars() {
  const h = document.querySelector('header')?.offsetHeight;
  const rb = byId('journey-results')?.querySelector('.refresh-bar')?.offsetHeight;
  const r = document.documentElement;
  if (h)  r.style.setProperty('--hdr-h', h + 'px');
  if (rb) r.style.setProperty('--rbar-h', rb + 'px');
}
addEventListener('resize', () => requestAnimationFrame(_syncStickyVars));
// Every service since ~5am, auto-loaded once per search and prepended above the
// upcoming list. Held separately so the 30s refresh (which re-fetches only the
// upcoming set) can merge them back rather than wiping them.
let earlierJourneys = [];
// Full-week timetable state. `available` flips true once a rail /schedule load
// succeeds. The list is ONE continuous scroll: today loads first, then each
// following day (up to +6) is appended as the user scrolls near the bottom, with a
// day-divider header between days. `loadedDays` = how many days are in the list.
let schedState = { available: false, mode: null, cls: 0, loadedDays: 1, loading: false };
const _z2 = n => String(n).padStart(2, '0');
// YYYY-MM-DD of an instant in Sydney — used to detect day boundaries in the list.
const _sydDayKey = d => { if (!d) return ''; const p = sydParts(d instanceof Date ? d : new Date(d)); return `${p.year}-${_z2(p.month)}-${_z2(p.day)}`; };
const _uiLang = () => document.documentElement.lang || 'en-AU';
// Weekday label ("Tue") for an instant, in Sydney terms (UTC date-only so no shift).
function _weekdayShort(d) { const p = sydParts(d instanceof Date ? d : new Date(d)); return new Date(Date.UTC(p.year, p.month - 1, p.day)).toLocaleDateString(_uiLang(), { weekday: 'short', timeZone: 'UTC' }); }
// Full divider label ("Tuesday 21 Jul") for a day header.
function _dayHeaderLabel(d) { const p = sydParts(d instanceof Date ? d : new Date(d)); return new Date(Date.UTC(p.year, p.month - 1, p.day)).toLocaleDateString(_uiLang(), { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
// Stable per-journey id (planned dep+arr), reused for dedupe across fetches.
function _juid(j) {
  const l = j.legs || [];
  const dP = l[0]?.origin?.departureTimePlanned || l[0]?.stopSequence?.[0]?.departureTimePlanned;
  const aP = l[l.length-1]?.destination?.arrivalTimePlanned || l[l.length-1]?.stopSequence?.at(-1)?.arrivalTimePlanned;
  return stableUid(dP, aP);
}
const _jrnDep = j => estDep((j.legs || []).find(l => !isWalkLeg(l)) || j.legs?.[0]);
// Clean up interval on page unload to prevent stale polling after navigation
window.addEventListener('beforeunload', () => clearInterval(journeyTimer));

// ── Offline detection & UI manager ─────────────────────────────────────────
let _isOnline = navigator.onLine;
let _offlineToastTimer = null;
let _pendingSearchOnReconnect = false;

function setOnlineState(online) {
  if (online === _isOnline) return;
  _isOnline = online;

  // Update live pill in header
  const dot  = byId('live-dot');
  const pill = byId('live-pill');
  const txt  = byId('live-text');
  if (dot)  dot.classList.toggle('offline', !online);
  if (pill) pill.classList.toggle('offline-mode', !online);
  if (txt)  txt.textContent = online ? 'LIVE' : 'OFF';

  // Show toast
  showOfflineToast(online);

  // If coming back online and a search was pending, retry automatically
  if (online && _pendingSearchOnReconnect) {
    _pendingSearchOnReconnect = false;
    setTimeout(() => doSearch(), 600);
  }
}

function showOfflineToast(online) {
  const toast = byId('offline-toast');
  const dot   = byId('offline-dot');
  const msg   = byId('offline-toast-msg');
  if (!toast) return;

  clearTimeout(_offlineToastTimer);
  toast.classList.toggle('online', online);
  msg.textContent = online ? t('back_online') : t('off_toast');
  toast.classList.add('show');

  // Auto-hide after a few seconds
  _offlineToastTimer = setTimeout(() => toast.classList.remove('show'), online ? 3000 : 5000);
}

export function showOfflineCard(resultsEl) {
  resultsEl.innerHTML = `
    <div class="offline-card">
      <div class="offline-card-icon">📡</div>
      <div class="offline-card-title">${t('off_title')}</div>
      <div class="offline-card-sub">${t('off_sub')}</div>
      <div class="offline-card-tip">${t('off_tip')}</div>
      <button class="offline-retry-btn" onclick="retryWhenOnline()">
        <span>↺</span> ${t('off_retry')}
      </button>
    </div>`;
}

function retryWhenOnline() {
  if (navigator.onLine) {
    doSearch();
  } else {
    _pendingSearchOnReconnect = true;
    const btn = document.querySelector('.offline-retry-btn');
    if (btn) { btn.textContent = t('off_waiting'); btn.disabled = true; }
    showOfflineToast(false);
  }
}

window.addEventListener('online',  () => setOnlineState(true));
window.addEventListener('offline', () => setOnlineState(false));

// Set initial state on load
if (!navigator.onLine) setOnlineState(false);

// Fetch with an AbortController timeout — prevents indefinite hangs on cold/slow server
export async function timedFetch(url, ms = 35000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

function setFindBtn(loading) {
  const btn = byId('find-btn');
  const txt = byId('find-btn-txt');
  if (!btn || !txt) return;
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
  // Single searching indicator: the button itself shows "Searching…" + a spinner.
  txt.textContent = loading ? t('searching') : t('find');
}

export async function doSearch() {
  haptic([10]);
  const fn = byId('from-input').value.trim();
  const tn = byId('to-input').value.trim();
  if (!fn || !tn) {
    byId('journey-results').innerHTML = `<div class="err">${t('err_both')}</div>`;
    return;
  }

  // Check offline before doing anything
  if (!navigator.onLine) {
    showOfflineCard(byId('journey-results'));
    _pendingSearchOnReconnect = true;
    return;
  }

  setFindBtn(true);
  clearInterval(journeyTimer);

  // If server hasn't responded yet, show a contextual message while we wait
  if (!serverReady) {
    byId('journey-results').innerHTML =
      `<div class="spin-wrap"><div class="spin"></div>${t('warm_starting')}… may take ~20s on first use</div>`;
    await warmServer().catch(() => {});
  }

  const _resEl = byId('journey-results');
  _resEl.innerHTML = skeletonCards(4);

  try {
    if (!state.from.id) state.from.id = await resolveId(fn);
    if (!state.to.id) state.to.id = await resolveId(tn);
    if (!state.from.id || !state.to.id) {
      byId('journey-results').innerHTML =
        `<div class="err">${t('err_not_found')}</div>`;
      setFindBtn(false);
      return;
    }
    earlierJourneys = [];   // fresh search → forget any prior morning services
    schedState = { available: false, mode: null, cls: 0, loadedDays: 1, loading: false };
    await fetchJourneys(true);
    if (!state.from.name) state.from.name = fn;
    if (!state.to.name)   state.to.name = tn;
    pushRecent(state.from, state.to);
    // Only auto-refresh for live "now" searches — timetable results don't change
    if (!departAt) journeyTimer = setInterval(() => { if (!document.hidden) fetchJourneys(false); }, REFRESH_MS);
  } catch (e) {
    const resultsEl = byId('journey-results');
    if (!navigator.onLine || e.message?.includes('NetworkError') || e.message?.includes('Failed to fetch')) {
      showOfflineCard(resultsEl);
      _pendingSearchOnReconnect = true;
    } else {
      const isTimeout = e.name === 'AbortError';
      const msg = isTimeout ? t('err_timeout') : e.message;
      resultsEl.innerHTML =
        `<div class="err" style="flex-direction:column;align-items:flex-start;gap:10px">
          <span>⚠ ${msg}</span>
          <button class="retry-btn" onclick="doSearch()">${t('err_retry')}</button>
        </div>`;
    }
  } finally {
    setFindBtn(false);
  }
}

export async function fetchJourneys(doScroll = false) {
  const p = { from: state.from.id, to: state.to.id };
  if (activeMode) p.excl = activeMode;
  if (departAt) { p.itdDate = departAt.itdDate; p.itdTime = departAt.itdTime; }
  const res = await timedFetch(PROXY + '/trip?' + new URLSearchParams(p));
  if (!res.ok) return;
  serverReady = true;
  const data  = await res.json();
  const fresh = data.journeys || [];
  currentPastJourneyData = null;
  // Merge the already-loaded morning services back in — the 30s refresh only
  // re-fetches the upcoming set, so without this it would wipe the earlier list.
  if (earlierJourneys.length) {
    const seen = new Set(fresh.map(_juid));
    const kept = earlierJourneys.filter(j => !seen.has(_juid(j)));
    currentJourneyData = { ...data, journeys: [...kept, ...fresh] };
    jr.showPast = true;
  } else {
    currentJourneyData = data;
    jr.showPast = false;
  }
  jr.sig = ''; jr.struct = ''; jr.cards.clear();   // force full rebuild
  renderJourneys(currentJourneyData, null, doScroll);
  // Live "now" search: once, in the background, load the FULL day's timetable and
  // fold it in (user lands on "now", scrolls up for earlier / down for the rest).
  if (doScroll && !departAt && !earlierJourneys.length) loadFullSchedule(fresh);
}

// TfNSW product class → GTFS schedule mode (rail only — bus stops aren't named
// "Platform N" so the /schedule lookup can't match them; those fall back to the
// planner windows).
const _SCHED_MODE = { 1: 'trains', 2: 'metro', 4: 'lightrail', 9: 'ferries' };

// Full-day timetable from the GTFS /schedule endpoint. Synthesises a lean card per
// scheduled service, but keeps the rich /trip cards (live delay, platforms, line)
// wherever their departure minute matches — so "now" stays live and the rest of the
// day fills in as a timetable. Non-rail / unsupported → planner-window fallback.
async function loadFullSchedule(fresh) {
  if (!state.from.id || !state.to.id || departAt) return;
  const tl  = fresh.map(j => (j.legs || []).find(l => !isWalkLeg(l))).find(Boolean);
  const cls = tl?.transportation?.product?.class;
  const mode = _SCHED_MODE[cls];
  if (!mode) return loadEarlierFromMorning(fresh);        // non-rail → planner windows

  const sp = sydParts(new Date());
  const z2 = n => String(n).padStart(2, '0');
  const date  = `${sp.year}${z2(sp.month)}${z2(sp.day)}`;
  const fromN = (state.from.name || '').split(',')[0].trim();
  const toN   = (state.to.name   || '').split(',')[0].trim();
  let res = null;
  try {
    res = await timedFetch(PROXY + '/schedule?' + new URLSearchParams({ from: fromN, to: toN, date, mode }))
      .then(r => (r.ok ? r.json() : null));
  } catch { res = null; }
  if (!res || !res.supported || !(res.services || []).length) return loadEarlierFromMorning(fresh);
  if (!currentJourneyData || !state.from.id) return;      // a newer search started

  // seconds-of-Sydney-day → absolute instant, offset-free: both are Sydney wall
  // clock, so the delta from "now" is the same in absolute time.
  const nowSec = sp.hour * 3600 + sp.minute * 60;
  const toISO  = sec => new Date(Date.now() + (sec - nowSec) * 1000).toISOString();
  const freshMin = new Set();
  for (const j of fresh) { const d = _jrnDep(j); if (d) freshMin.add(Math.floor(new Date(d).getTime() / 60000)); }

  const synth = [];
  for (const s of res.services) {
    const depISO = toISO(s.dep);
    if (freshMin.has(Math.floor(new Date(depISO).getTime() / 60000))) continue;  // rich card wins
    synth.push(_schedCard(s, cls, depISO, toISO(s.arr)));
  }
  schedState = { available: true, mode, cls, loadedDays: 1, loading: false };
  if (!synth.length) return;
  earlierJourneys = synth;                                // 30s refresh keeps them
  const all = [...synth, ...fresh].sort((a, b) => new Date(_jrnDep(a)) - new Date(_jrnDep(b)));
  currentJourneyData = { ...currentJourneyData, journeys: all };
  jr.showPast = true; jr.sig = ''; jr.struct = '';
  renderJourneys(currentJourneyData, null, false);
  _installSchedScroll();
  // Anchor to the earliest UPCOMING rich service so the list doesn't jump.
  let anchorUid = null, anchorT = Infinity;
  for (const j of fresh) { const t = new Date(_jrnDep(j)).getTime(); if (t < anchorT) { anchorT = t; anchorUid = _juid(j); } }
  if (anchorUid) requestAnimationFrame(() => {
    const card = document.querySelector(`.jcard[data-juid="${anchorUid}"]`);
    if (card) card.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
}

// Target Sydney calendar date (YYYYMMDD) for a day offset. Date-only UTC
// arithmetic so a DST transition inside the week can't shift the date.
function _schedYmd(off) {
  const sp = sydParts(new Date());
  const d = new Date(Date.UTC(sp.year, sp.month - 1, sp.day));
  d.setUTCDate(d.getUTCDate() + off);
  return `${d.getUTCFullYear()}${_z2(d.getUTCMonth() + 1)}${_z2(d.getUTCDate())}`;
}

// One synthesised timetable card from a /schedule service. Platforms (depPlat/
// arrPlat) ride in origin/destination.properties so buildJCard renders them just
// like a /trip card; line badges still need route data in the GTFS DB.
function _schedCard(s, cls, depISO, arrISO) {
  return {
    legs: [{
      origin:      { name: state.from.name, departureTimePlanned: depISO, properties: s.depPlat ? { platform: s.depPlat } : undefined },
      destination: { name: state.to.name,   arrivalTimePlanned:   arrISO, properties: s.arrPlat ? { platform: s.arrPlat } : undefined },
      transportation: { product: { class: cls }, disassembledName: '' },
    }],
    _sched: true, _tripId: s.tripId,
  };
}

// Append the next day's full timetable to the continuous list. Fires from the
// scroll handler as the user nears the bottom, once per day, up to +6 days out.
async function appendNextSchedDay() {
  if (!schedState.available || schedState.loading || schedState.loadedDays > 6) return;
  if (!state.from.id || !state.to.id || departAt) return;
  const off = schedState.loadedDays;                     // 1..6
  schedState.loading = true;
  try {
    const fromN = (state.from.name || '').split(',')[0].trim();
    const toN   = (state.to.name   || '').split(',')[0].trim();
    const mode  = schedState.mode, cls = schedState.cls;
    let res = null;
    try {
      res = await timedFetch(PROXY + '/schedule?' + new URLSearchParams({ from: fromN, to: toN, date: _schedYmd(off), mode }))
        .then(r => (r.ok ? r.json() : null));
    } catch { res = null; }
    const services = (res && res.supported && res.services) || [];
    schedState.loadedDays = off + 1;                     // consumed this day even if empty
    if (!services.length || !currentJourneyData) return;
    // Seconds-of-day → absolute instant at that day's Sydney midnight.
    const sp = sydParts(new Date());
    const nowSec = sp.hour * 3600 + sp.minute * 60;
    const base = (Date.now() - nowSec * 1000) + off * 86400 * 1000;
    const toISO = sec => new Date(base + sec * 1000).toISOString();
    const add = services.map(s => _schedCard(s, cls, toISO(s.dep), toISO(s.arr)));
    earlierJourneys = [...earlierJourneys, ...add];      // kept across the 30s refresh
    const all = [...(currentJourneyData.journeys || []), ...add]
      .sort((a, b) => new Date(_jrnDep(a)) - new Date(_jrnDep(b)));
    currentJourneyData = { ...currentJourneyData, journeys: all };
    jr.showPast = true; jr.sig = ''; jr.struct = '';
    renderJourneys(currentJourneyData, null, false, true);   // showAll: keep future days
  } finally {
    schedState.loading = false;
  }
}

// Attach a single passive scroll handler (once) that appends the next day when the
// user scrolls within ~1200px of the bottom of the results.
let _schedScrollBound = false;
function _installSchedScroll() {
  if (_schedScrollBound) return;
  _schedScrollBound = true;
  addEventListener('scroll', () => {
    if (!schedState.available || schedState.loading || schedState.loadedDays > 6) return;
    if (byId('page-journey')?.offsetParent == null) return;   // only while the results are visible
    const nearBottom = (window.innerHeight + window.scrollY) >= (document.body.offsetHeight - 1200);
    if (nearBottom) appendNextSchedDay();
  }, { passive: true });
}

// Auto-load all services from ~5am up to the first upcoming departure and prepend
// them. Runs ONCE per search, in the background — the upcoming results already
// rendered, so this never slows the first result. Windows every 2h are fetched in
// parallel and deduped; the view is anchored to "now" so prepending doesn't jump.
async function loadEarlierFromMorning(fresh) {
  if (!state.from.id || !state.to.id || departAt) return;
  let boundary = Infinity;
  for (const j of fresh) {
    const d = _jrnDep(j); const t = d ? new Date(d).getTime() : Infinity;
    if (t < boundary) boundary = t;
  }
  const sp = sydParts(new Date());
  const z2 = n => String(n).padStart(2, '0');
  const date = `${sp.year}${z2(sp.month)}${z2(sp.day)}`;
  const windows = [];
  for (let h = 5; h <= sp.hour; h += 2) windows.push(z2(h) + '00');
  if (!windows.length) return;   // before ~5am there is nothing earlier today
  const batches = await Promise.all(windows.map(time => {
    const q = { from: state.from.id, to: state.to.id, itdDate: date, itdTime: time, trips: '20' };
    if (activeMode) q.excl = activeMode;
    return timedFetch(PROXY + '/trip?' + new URLSearchParams(q))
      .then(r => r.ok ? r.json() : { journeys: [] }).catch(() => ({ journeys: [] }));
  }));
  const seen = new Set(fresh.map(_juid));
  const earlier = [];
  for (const b of batches) for (const j of (b.journeys || [])) {
    if (!(j.legs || []).some(l => !isWalkLeg(l))) continue;   // real transit only
    const d = _jrnDep(j);
    if (!d || new Date(d).getTime() >= boundary) continue;    // strictly earlier
    const u = _juid(j);
    if (seen.has(u)) continue;
    seen.add(u); earlier.push(j);
  }
  if (!earlier.length) return;
  // A different search may have started while we awaited — bail if so.
  if (!currentJourneyData || !state.from.id) return;
  earlier.sort((a, b) => new Date(_jrnDep(a)) - new Date(_jrnDep(b)));
  earlierJourneys = earlier;
  // Anchor to the earliest UPCOMING service so the list doesn't jump when the
  // morning services slot in above it.
  let anchorUid = null, anchorT = Infinity;
  for (const j of fresh) { const t = new Date(_jrnDep(j)).getTime(); if (t < anchorT) { anchorT = t; anchorUid = _juid(j); } }
  currentJourneyData = { ...currentJourneyData, journeys: [...earlier, ...fresh] };
  jr.showPast = true; jr.sig = ''; jr.struct = '';
  renderJourneys(currentJourneyData, null, false);
  if (anchorUid) requestAnimationFrame(() => {
    const card = document.querySelector(`.jcard[data-juid="${anchorUid}"]`);
    if (card) card.scrollIntoView({ block: 'start', behavior: 'auto' });
  });
}


// Fetch all services for today across 5 time windows and show them all.
// TfNSW returns ~12 trips per call; 5 calls × 15 trips = ~75 results covering the full day.
async function fetchAllTodayJourneys() {
  if (!state.from.id || !state.to.id) return;
  clearInterval(journeyTimer); journeyTimer = null;

  const el = byId('journey-results');
  el.innerHTML = `<div class="spin-wrap"><div class="spin"></div>Loading all of today's services…</div>`;

  const sp   = sydParts(new Date());
  const date = `${sp.year}${String(sp.month).padStart(2,'0')}${String(sp.day).padStart(2,'0')}`;
  // 5 windows cover a full operating day (first service ~04:00, last ~01:00 next day)
  const windows = ['0000', '0500', '1000', '1500', '2000'];

  const results = await Promise.all(windows.map(time => {
    const p = { from: state.from.id, to: state.to.id, itdDate: date, itdTime: time, trips: '15' };
    if (activeMode) p.excl = activeMode;
    return timedFetch(PROXY + '/trip?' + new URLSearchParams(p))
      .then(r => r.ok ? r.json() : { journeys: [] })
      .catch(() => ({ journeys: [] }));
  }));

  // Merge all batches into one data object (renderJourneys handles deduplication)
  const merged = { journeys: results.flatMap(d => d.journeys || []) };
  currentJourneyData = merged;
  currentPastJourneyData = null;
  renderJourneys(merged, null, true, true);  // showAll=true → don't filter past services
}

// Passive re-render of the current journey results (no scroll). Cheap now — the
// signature-skip inside renderJourneys makes a no-op call a couple of Map reads.
// Centralises the guard copy-pasted at 7 call sites.
export function rerenderJourneys() {
  if (currentJourneyData) renderJourneys(currentJourneyData, null, false);
}

function renderJourneys(data, _pastData, doScroll = false, showAll = false) {
  const allJourneysMap = new Map();
  (data?.journeys || []).forEach((j, idx) => {
    const legs = j.legs || []; if (!legs.length) return;
    // Dedup key = planned dep+arr PLUS the transit-line signature, so two genuinely
    // different services that happen to share dep/arr times aren't merged into one
    // (that previously made services "go missing"). Fall back to estimated times,
    // then to the array index, so a service is never skipped for lacking a field.
    const depP = legs[0]?.origin?.departureTimePlanned || legs[0]?.origin?.departureTimeEstimated
              || legs[0]?.stopSequence?.[0]?.departureTimePlanned || '';
    const arrP = legs[legs.length-1]?.destination?.arrivalTimePlanned || legs[legs.length-1]?.destination?.arrivalTimeEstimated
              || legs[legs.length-1]?.stopSequence?.at(-1)?.arrivalTimePlanned || '';
    const sig = legs.filter(l => !isWalkLeg(l))
      .map(l => l.transportation?.disassembledName || l.transportation?.number || '?').join('>');
    const key = (depP || arrP) ? `${depP}-${arrP}-${sig}-${legs.length}` : `idx-${idx}`;
    allJourneysMap.set(key, j);  // always overwrite → keeps the freshest copy of a true duplicate
  });

  // FIX #8: null guard in sort
  const allJourneys = Array.from(allJourneysMap.values()).sort((a, b) => {
    const depA = estDep(a.legs?.[0]);
    const depB = estDep(b.legs?.[0]);
    if (!depA || !depB) return 0;
    return new Date(depA) - new Date(depB);
  });

  const now2 = new Date();
  const DEPART_GRACE_MS = 60 * 1000;
  const juid = j => {
    const dP = j.legs[0]?.origin?.departureTimePlanned || j.legs[0]?.stopSequence?.[0]?.departureTimePlanned;
    const aP = j.legs[j.legs.length-1]?.destination?.arrivalTimePlanned || j.legs[j.legs.length-1]?.stopSequence?.at(-1)?.arrivalTimePlanned;
    return stableUid(dP, aP);
  };

  // Keep each tracked journey's latest data as a snapshot, so when TfNSW stops
  // returning it (it has departed and is no longer "upcoming"), we can still show
  // it — the en-route marker keeps advancing. Drop a pin only when the user stops
  // it or the trip is very old (handled by _trackStale on render/restore).
  let _trackChanged = false;
  trackState.uids.forEach(uid => {
    const fresh = allJourneys.find(j => juid(j) === uid);
    if (fresh) {
      const ftl = fresh.legs.find(l => !isWalkLeg(l)) || fresh.legs[0];
      const ltl = [...fresh.legs].reverse().find(l => !isWalkLeg(l)) || fresh.legs[fresh.legs.length - 1];
      trackState.data.set(uid, { legs: fresh.legs, origName: cleanStationName(ftl?.origin?.name || ''), destName: cleanStationName(ltl?.destination?.name || '') });
      _trackChanged = true;
    }
  });
  if (_trackChanged) persistTracked();

  const visibleJrns = allJourneys.filter(j => {
    if (activeMode && !j.legs.some(l => !isWalkLeg(l))) return false;
    if (showAll || jr.showPast) return true;  // full-day / "earlier services" view
    if (departAt) return true;
    if (isTracked(juid(j))) return true;
    const boardable = j.legs.find(l => !isWalkLeg(l)) || j.legs[0];
    const dep = estDep(boardable);
    const arr = estArr(j.legs[j.legs.length - 1]);
    if (arr && new Date(arr) < now2) return false;
    if (dep && (now2 - new Date(dep)) > DEPART_GRACE_MS) return false;
    return true;
  });

  // If any tracked service was dropped from the feed (departed / different route),
  // re-inject its snapshot so it doesn't disappear mid-trip.
  trackState.uids.forEach(uid => {
    if (visibleJrns.some(j => juid(j) === uid)) return;
    const snap = trackState.data.get(uid);
    if (snap?.legs?.length && !_trackStale(estArr(snap.legs[snap.legs.length - 1]))) {
      visibleJrns.push({ legs: snap.legs });
    }
  });

  // Sort by departure time
  visibleJrns.sort((a, b) => {
    const da = estDep(a.legs[0]), db = estDep(b.legs[0]);
    if (!da || !db) return 0;
    return new Date(da) - new Date(db);
  });

  if (!visibleJrns.length) {
    const msg = activeMode ? t('err_no_mode') : t('err_no_journeys');
    byId('journey-results').innerHTML =
      `<div class="err" style="flex-direction:column;align-items:flex-start;gap:10px"><span>${msg}</span>${activeMode ? `<button class="retry-btn" onclick="document.querySelector('#page-journey .mb').click()">${t('all')}</button>` : ''}</div>`;
    jr.sig = ''; jr.struct = ''; jr.cards.clear();
    return;
  }

  // Skip the full innerHTML rebuild when nothing that affects the cards changed
  // (the common case on the 30 s / VP-load ticks) — avoids reparsing the DOM,
  // layout thrash and GC churn, and preserves scroll/focus. The "updated Xs ago"
  // label ticks on its own timer, so freezing the card DOM is safe.
  if (!doScroll) {
    const vpEpoch = _vpEpochSum();
    const sig = visibleJrns.map(j => {
      const b = j.legs.find(l => !isWalkLeg(l)) || j.legs[0];
      return juid(j) + '~' + (estDep(b) || '') + '~' + (estArr(j.legs[j.legs.length - 1]) || '');
    }).join('|') + `#${visibleJrns.length}${showAll ? 'A' : ''}${activeMode || ''}`
      + (isFavJ(state.from.id, state.to.id) ? 'F' : '') + '@' + vpEpoch + '/' + [...trackState.uids].join(',');
    const resEl = byId('journey-results');
    if (sig === jr.sig && resEl && resEl.children.length) return;
    jr.sig = sig;
  }

  const fn    = byId('from-input').value;
  const tn    = byId('to-input').value;
  const saved = isFavJ(state.from.id, state.to.id);

  const datNote = departAt
    ? (() => { const d = departAt.itdDate, ti = departAt.itdTime;
        const ds = `${d.slice(6,8)}/${d.slice(4,6)}/${d.slice(0,4)}`;
        const ts = `${ti.slice(0,2)}:${ti.slice(2,4)}`;
        return `🗓 ${ds} at ${ts}`; })()
    : null;

  const allDayNote = showAll ? `<span style="color:var(--blue);font-weight:700;">All day</span> · ` : '';
  let html = `<div class="refresh-bar fadein">
    <div class="rtitle">${fn} <span class="rtitle-arrow">→</span> ${tn}</div>
    <div class="refresh-bar-row">
      <div class="rsub" id="rsub-updated">
        <div class="rsub-main">${visibleJrns.length} ${t('journeys_count')}${allDayNote ? ` · ${allDayNote}` : ''}${datNote ? ` · <span style="color:var(--blue);font-weight:700;">${datNote}</span>` : ` · <span id="rsub-time">${t('updated_now')}</span>`}</div>
        <div class="rsub-meta"><span class="tz-tag" title="${t('syd_note')}">🕑 ${tzNote()}</span>${weatherPillHtml() ? weatherPillHtml() : ''}</div>
      </div>
      <div class="refresh-bar-actions">
        ${_favBtnHtml()}
        <button class="refresh-btn" onclick="manualRefreshJourney(this)" aria-label="Refresh"><span>↻</span></button>
        ${!departAt && !showAll ? `<div class="auto-badge"><span class="ldot"></span></div>` : ''}
      </div>
    </div>
  </div>`;

  // (Earlier services are auto-loaded since ~5am and prepended — no button. The
  // user lands on "now" and scrolls up through the morning.)

  // Build one card's args + HTML (also refreshes the stops-data map entry).
  const _buildOneCard = (j, idx, animate) => {
    const legs = j.legs || [];
    const dep = estDep(legs[0]);
    const arr = estArr(legs[legs.length - 1]);
    const firstTL = legs.find(l => !isWalkLeg(l)) || legs[0];
    const lastTL = [...legs].reverse().find(l => !isWalkLeg(l)) || legs[legs.length - 1];
    const origPlat = legOriginPlat(firstTL);
    const destPlat = legDestPlat(lastTL);
    const xfers = Math.max(0, legs.filter(l => !isWalkLeg(l)).length - 1);
    const badges = legs.map(l => {
      if (isWalkLeg(l)) return `<span class="lwalk">🚶${Math.round((l.duration || 0) / 60)}${t('m')}</span>`;
      const mot = l.transportation?.product?.class || 0;
      const nm = l.transportation?.disassembledName || l.transportation?.number || '';
      const isOnDemand = l.transportation?.iconId === 23 || l.transportation?.product?.iconId === 23;
      const { bg, fg } = getLineColors(mot, nm);
      const label = isOnDemand ? `${nm || 'On Demand'} 📲` : nm;
      return label ? `<span class="lbadge" style="background:${bg};color:${fg}">${label}</span>` : '';
    }).filter(Boolean).join('<span style="color:var(--muted);font-size:12px;margin:0 3px">›</span>');
    const depP = legs[0]?.origin?.departureTimePlanned || legs[0]?.stopSequence?.[0]?.departureTimePlanned;
    const arrP = legs[legs.length-1]?.destination?.arrivalTimePlanned || legs[legs.length-1]?.stopSequence?.at(-1)?.arrivalTimePlanned;
    const uid  = stableUid(depP, arrP);
    if (svState.stops.size >= 50 && !svState.stops.has(uid)) svState.stops.delete(svState.stops.keys().next().value);
    svState.stops.set(uid, { legs, origName: cleanStationName(firstTL?.origin?.name || ''), destName: cleanStationName(lastTL?.destination?.name || '') });
    const fareHtml = buildFareHtml(j.fare);
    return { uid, html: buildJCard(uid, dep, arr, firstTL, lastTL, origPlat, destPlat, legs, badges, xfers, animate, idx, fareHtml, { fn, tn }) };
  };

  const container = byId('journey-results');
  // Structure signature = the exact set + order of cards (plus mode/fav/departAt
  // flags). If unchanged, we PATCH only the cards whose HTML differs instead of
  // rebuilding the whole list — unchanged cards keep their DOM (no reparse/reflow).
  const structSig = visibleJrns.map(j => {
    const l = j.legs || [];
    return stableUid(l[0]?.origin?.departureTimePlanned || l[0]?.stopSequence?.[0]?.departureTimePlanned,
                     l[l.length-1]?.destination?.arrivalTimePlanned || l[l.length-1]?.stopSequence?.at(-1)?.arrivalTimePlanned);
  }).join(',') + `#${showAll ? 'A' : ''}${activeMode || ''}${saved ? 'F' : ''}${departAt ? 'D' : ''}`;
  const canPatch = jr.struct === structSig && container && container.querySelector('.jcard');

  if (!canPatch) {
    jr.cards.clear();
    // Day-divider header whenever the Sydney date changes between consecutive cards
    // — only fires in a multi-day (timetable) list; single-day results never show one.
    let _lastDay = '';
    visibleJrns.forEach((j, idx) => {
      const c = _buildOneCard(j, idx, true);
      const dk = _sydDayKey(_jrnDep(j));
      if (dk && dk !== _lastDay) {
        if (_lastDay) html += `<div class="day-divider">${_dayHeaderLabel(_jrnDep(j))}</div>`;
        _lastDay = dk;
      }
      jr.cards.set(c.uid, c.html); html += c.html;
    });
    container.innerHTML = html;
  } else {
    // Same journeys → swap only the cards that actually changed (delay/live/etc.).
    visibleJrns.forEach((j, idx) => {
      const c = _buildOneCard(j, idx, false);
      if (jr.cards.get(c.uid) === c.html) return;                 // unchanged → leave DOM
      const el = container.querySelector(`.jcard[data-juid="${c.uid}"]`);
      if (el) { el.outerHTML = c.html; jr.cards.set(c.uid, c.html); }
    });
  }
  jr.struct = structSig;
  // (Tracked snapshots were refreshed + persisted above as the feed was processed.)
  startUpdatedCounter();
  updateFab();
  _syncStickyVars();   // header + refresh-bar heights drive the sticky offset

  // Warm the live vehicle feed for the modes on screen so seat-availability and
  // LIVE badges can populate on the cards (otherwise the feed only loads when the
  // user opens show-stops). Re-renders once if new data arrives.
  _prefetchVpForJourneys(visibleJrns);

  // Refresh the stops view if it's open (data map is now up to date)
  if (svState.open && svState.uid) refreshStopsView();

  if (doScroll) {
    // Scroll to the TOP of the results container (a stable target), not the first
    // card — cards animate in with a staggered transform, so targeting a card mid
    // animation lands on a random row. Wait a frame so layout settles first.
    requestAnimationFrame(() => {
      const el = byId('journey-results');
      if (!el) return;
      const header = document.querySelector('header');
      const offset = (header?.offsetHeight || 0) + 8;
      const y = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    });
  }
}

// ── Fare display ──────────────────────────────────────────────────────────────
// Reads the real fare TfNSW returns on each journey: journey.fare.tickets[]. The
// NSW-specific fields (evaluationTicket, priceTotalFare, priceStationAccessFee,
// riderCategoryName) live inside each ticket's `properties` object — only the
// generic priceBrutto/currency sit at the top level. Nothing here is hardcoded;
// if the API omits fare (e.g. fare not yet evaluated for that mode) we render nothing.
function _ticketProps(tk) { return { ...tk, ...(tk.properties || {}) }; }
function _ticketPrice(tk) { return +(tk.priceTotalFare || tk.priceBrutto || 0); }
function buildFareHtml(fare) {
  if (!fare) return '';
  const tickets = (fare.tickets || []).map(_ticketProps)
    .filter(tk => tk.evaluationTicket !== 'nswFareNotAvailable');
  if (!tickets.length) return '';
  // Prefer an Adult ticket; otherwise the cheapest priced ticket.
  const adult = tickets.find(tk => /adult/i.test(tk.riderCategoryName || tk.person || ''));
  const priced = tickets.filter(tk => _ticketPrice(tk) > 0).sort((a, b) => _ticketPrice(a) - _ticketPrice(b));
  const ticket = adult || priced[0] || tickets[0];

  const evalState = ticket.evaluationTicket || '';
  const price = _ticketPrice(ticket);
  const saf   = +(ticket.priceStationAccessFee || 0);
  const rider = ticket.riderCategoryName;

  // Nothing useful to show (no price and no meaningful state) → render nothing.
  if (!price && evalState !== 'nswFareNotEnabled' && evalState !== 'nswFarePartiallyEnabled') return '';

  let html = '<div class="fare-pill">';
  if (price > 0) {
    html += `<span class="fare-price">$${price.toFixed(2)}</span>`;
    if (saf > 0) html += `<span class="fare-saf" title="incl. $${saf.toFixed(2)} station access fee">+ $${saf.toFixed(2)} SAF</span>`;
    if (rider) html += `<span class="fare-rider">${rider}</span>`;
  }
  if (evalState === 'nswFarePartiallyEnabled') html += `<span class="fare-partial">partial fare</span>`;
  else if (evalState === 'nswFareNotEnabled' && !price) html += `<span class="fare-na">fare unavailable</span>`;
  html += '</div>';
  return html;
}

// ── Accessibility ─────────────────────────────────────────────────────────────
// Decide whether a whole journey is wheelchair / step-free accessible, reading
// the flags TfNSW returns on each transit leg (and any live vehicle data we have).
// Only returns true when EVERY transit leg is confirmed accessible — a journey is
// only step-free if no leg breaks the chain.
function _legAccessible(l) {
  const p = { ...(l.properties || {}), ...(l.transportation?.properties || {}) };
  const truthy = v => v === '1' || v === 1 || v === true || String(v).toLowerCase() === 'true';
  if (truthy(p.PlanWheelChairAccess) || truthy(p.PlanLowFloorVehicle) || truthy(p.WheelchairAccess)) return true;
  // Boarding/alighting stops can also carry the flag
  const sp = l.stopSequence?.[0]?.properties || l.origin?.properties || {};
  if (truthy(sp.WheelchairAccess)) return true;
  // Live GTFS-RT vehicle descriptor (trains/metro report wheelchair_accessible)
  const tripCode = l.transportation?.properties?.tripCode || l.transportation?.id?.split(':')?.[1] || '';
  const mot = l.transportation?.product?.class;
  if (mot != null) { const v = _vpByTripId(tripCode, mot); if (v?.accessible) return true; }
  return false;
}
function journeyAccessible(legs) {
  const transit = (legs || []).filter(l => !isWalkLeg(l));
  if (!transit.length) return false;
  return transit.every(_legAccessible);
}

// ── Journey card builder ──────────────────────────────────────────────────────
function buildJCard(uid, dep, arr, firstTL, lastTL, origPlat, destPlat, legs, badges, xfers, animate, animIdx = 0, fareHtml = '', hdr = {}) {
  const origName = cleanStationName(firstTL?.origin?.name || '');
  const destName = cleanStationName(lastTL?.destination?.name || '');
  const anim     = animate ? `animation-delay:${animIdx * 0.05}s` : '';

  // Delay/status must come from the TRANSIT legs — legs[0] and the last leg are
  // often walks, which carry no realtime data, so the card otherwise looked
  // "on time" while the stops view showed +3m. Use first/last transit legs.
  const _firstT = legs.find(l => !isWalkLeg(l));
  const _lastT  = [...legs].reverse().find(l => !isWalkLeg(l));
  const depPlanned = _firstT?.origin?.departureTimePlanned || _firstT?.stopSequence?.[0]?.departureTimePlanned;
  const arrPlanned = _lastT?.destination?.arrivalTimePlanned || _lastT?.stopSequence?.at(-1)?.arrivalTimePlanned;
  const depDelay   = _firstT ? delayMins(depPlanned, estDep(_firstT)) : 0;
  const arrDelay   = _lastT  ? delayMins(arrPlanned, estArr(_lastT))  : 0;

  // No status pill: delayBadge() + plannedLine() already state the delay at BOTH
  // times, so a pill was a third copy — and its "On time" variant fired on every
  // card, which is not information. No badge on a time = that time is on time.
  const worstDelay = Math.max(depDelay, arrDelay);
  const delayClass = worstDelay > 0 ? 'delay-late' : (depPlanned || arrPlanned) ? 'delay-ok' : '';

  const nowCheck     = new Date();
  const firstTransit = legs.find(l => !isWalkLeg(l));
  const transitDep   = firstTransit ? estDep(firstTransit) : null;
  const hasDeparted  = transitDep ? new Date(transitDep) <= nowCheck : false;
  let departedPill = hasDeparted ? `<span class="status-pill status-departed">${t('departed')}</span>` : '';
  const tracked      = isTracked(uid);
  const trackingPill = tracked ? `<span class="status-pill status-tracking">📍 ${t('tracking_badge')}</span>` : '';

  const platAlerts = platChangeBadges(uid, origPlat, destPlat);
  const seat       = seatBadgeHtml(firstTransit || legs[0], dep);
  const a11y       = journeyAccessible(legs)
    ? `<span class="a11y-badge" title="Step-free / wheelchair accessible">♿ ${t('accessible')}</span>` : '';
  // Real-time availability badge — only for the states that DEFY expectation.
  //  • Completed (already arrived) → "✓ Completed" — realtime has expired, so
  //    only planned times remain.
  //  • No realtime → "○ No live data" (times are scheduled, trust them less).
  //  • Live → nothing. Live is what a rider already assumes; badging it on every
  //    card spent ink to say "normal".
  const _transitLegs = legs.filter(l => !isWalkLeg(l));
  const _journeyDone = arr && new Date(arr) <= nowCheck;
  const rtBadge = !_transitLegs.length ? ''
    : _journeyDone
      ? `<span class="rt-badge rt-done" title="${t('rt_done_tip') || 'This service has completed'}">✓ ${t('rt_done') || 'Completed'}</span>`
      : _transitLegs.some(legIsRealtime)
        ? ''
        : `<span class="rt-badge rt-off" title="${t('rt_off_tip') || 'No real-time data — scheduled times only'}">○ ${t('rt_none') || 'No live data'}</span>`;
  // The countdown block now states Departed/Done itself, so the pill is a second
  // copy of the same word on the same card.
  departedPill = '';

  // ── Countdown block (TripView anatomy) ──────────────────────────────────────
  // A departure board is scanned for "how long have I got", not "what o'clock is
  // it" — so the countdown is the card's hero, and it wears the LINE's colour so
  // the service is identified by sight before "T1" is ever read. Clock times stay,
  // one tier down.
  const _cdLine = firstTransit || legs[0];
  const _cdMot = _cdLine?.transportation?.product?.class ?? 0;
  const _cdNm = _cdLine?.transportation?.disassembledName || _cdLine?.transportation?.number || '';
  const _cdCol = getLineColors(_cdMot, _cdNm);
  let cdMain = '', cdSub = '';
  if (_journeyDone)        { cdMain = t('rt_done') || 'Done'; }
  else if (hasDeparted)    { cdMain = t('departed') || 'Departed'; }
  else if (transitDep) {
    // A service on a LATER Sydney day shows the weekday ("Tue"), not a huge hour
    // count ("17h 53 min") — the day divider + clock time carry the rest.
    if (_sydDayKey(transitDep) !== _sydDayKey(nowCheck)) { cdMain = _weekdayShort(transitDep); }
    else {
      const mins = Math.round((new Date(transitDep) - nowCheck) / 60000);
      if (mins <= 0)        { cdMain = t('cd_now') || 'Now'; }
      else if (mins < 60)   { cdMain = String(mins); cdSub = mins === 1 ? (t('cd_min') || 'min') : (t('cd_mins') || 'mins'); }
      else {                 // >1h out (same day): time LEFT, not the clock time
        const h = Math.floor(mins / 60), m = mins % 60;
        cdMain = m ? `${h}h ${m}` : `${h}h`;
        cdSub  = m ? (t('cd_min') || 'min') : (t('cd_hr') || 'hr');
      }
    }
  }
  const cdBlock = cdMain
    ? `<div class="jcard-cd${hasDeparted || _journeyDone ? ' is-past' : ''}" style="background:${_cdCol.bg};color:${_cdCol.fg}">
         <span class="jcd-main">${cdMain}</span>${cdSub ? `<span class="jcd-sub">${cdSub}</span>` : ''}
       </div>`
    : '';

  const xferBadge = xfers > 0
    ? `<span class="jtransfer">${xfers > 1 ? t('changes_badge_pl').replace('{n}', xfers) : t('changes_badge').replace('{n}', xfers)}</span>`
    : '';

  // Count stops from stopSequence to label the expand button. The expanded view
  // shows much more than stops (live position, carriages, occupancy, platforms,
  // alerts) so the label says "details" rather than just "stops".
  const stopCount = legs.filter(l => !isWalkLeg(l))
    .reduce((s, l) => s + (l.stopSequence?.length || 0), 0);
  // The big times are the JOURNEY's ends (legs[0] / last leg) — which may be walks.
  // depPlanned/arrPlanned belong to the first/last TRANSIT legs, so comparing them
  // against the journey ends mixes two different legs: with a 4-min walk to the
  // station, "leave 3:55" vs "train planned 3:59" rendered as "4 minutes early"
  // and struck 3:59 under a card that also said "On time". Compare like with like.
  const _leg0Plan = legs[0]?.origin?.departureTimePlanned || legs[0]?.stopSequence?.[0]?.departureTimePlanned || depPlanned;
  const _legNPlan = legs[legs.length - 1]?.destination?.arrivalTimePlanned
                 || legs[legs.length - 1]?.stopSequence?.at(-1)?.arrivalTimePlanned || arrPlanned;
  const _dep0Delay = delayMins(_leg0Plan, dep);
  const _arrNDelay = delayMins(_legNPlan, arr);

  const depP = fmtParts(dep);
  const arrP = fmtParts(arr);
  const depTimeHtml = `<span class="jtime" ${hasDeparted ? 'style="color:var(--muted)"' : ''}>${depP.time}${depP.ap ? `<span class="ampm">${depP.ap}</span>` : ''}</span>`;
  const arrTimeHtml = `<span class="jtime">${arrP.time}${arrP.ap ? `<span class="ampm">${arrP.ap}</span>` : ''}</span>`;

  const hasPlats = origPlat || destPlat || platAlerts.orig || platAlerts.dest;

  // Board/alight stations, each with its platform directly beneath it — the two
  // facts you act on at each end, kept together instead of split across rows.
  const _platText = p => String(p || '').trim();   // full "Platform 2" / "Stand B"
  const _endCol = (name, plat, right) =>
    `<div class="jstation-col${right ? ' jstation-col-right' : ''}">
       <div class="jstation">${name}</div>
       ${plat ? `<div class="jstation-plat">${_platText(plat)}</div>` : ''}
     </div>`;
  const stationsHtml = (origName || destName)
    ? `<div class="jcard-stations">${_endCol(origName, origPlat, false)}${_endCol(destName, destPlat, true)}</div>`
    : '';
  const platTag = '';   // platforms now live under the station names

  // Status reads as words, not a pill: "On time" / "3 min late" (TripView).
  // ontime_badge ships as "✓ On time" — the tick would sit next to the status dot
  // and say the same thing twice, so strip it and let the dot carry the mark.
  // "On time" only when realtime actually confirms it — otherwise a scheduled-only
  // service (e.g. a /schedule timetable card) reads "On time · No live data", which
  // contradicts itself. Late still shows regardless (it's derived from times).
  const _hasRt = _transitLegs.some(legIsRealtime);
  const _statusTxt = worstDelay > 0
    ? `${worstDelay} ${t('min')} ${t('late_word') || 'late'}`
    : (_hasRt && (depPlanned || arrPlanned)) ? String(t('ontime_badge') || 'On time').replace(/^✓\s*/, '') : '';
  const statusHtml = _statusTxt
    ? `<span class="jstatus ${worstDelay > 0 ? 'is-late' : 'is-ok'}"><span class="jstatus-dot"></span>${_statusTxt}</span>`
    : '';

  return `<div class="jcard ${delayClass}${tracked ? ' jcard-tracked' : ''} fadein" style="${anim}" data-juid="${uid}"
       role="button" tabindex="0" aria-label="${escAttr(t('view_details'))}" onclick="openStopsView('${uid}')">

    <!-- Countdown block (line-coloured) + the rest of the card beside it -->
    <div class="jcard-main">
      ${cdBlock}
      <div class="jcard-body">

        <!-- ① dep ──── duration ──── arr. The duration sits BETWEEN the two times
             it measures, on a connector, so the row reads as one span rather than
             three left-packed items. -->
        <div class="jcard-times">
          <span class="jtime-cell">
            <span class="jtime-top">${depTimeHtml}${delayBadge(_dep0Delay)}</span>
            ${plannedLine(_leg0Plan, dep)}
          </span>
          <span class="jcard-dur">${dur(dep, arr)}</span>
          <span class="jtime-cell jtime-cell-right">
            <span class="jtime-top">${arrTimeHtml}${delayBadge(_arrNDelay)}</span>
            ${plannedLine(_legNPlan, arr)}
          </span>
        </div>

        <!-- ② Endpoints ONLY when they differ from the search the header states -->
        ${stationsHtml}

        <!-- ③ Line badges + transfers + platforms -->
        <div class="jcard-row2">${badges}${xferBadge ? `<span style="margin-left:2px"></span>${xferBadge}` : ''}${platTag}</div>

        <!-- ④ Status in words, then muted seats · accessibility · fare -->
        <div class="jcard-meta-row">${statusHtml}${trackingPill || departedPill || ''}${rtBadge}${seat}${a11y}${fareHtml}
          <span class="jcard-chev" aria-hidden="true">›</span>
        </div>
      </div>
    </div>
  </div>`;
}


// ── Stops view + leg render (moved to src/stops.js) ──────────────────────────

// ── Track a selected service ──────────────────────────────────────────────────
// One service can be "pinned" at a time: it stays on the Journey list and on the
// Home dashboard, auto-refreshing live, even after departure / reload. Trying to
// pin a second one shows a warning (the user must stop the current one first).
export const MAX_TRACKED = 1;
export function isTracked(uid) { return trackState.uids.includes(uid); }
// ── Vehicle positions + badge (moved to src/vehicles.js) ──────────────────────
// ── Hamburger / Bottom Sheet ──────────────────────────────────────────────────
function openSheet() {
  const favCount = getFavJ().length;
  let favLabel;
  if (favCount === 0) favLabel = t('sheet_fav_none');
  else if (favCount === 1) favLabel = t('sheet_fav_one');
  else favLabel = t('sheet_fav_many').replace('{n}', favCount);
  byId('sheet-fav-count').textContent = favLabel;
  byId('sheet-overlay').classList.add('show');
  byId('sheet').style.display = 'block';
  syncLangToggle();
  syncThemeToggle();
  _ovOpen('sheet', _closeSheetDom);
}
function closeSheet() {
  if (_ovDismiss('sheet')) return;
  _closeSheetDom();
}
function _closeSheetDom() {
  byId('sheet-overlay').classList.remove('show');
  byId('sheet').style.display = 'none';
}
function setLang(l) {
  if (i18n.lang === l) return;
  i18n.lang = l;
  _lsSet('nsw_lang', l);
  applyLang();
  syncLangToggle();
}
function syncLangToggle() {
  // Sheet segmented buttons — active = current language
  byId('lang-en')?.classList.toggle('active', i18n.lang === 'en');
  byId('lang-ko')?.classList.toggle('active', i18n.lang === 'ko');
  // Header toggle button — shows the language you'll SWITCH TO
  const hdrBtn = byId('hdr-lang-toggle');
  if (hdrBtn) hdrBtn.textContent = i18n.lang === 'ko' ? 'EN' : '한국어';
}
function clearDataSheet() {
  const favs = getFavJ();
  if (!favs.length) { closeSheet(); return; }
  showConfirm(`${favs.length} saved route${favs.length > 1 ? 's' : ''}`, () => {
    saveFavJ([]);
    renderFavsPage();
    closeSheet();
  });
}

// ════════════════════════════════════════════════════════════════════════════
// THEME  (Light / Dark — Light is the default)
// ════════════════════════════════════════════════════════════════════════════
if (pref.theme !== 'dark') pref.theme = 'light';   // migrate any old 'system' value
function effectiveDark() { return pref.theme === 'dark'; }
function applyTheme() {
  byId('html-root').setAttribute('data-theme', effectiveDark() ? 'dark' : 'light');
  syncThemeToggle();
}
function setTheme(p) { pref.theme = p === 'dark' ? 'dark' : 'light'; _lsSet('nsw_theme', pref.theme); applyTheme(); }
function syncThemeToggle() {
  ['light', 'dark'].forEach(p =>
    byId('theme-' + p)?.classList.toggle('active', pref.theme === p));
}

// ── UI prefs accent/font (moved to src/prefs.js) ─────────────────────────────

// ════════════════════════════════════════════════════════════════════════════
// RECENT JOURNEYS + LANDING DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
export function escAttr(s) { return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

export function getRecents() { return _lsGetJSON('nsw_recent', []); }
function pushRecent(from, to) {
  if (!from?.id || !to?.id) return;
  let r = getRecents().filter(x => !(x.from.id === from.id && x.to.id === to.id));
  r.unshift({ from: { name: from.name, id: from.id }, to: { name: to.name, id: to.id } });
  _lsSet('nsw_recent', JSON.stringify(r.slice(0, 6)));
}
export function greeting() {
  const h = sydParts(new Date()).hour;
  const k = h < 12 ? 'good_morning' : h < 18 ? 'good_afternoon' : 'good_evening';
  return t(k) + ' 👋';
}
// Simple prompt shown on the Journey tab before a search (dashboard now lives on Home)
// Premium skeleton placeholder shown while results load (feels instant)
function skeletonCards(n = 4) {
  // Branded spinner bar (icon only — the Find button already says "Searching…",
  // so no duplicate word) gives the loading area a clearly visible background.
  // No searching panel here — the Find button shows the "Searching…" state.
  let h = '<div class="skel-wrap">';
  for (let i = 0; i < n; i++) {
    h += `<div class="card skel-host">
      <div class="skel-row">
        <div class="skeleton skel-pill"></div>
        <div class="skeleton skel-line w40"></div>
      </div>
      <div class="skeleton skel-line w70"></div>
      <div class="skeleton skel-line w50"></div>
    </div>`;
  }
  return h + '</div>';
}

function renderJourneyEmpty() {
  const el = byId('journey-results');
  if (!el || currentJourneyData) return;
  el.innerHTML = `<div class="empty-state">
    <div class="empty-state-ic">🗺</div>
    <div class="empty-state-title">${t('plan_t')}</div>
    <div class="empty-state-sub">${t('plan_s')}</div></div>`;
}

// ── Tracked service + home auto-refresh (moved to src/tracking.js) ───────────

// ── Manual refresh ─────────────────────────────────────────────────────────
function manualRefreshJourney(btn) {
  if (btn) btn.classList.add('spinning');
  Promise.resolve(fetchJourneys(false)).finally(() => btn && setTimeout(() => btn.classList.remove('spinning'), 500));
}
function manualRefreshDepart(btn) {
  if (btn) btn.classList.add('spinning');
  Promise.resolve(loadDepartures(false)).finally(() => btn && setTimeout(() => btn.classList.remove('spinning'), 500));
}

// ── Init ──────────────────────────────────────────────────────────────────────
export let departAt = null; // null = leave now, or { itdDate:'YYYYMMDD', itdTime:'HHMM' }

function setDepartNow() {
  departAt = null;
  byId('dat-now').classList.add('on');
  byId('dat-at-btn').classList.remove('on');
  byId('dat-inputs').classList.remove('show');
  if (state.from.id && state.to.id) {
    clearInterval(journeyTimer); journeyTimer = null;
    doSearch();
  }
}

function showDepartAt() {
  // Seed with Sydney's current time (rounded up to the next 5 min), so "Depart at"
  // defaults make sense for NSW even when the device is in another timezone.
  const sp = sydParts(new Date());
  let mTot = sp.hour * 60 + sp.minute + 1;
  mTot = Math.ceil(mTot / 5) * 5;
  let dayShift = 0;
  if (mTot >= 1440) { mTot -= 1440; dayShift = 1; }
  const h = Math.floor(mTot / 60), mm = mTot % 60;
  const h12 = h % 12 || 12;
  const mins = String(mm).padStart(2, '0');
  const ampm = h < 12 ? 'AM' : 'PM';
  const pad = n => String(n).padStart(2, '0');
  // Sydney calendar date (+ rollover if rounding pushed us past midnight)
  const base = Date.UTC(sp.year, sp.month - 1, sp.day) + dayShift * 86400000;
  const bd = new Date(base);

  byId('dat-hour').value = String(h12);
  byId('dat-min').value = mins;
  setAmPm(ampm, false);
  byId('dat-date').value =
    `${bd.getUTCFullYear()}-${pad(bd.getUTCMonth()+1)}-${pad(bd.getUTCDate())}`;

  byId('dat-now').classList.remove('on');
  byId('dat-at-btn').classList.add('on');
  byId('dat-inputs').classList.add('show');
  onDepartAtChange();
}

function setAmPm(val, triggerChange = true) {
  byId('dat-am').classList.toggle('active', val === 'AM');
  byId('dat-pm').classList.toggle('active', val === 'PM');
  if (triggerChange) onDepartAtChange();
}

function onDepartAtChange() {
  const hour = parseInt(byId('dat-hour').value, 10);
  const mins = byId('dat-min').value;
  const isAM = byId('dat-am').classList.contains('active');
  const dateVal = byId('dat-date').value;
  if (!dateVal || isNaN(hour)) return;
  // Convert 12-hour to 24-hour
  let h24 = hour;
  if (isAM && hour === 12) h24 = 0;
  if (!isAM && hour !== 12) h24 = hour + 12;
  departAt = {
    itdDate: dateVal.replace(/-/g, ''),
    itdTime: `${String(h24).padStart(2,'0')}${mins}`
  };
  clearInterval(journeyTimer); journeyTimer = null;
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function hideSplash() {
  const s = byId('splash');
  if (!s || s.classList.contains('hide')) return;
  s.classList.add('hide');
  setTimeout(() => s?.parentNode?.removeChild(s), 520);
}
// Keep the splash up long enough (~1.5 s) for the loading bar to visibly crawl
// from 0→100 once (fill animation is 1.4 s), so it reads as real progress.
setTimeout(hideSplash, Math.max(0, 1500 - performance.now()));

// Apply theme + i18n.lang on startup
applyTheme();
applyAccent();
applyFont();
applyLang();
syncLangToggle();
syncTimeFmtToggle();

// Stamp version into both elements from the single constant
document.querySelectorAll('.splash-ver, .sheet-ver-badge').forEach(el => el.textContent = APP_VERSION);

renderFavStopChips();
restoreTracked();   // restore any tracked service before the first home render
renderHome();
startHomeTimer();   // begin live-board auto-refresh on the landing page
renderJourneyEmpty();
renderFavsPage();
updateFab(); // FAB hidden on landing (home page visible, no other pages shown)

// Restore the last departures stop (so the Departures tab is ready), but always
// open the app on Home — the home screen is the default landing.
(function restoreSession() {
  try {
    const savedStop = JSON.parse(_lsGet('nsw_dep_stop', 'null') || 'null');
    if (savedStop && savedStop.id) {
      state.dep = { name: savedStop.name, id: savedStop.id };
      const di = byId('dep-input');
      if (di) { di.value = savedStop.name; di.classList.add('sel'); }
      setClearBtn('dep', true);
    }
  } catch {}
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  let _swRefreshing = false;
  // When the new SW takes control, reload once so the installed app actually runs
  // the freshly-deployed code instead of the cached old shell.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swRefreshing) return;
    _swRefreshing = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      // Detect an updated SW waiting to activate → offer a one-tap refresh.
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            // A new version is ready. Toast → tapping reloads into it.
            showUpdateToast(() => sw.postMessage({ type: 'SKIP_WAITING' }));
          }
        });
      });
    }).catch(err => console.warn('SW:', err));
  });
}
// Lightweight "update available" toast with a Reload action.
function showUpdateToast(onReload) {
  let el = byId('sw-update-toast');
  if (el) return;
  el = document.createElement('div');
  el.id = 'sw-update-toast';
  el.className = 'sw-update-toast';
  el.innerHTML = `<span>${(typeof t === 'function' && t('update_available')) || 'New version available'}</span>
    <button type="button">${(typeof t === 'function' && t('update_reload')) || 'Reload'}</button>`;
  el.querySelector('button').onclick = onReload;
  document.body.appendChild(el);
}

// (window bridge lives near the top of the file — see _installWindowBridge — so it
//  runs even if the bottom-of-file DOM init throws under a test/stub environment.)
