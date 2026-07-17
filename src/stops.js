// Stops View: the show-stops overlay (per-leg full stop lists), back-button /
// gesture navigation, toast, journey-card swipe-to-track, summary header, skeleton,
// and the full multi-leg + single-leg renderers. Imports primitives from
// core/i18n/line_colors and cross-feature runtime fns from the app entry.
import { byId, esc, safeUrl, PROXY, MOT_ICONS, REFRESH_MS, _evIsRealtime,
         state, jr, depState, trackState, homeState, svState, pref, nearbyState, navState, _lsGet } from "./core.js";
import { t, i18n } from "./i18n.js";
import { getLineColors } from "./line_colors.js";
import { toast, stopTimeline } from "./components.js";
import { _buildFormationFull, _vpModesFor, loadVehiclePos } from "./vehicles.js";
import { renderHome } from "./tracking.js";
import { removeTracked, toggleTracked } from "./tracking.js";
import {
  _vpByRouteName, _vpByTripId, _vpEpochSum, _vpTripId, cleanStationName, delayBadge, delayMins,
  estArr, estDep, fmt, haptic, isTracked, isWalkLeg, legDestPlat, legOriginPlat, plannedLine,
  platLabel, rerenderJourneys, sydParts, timedFetch,
} from "../app.js";
// ── Stops View ───────────────────────────────────────────────────────────────
export const VEHICLE_ICON = {1:'🚆',2:'🚇',4:'🚊',5:'🚌',7:'🚎',9:'⛴',11:'🚐'};
// svState.uid = which service's stops are currently OPEN in the overlay.
// trackState.uids (declared elsewhere) = which service is PINNED/tracked on the card.
// These are deliberately separate: opening another card's stops must NOT cancel a
// pin you set earlier. Only the explicit "Track" button changes trackState.uids.
// Per-transit-leg full stops: array of { stops: null|[], loading: bool }

// ── Back-button / gesture navigation ─────────────────────────────────────────
// Android's hardware Back (and the browser/edge-swipe back) fire `popstate`.
// Without a history entry to consume, that Back exits the PWA. We push a state
// whenever an overlay opens and close the top overlay on Back instead of leaving.
export function _ovOpen(key, close) {
  if (navState.ovStack.some(o => o.key === key)) return;     // already open
  navState.ovStack.push({ key, close });
  try { history.pushState({ ov: key }, ''); } catch {}
}
// Count of programmatic history rewinds whose resulting popstate we must ignore.
// A multi-step `history.go(-N)` emits only ONE popstate, so we close overlays here
// directly and suppress that single event (rather than letting popstate close one).
let _suppressPop = 0;
// UI-initiated close: close this overlay AND any stacked above it (e.g. an expanded
// leg on top of the stops sheet), then rewind history so Android Back stays in sync.
// Returns false if the overlay isn't tracked (caller should close directly).
export function _ovDismiss(key) {
  const idx = navState.ovStack.findIndex(o => o.key === key);
  if (idx === -1) return false;
  const steps = navState.ovStack.length - idx;              // this + everything above it
  for (let i = navState.ovStack.length - 1; i >= idx; i--) {
    const o = navState.ovStack.pop();                       // top-down: leg before stops
    try { o.close(); } catch {}
  }
  _suppressPop += 1;                                         // the go(-steps) fires 1 popstate
  try { history.go(-steps); } catch {}
  return true;
}
window.addEventListener('popstate', () => {
  if (_suppressPop > 0) { _suppressPop -= 1; return; }       // our own rewind — already closed
  const top = navState.ovStack.pop();                        // hardware/edge Back → close top
  if (top) { try { top.close(); } catch {} }
});

// Left-edge swipe-back gesture (iOS/Android style). A short swipe rightward that
// STARTS at the very left edge pops the top overlay/route via history.back(). Only
// fires when there's something to pop, so it never exits the app from Home. Skips
// the stops sheet, which has its own full-width swipe-to-dismiss.
(function edgeSwipeBack() {
  let sx = 0, sy = 0, active = false;
  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { active = false; return; }
    const x = e.touches[0].clientX;
    active = x <= 24 && !e.target.closest('.stops-view, .sheet, input, textarea');
    sx = x; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!active) return;
    active = false;
    const tch = e.changedTouches[0];
    if (tch.clientX - sx > 70 && Math.abs(tch.clientY - sy) < 50 && navState.ovStack.length) {
      history.back();
    }
  }, { passive: true });
})();

// Swipe-right-to-dismiss on the details sheet (mirrors its slide-in direction).
(function setupSheetSwipe() {
  const view = byId('stops-view');
  if (!view) return;
  let sx = 0, sy = 0, dx = 0, dragging = false;
  view.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { dragging = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; dragging = false;
  }, { passive: true });
  view.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    const ax = Math.abs(x - sx), ay = Math.abs(y - sy);
    if (!dragging) {
      if (ax < 12 || ax < ay * 1.3) return;   // ignore until clearly horizontal
      dragging = true;
    }
    dx = Math.max(0, x - sx);                  // rightward only
    view.style.transition = 'none';
    view.style.transform = `translateX(calc(-50% + ${dx}px))`;
    view.style.opacity = String(Math.max(0.4, 1 - dx / 500));
  }, { passive: true });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    view.style.transition = '';
    view.style.transform = '';
    view.style.opacity = '';
    if (dx > 90) closeStopsView();
    dx = 0;
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
})();

export function openStopsView(uid) {
  const data = svState.stops.get(uid);
  if (!data) return;
  haptic([5]);
  svState.uid = uid;
  svState.open = true;
  svState.legsFullStops = [];
  svState.scrolledToBoard = false;   // re-scroll to the boarding stop for this open
  svState.expandedLegs.clear();      // every journey starts collapsed to the ridden segment
  svState.autoLeg = null;

  const view  = byId('stops-view');
  const title = byId('stops-view-title');
  const track = byId('stops-view-track');
  const body  = byId('stops-view-body');

  // Build header badges for all transit legs
  const transitLegs = data.legs.filter(l => !isWalkLeg(l));
  title.innerHTML = transitLegs.map(leg => {
    const mot = leg.transportation?.product?.class || 0;
    const nm  = leg.transportation?.disassembledName || leg.transportation?.number || '';
    const { bg, fg } = getLineColors(mot, nm);
    return nm ? `<span class="sv-badge" style="background:${bg};color:${fg}">${nm}</span>` : '';
  }).filter(Boolean).join('<span class="sv-badge-arr">›</span>') ||
    `<span class="sv-headsign">${data.origName} → ${data.destName}</span>`;

  _renderSvTrack(track, uid);

  // Show skeleton immediately with known leg stops
  body.innerHTML = _buildSvSkeleton(data);
  body.scrollTop = 0;            // always open at the top, not a stale scroll pos
  view.style.display = 'flex';
  requestAnimationFrame(() => {
    view.classList.remove('sv-hidden');
    body.scrollTop = 0;         // re-assert after layout/show (pre-show reset can be ignored)
  });
  document.body.style.overflow = 'hidden';
  _ovOpen('stops', _closeStopsViewDom);   // hardware Back closes the sheet

  // Fetch vehicle positions for every transit leg mode in parallel — this
  // populates _vpCache so the stop timeline can show live vehicle position
  // markers (including before the boarding stop).
  const modesNeeded = [...new Set(
    transitLegs.flatMap(l => _vpModesFor(l.transportation?.product?.class))
  )];
  Promise.all(modesNeeded.map(mode =>
    loadVehiclePos(mode).catch(() => null)
  )).then(() => {
    // Re-render once VP data is loaded so vehicle markers appear
    if (svState.open && svState.uid === uid) {
      body.innerHTML = _buildAllLegsHtml(data, svState.legsFullStops);
    }
  });

  // Accordion: legs start collapsed, so don't download every leg's GTFS up front.
  // Each leg's full stop list is fetched lazily the first time it's expanded
  // (_svToggleLeg). Initialise the per-leg slots so the buttons render immediately.
  svState.legsFullStops = transitLegs.map(() => ({ stops: null, loading: false }));

  // Keep live data fresh while the view is open: reload vehicle positions and
  // re-render every 20 s, so carriage occupancy colours, crowding and the position
  // marker update on their own — independent of the journey tab's refresh timer
  // (this is what makes it work when opened from Favourites or a timetable search).
  clearInterval(svState.refreshTimer);
  svState.refreshTimer = setInterval(() => {
    if (!svState.open || svState.uid !== uid) { clearInterval(svState.refreshTimer); svState.refreshTimer = null; return; }
    if (document.hidden) return;   // don't fetch/render a backgrounded view
    const before = _vpEpochSum();
    Promise.all(modesNeeded.map(mode => loadVehiclePos(mode).catch(() => null)))
      .then(() => {
        if (!(svState.open && svState.uid === uid)) return;
        const after = _vpEpochSum();
        if (after !== before) refreshStopsView();   // only rebuild when VP actually changed
      });
  }, 20000);

  // ONE transit leg → there is no choice to present, so the leg list is a single
  // card you must tap to get where you were always going. Open its stops straight
  // away (auto: no history entry, so Back leaves the view rather than revealing a
  // one-item list).
  const _transitIdxs = data.legs.map((l, i) => (isWalkLeg(l) ? -1 : i)).filter(i => i >= 0);
  if (_transitIdxs.length === 1) {
    const k = String(_transitIdxs[0]);
    svState.autoLeg = k;
    _svToggleLeg(k, { auto: true });
  }
}

export function _renderSvTrack(el, uid) {
  // "Track" pins a journey on the live Journey tab so it stays on screen and keeps
  // auto-refreshing. That only applies to main-list journeys (ids like "j2025…").
  // Favourite-card stops views (ids like "fv-0-0") live in a separate panel that
  // already auto-refreshes, so we show just the live indicator with no pin button.
  const pinnable = !uid.startsWith('fv-');
  const isT = pinnable && isTracked(uid);
  el.innerHTML = `<span class="sv-dot"></span> Live${pinnable ? `
    <button class="sv-track-btn${isT ? ' sv-track-on' : ''}" onclick="toggleSvTrack('${uid}')">
      ${isT ? '📍 Tracking' : '📍 Track'}
    </button>` : ''}`;
}

export function toggleSvTrack(uid) {
  if (uid.startsWith('fv-')) return;   // not pinnable (see _renderSvTrack)
  const res = toggleTracked(uid);      // 'added' | 'removed' | 'full' | 'nodata'
  if (res === 'full') { showToast(t('track_full')); return; }
  if (res !== 'added' && res !== 'removed') return;   // 'nodata' (shouldn't happen here)
  haptic([8]);
  showToast(res === 'added' ? '📍 ' + t('track_started') : t('track_stopped'));
  const track = byId('stops-view-track');
  if (track) _renderSvTrack(track, uid);
  rerenderJourneys();
  if (byId('page-home')?.style.display !== 'none') renderHome();
}

// Fetch full stops for every transit leg in parallel, re-rendering as each completes
export async function _fetchAllLegsFullStops(data, uid) {
  const transitLegs = data.legs.filter(l => !isWalkLeg(l));
  svState.legsFullStops = transitLegs.map(() => ({ stops: null, loading: true }));

  await Promise.all(transitLegs.map(async (leg, idx) => {
    const stops = await _fetchOneLegFullStops(leg);
    svState.legsFullStops[idx] = { stops, loading: false };
    if (svState.open && svState.uid === uid) {
      const body = byId('stops-view-body');
      if (body) body.innerHTML = _buildAllLegsHtml(data, svState.legsFullStops);
    }
  }));

  // Once the full (terminus-to-terminus) lists are in, scroll so the BOARDING
  // stop sits at the top of the list — before-boarding stops are then just a
  // scroll-up away. Done once per open so refreshes don't yank the user around.
  if (svState.open && svState.uid === uid && !svState.scrolledToBoard) {
    svState.scrolledToBoard = true;
    requestAnimationFrame(() => _svScrollToBoard());
  }
}

// Per-leg "show full service" expansion. Collapsed (default) = ridden segment only
// (board → alight); expanded = entire terminus-to-terminus list. Keyed by leg index,
// cleared on each open so every journey starts collapsed.
// Header Back = go back ONE step, not "leave". The button used to be labelled
// "Home" and wired straight to closeStopsView(), so relabelling it Back left it
// still exiting the whole view from inside an expanded leg.
export function _svBack() {
  const open = [...svState.expandedLegs][0];
  // Single-leg journey: the leg WAS the whole view, so Back leaves outright.
  if (open != null && svState.autoLeg == null) { _svToggleLeg(open); return; }
  closeStopsView();
}

// Reveal / re-hide the stops outside the ridden segment for one leg.
export function _svToggleAllStops(key) {
  if (svState.allStops.has(key)) svState.allStops.delete(key);
  else svState.allStops.add(key);
  haptic([4]);
  refreshStopsView();
}

export async function _svToggleLeg(key, opts = {}) {
  // Collapsing: route through history so hardware Back / edge-swipe stay in sync.
  if (svState.expandedLegs.has(key)) {
    if (!_ovDismiss('leg')) _svCollapseLeg(key);   // fallback: direct collapse
    return;
  }
  // Expanding "View stops" opens a FOCUSED single-leg stops screen (only this leg),
  // and pushes a history entry so Back / left-edge-swipe returns to the leg list.
  svState.expandedLegs.clear();                          // one leg at a time (focus mode)
  svState.expandedLegs.add(key);
  haptic([4]);
  refreshStopsView();
  const _body0 = byId('stops-view-body');
  if (_body0) _body0.scrollTop = 0;                 // the focused screen opens at the top
  // Auto-expanded single-leg journeys push NO history entry: there is no leg list
  // worth returning to, so Back should leave the stops view entirely.
  if (!opts.auto) _ovOpen('leg', () => _svCollapseLeg(key));

  // Lazy-load this leg's full stop list on first expand (keeps initial open fast —
  // we don't download every leg's GTFS up front).
  const data = svState.stops.get(svState.uid);
  if (!data) return;
  const legIdx = +key;
  const leg = data.legs[legIdx];
  if (!leg || isWalkLeg(leg)) return;
  let transitIdx = 0;
  for (let i = 0; i < legIdx; i++) if (!isWalkLeg(data.legs[i])) transitIdx++;
  const cur = svState.legsFullStops[transitIdx];
  if (cur && cur.stops && cur.stops.length) {
    requestAnimationFrame(() => _svScrollToLegBoard(key));   // already loaded
    return;
  }

  svState.legsFullStops[transitIdx] = { stops: null, loading: true };
  refreshStopsView();
  let stops = await _fetchOneLegFullStops(leg);
  // Retry once on total failure — the Render proxy free-tier sleeps and the first
  // request after wake can time out, which would otherwise leave us on the planner's
  // ridden-segment list (no before-boarding / after-alighting stops).
  if (!stops && svState.open) {
    await new Promise(r => setTimeout(r, 1500));
    stops = await _fetchOneLegFullStops(leg);
  }
  svState.legsFullStops[transitIdx] = { stops, loading: false };
  if (svState.open) { refreshStopsView(); requestAnimationFrame(() => _svScrollToLegBoard(key)); }
}

// Actual collapse — run by Back/edge-swipe (popstate → _ovOpen close fn) or the
// "Back" chip via _ovDismiss. Returns to the leg-list overview and scrolls the
// leg's header into view so the user lands where they came from.
export function _svCollapseLeg(key) {
  if (!svState.expandedLegs.has(key)) return;
  svState.expandedLegs.delete(key);
  refreshStopsView();
  requestAnimationFrame(() => {
    const scroller = byId('stops-view-body');
    const head = scroller?.querySelector(`[data-leghead="${key}"]`);
    if (scroller && head) {
      const delta = head.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
      if (Math.abs(delta) > 4) {
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
      }
    }
  });
}

// Scroll the expanded leg so its BOARDING stop sits just under the sticky header —
// the before-boarding stops (where the service currently is) are then a scroll up.
export function _svScrollToLegBoard(key) {
  const scroller = byId('stops-view-body');   // the scroll container
  if (!scroller) return;
  // Wait for layout to settle (lazy render just swapped innerHTML) before measuring.
  requestAnimationFrame(() => {
    const board = scroller.querySelector(`[data-stop-anchor="${key}"]`);
    if (!board) return;
    const head  = scroller.querySelector(`[data-leghead="${key}"]`);
    const headH = head ? head.getBoundingClientRect().height : 96;
    // Rect-based delta is robust regardless of offsetParent / sticky positioning:
    // move the board to just below the sticky leg header.
    const delta = (board.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - headH - 12;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollBy({ top: delta, behavior: reduce ? 'auto' : 'smooth' });
  });
}

export function _svScrollToBoard() {
  const body = byId('stops-view-body');
  if (!body) return;
  const scrollEl = body.closest('.stops-view-scroll') || body;
  const board = body.querySelector('.c-tl__item--board');
  if (!board) return;
  // Position the boarding stop just below any sticky header, leaving the
  // before-boarding stops scrolled off the top (reachable by scrolling up).
  const top = board.offsetTop - (scrollEl.querySelector('.sv-service-hdr')?.offsetHeight || 0) - 8;
  scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// Map MOT class to GTFS schedule mode slug (for /gtfstrip). Mirrors the proxy's
// _GTFS_SCHED keys. Class 1 = Sydney Trains ('trains'); intercity (also class 1)
// won't be found in that schedule and falls back to the departure monitor.
export const MOT_TO_GTFS_MODE = { 1:'trains', 2:'metro', 4:'lightrail', 5:'buses', 7:'regionbuses', 9:'ferries', 11:'regionbuses' };

export async function _fetchOneLegFullStops(leg) {
  const mot     = leg.transportation?.product?.class || 0;
  const lineNum = leg.transportation?.disassembledName || leg.transportation?.number || '';
  const stopId  = leg.stopSequence?.[0]?.properties?.stopId
               || leg.stopSequence?.[0]?.id
               || leg.origin?.properties?.stopId
               || leg.origin?.id || '';
  const depTime = leg.origin?.departureTimePlanned
               || leg.stopSequence?.[0]?.departureTimePlanned
               || leg.origin?.departureTimeEstimated || '';

  // Try GTFS static schedule first (terminus-to-terminus stop list).
  // The first call downloads a 30-80 MB GTFS zip; give it 75 s so it doesn't
  // time out before the server finishes. Subsequent calls hit the 5-min zip
  // cache and respond in seconds.
  // Use the SAME id resolution as live-vehicle matching (_vpTripId): the GTFS
  // static trip_id == GTFS-realtime trip_id == RealtimeTripId. The planner's
  // `tripCode` is a different id system and won't match the schedule, so
  // preferring it here made /gtfstrip return [] and we silently fell back to the
  // departure-monitor list (boarding→terminus only, no before-boarding stops).
  const tripId = _vpTripId(leg);
  // Class-1 trains split across two GTFS feeds: suburban (sydneytrains='trains')
  // and intercity/regional NSW TrainLink ('nswtrains'). Try suburban first, then
  // nswtrains so Blue Mountains / Central Coast / South Coast / regional trains
  // also get the full before-boarding stop list.
  const gmodes = mot === 1 ? ['trains', 'nswtrains'] : (MOT_TO_GTFS_MODE[mot] ? [MOT_TO_GTFS_MODE[mot]] : []);
  if (tripId && gmodes.length) {
    for (const gmode of gmodes) {
      try {
        const p = new URLSearchParams({ trip_id: tripId, mode: gmode });
        const r = await timedFetch(PROXY + '/gtfstrip?' + p, 75000);
        if (r.ok) {
          const json = await r.json();
          if (json.stops?.length) {
            // Merge GTFS-RT TripUpdates so EVERY stop (incl. before-boarding) shows
            // its realtime delay/early, not just the boarding→alight portion the
            // trip planner returns. Static schedule alone has no realtime.
            await _mergeTripUpdates(json.stops, tripId, gmode);
            return json.stops;
          }
        }
      } catch { /* try next feed / fall through */ }
    }
  }

  // Fallback: departure monitor (boarding stop → terminus, 20 s)
  if (!lineNum) return null;
  // Use the numeric stop ID (properties.stopId) for the departure monitor;
  // fall back to the global ID or station name if not available.
  const stopParam = stopId || cleanStationName(leg.origin?.name || '');
  if (!stopParam) return null;
  try {
    const p = new URLSearchParams({ stop: stopParam, line: lineNum });
    if (depTime) p.set('dep', depTime);
    const r = await timedFetch(PROXY + '/fulltrip?' + p, 20000);
    if (!r.ok) throw new Error('bad');
    const json = await r.json();
    return json.stops?.length ? json.stops : null;
  } catch { return null; }
}

// Fetch GTFS-RT TripUpdates for this trip and annotate each stop in-place with a
// realtime delay (minutes; +late / -early), an estimated time, and a skipped flag.
// Best-effort: any failure leaves the scheduled times untouched.
// Shift a scheduled time by `sec` seconds (delay>0 = later, <0 = earlier),
// preserving its format: bare "HH:MM:SS" GTFS times stay HMS (reusing the same
// _hmsParts/fmt pipeline as planned times → no timezone drift), ISO stays ISO.
export function _applyDelay(base, sec) {
  if (!base || sec == null) return null;
  const isHms = base.indexOf('T') === -1 && base.length <= 8 && base.indexOf(':') > -1;
  if (isHms) {
    const p = base.split(':').map(n => parseInt(n, 10) || 0);
    let s = p[0] * 3600 + p[1] * 60 + (p[2] || 0) + sec;
    s = ((s % 86400) + 86400) % 86400;   // wrap day (display only)
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }
  const d = new Date(base);
  return isNaN(d) ? null : new Date(d.getTime() + sec * 1000).toISOString();
}

export async function _mergeTripUpdates(stops, tripId, gmode) {
  try {
    const p = new URLSearchParams({ trip_id: tripId, mode: gmode });
    const r = await timedFetch(PROXY + '/tripupdates?' + p, 12000);
    if (!r.ok) return;
    const upd = (await r.json()).stops || {};
    if (!upd || !Object.keys(upd).length) return;
    stops.forEach((s, i) => {
      // Match by GTFS stop_id first, then by stop_sequence fallback ("seq:N").
      const rec = upd[s.stopId] || upd['seq:' + (s.seq ?? i + 1)];
      if (!rec) return;
      if (rec.skipped) { s.skipped = true; return; }
      // Prefer absolute realtime times (epoch s) → exact ETA; else apply the delay
      // to the scheduled time for display.
      if (rec.depTime) s.depEst = new Date(rec.depTime * 1000).toISOString();
      if (rec.arrTime) s.arrEst = new Date(rec.arrTime * 1000).toISOString();
      const dDel = (rec.depDelay != null) ? rec.depDelay : null;
      const aDel = (rec.arrDelay != null) ? rec.arrDelay : null;
      const sec  = (dDel != null) ? dDel : (aDel != null) ? aDel : null;
      if (sec != null) s._delayMin = Math.round(sec / 60);
      // When the feed gives only a delay (no absolute time), apply it to the
      // scheduled time so the SHOWN time moves early/late too — not just a badge.
      if (!rec.depTime && s.depPlan && (dDel ?? sec) != null) s.depEst = _applyDelay(s.depPlan, dDel ?? sec);
      if (!rec.arrTime && s.arrPlan && (aDel ?? sec) != null) s.arrEst = _applyDelay(s.arrPlan, aDel ?? sec);
    });
  } catch { /* keep scheduled times */ }
}

export function closeStopsView() {
  // Route through history so Android Back and the in-app Back button agree.
  if (_ovDismiss('stops')) return;
  _closeStopsViewDom();
}
export function _closeStopsViewDom() {
  const view = byId('stops-view');
  // Closing the overlay never cancels a pin — only the Track button does that.
  svState.open = false;
  svState.uid = null;
  svState.legsFullStops = [];
  svState.expandedLegs.clear();
  svState.autoLeg = null;
  // Drop any of our overlay entries not already popped via history (defensive,
  // e.g. a direct swipe-dismiss) so the back stack stays consistent.
  for (let i = navState.ovStack.length - 1; i >= 0; i--)
    if (navState.ovStack[i].key === 'leg' || navState.ovStack[i].key === 'stops') navState.ovStack.splice(i, 1);
  clearInterval(svState.refreshTimer); svState.refreshTimer = null;
  view.classList.add('sv-hidden');
  setTimeout(() => { view.style.display = 'none'; }, 300);
  document.body.style.overflow = '';
  rerenderJourneys();
}

export function refreshStopsView() {
  if (!svState.open || !svState.uid) return;
  // No point rebuilding a 30-stop DOM while the tab is backgrounded — defer to the
  // next visibility gain so the 20 s timer doesn't burn CPU off-screen.
  if (document.hidden) { svState.refreshPending = true; return; }
  svState.refreshPending = false;
  const data = svState.stops.get(svState.uid);
  if (!data) return;
  const body = byId('stops-view-body');
  if (!body) return;
  // Preserve scroll position — a background refresh shouldn't yank the user back
  // to the top of the stop list while they're reading it.
  const scrollEl = body.closest('.stops-view-scroll') || body;
  const prevTop = scrollEl.scrollTop;
  body.innerHTML = _buildAllLegsHtml(data, svState.legsFullStops);
  scrollEl.scrollTop = prevTop;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && svState.refreshPending) refreshStopsView();
});

export function _svRetryFullStops() {
  if (!svState.uid) return;
  const data = svState.stops.get(svState.uid);
  if (!data) return;
  svState.legsFullStops = data.legs.filter(l => !isWalkLeg(l)).map(() => ({ stops: null, loading: true }));
  const body = byId('stops-view-body');
  if (body) body.innerHTML = _buildSvSkeleton(data);
  _fetchAllLegsFullStops(data, svState.uid);
}

// ── Toast ─────────────────────────────────────────────────────────────────────
export let _toastTimer = null;
export function showToast(msg) {
  // Route through the accessible component toast (role=status + aria-live) — same
  // call signature, so every existing caller is unchanged. Longer messages read as
  // warnings and get more time.
  toast(msg, { type: 'info', duration: msg.length > 40 ? 3200 : 1800 });
}

// ── Swipe a journey card: RIGHT → start tracking, LEFT → stop tracking ─────────
(function initSwipeTrack() {
  let card = null, x0 = 0, y0 = 0, axis = null, moved = false, suppressClick = false;
  const THRESH = 64;

  // Swallow the click that a committed/aborted swipe would otherwise fire (which
  // would wrongly open the details view).
  document.addEventListener('click', e => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);

  const clear = animate => {
    if (card) {
      if (animate) card.style.transition = 'transform .2s ease';
      card.style.transform = '';
      card.classList.remove('swipe-track', 'swipe-untrack');
    }
    card = null; axis = null; moved = false;
  };

  document.addEventListener('touchstart', e => {
    const c = e.target.closest('#journey-results .jcard[data-juid]');
    if (!c || c.dataset.juid.startsWith('fv-')) { card = null; return; }
    card = c; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; axis = null; moved = false;
    card.style.transition = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!card) return;
    const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
    if (axis === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') { card = null; return; }   // vertical scroll — let it be
    }
    moved = true;
    const tracked = card.classList.contains('jcard-tracked');
    // Resist the "no-op" direction so the affordance reads clearly.
    let shown = dx;
    if (dx > 0 && tracked)  shown = dx * 0.2;
    if (dx < 0 && !tracked) shown = dx * 0.2;
    card.style.transform = `translateX(${Math.max(-120, Math.min(120, shown))}px)`;
    const willTrack   = dx >  THRESH && !tracked;
    const willUntrack = dx < -THRESH &&  tracked;
    card.classList.toggle('swipe-track',   willTrack);
    card.classList.toggle('swipe-untrack', willUntrack);
    // Label the action so the gesture reads clearly while dragging.
    if (willTrack)        card.dataset.swipeHint = '📍 ' + t('track_started');
    else if (willUntrack) card.dataset.swipeHint = '✕ ' + t('track_stopped');
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!card) return;
    const doTrack   = card.classList.contains('swipe-track');
    const doUntrack = card.classList.contains('swipe-untrack');
    const uid = card.dataset.juid;
    if (moved) suppressClick = true;
    clear(true);
    if (doTrack) {
      const res = toggleTracked(uid);
      if (res === 'full') { showToast(t('track_full')); return; }
      if (res !== 'added') return;
      haptic([12]); showToast('📍 ' + t('track_started'));
      rerenderJourneys();
    } else if (doUntrack) {
      removeTracked(uid); haptic([8]); showToast(t('track_stopped'));
      rerenderJourneys();
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => clear(true), { passive: true });
})();

// ── Summary header — the journey at a glance, pinned at the top of show-stops ──
export function _buildSvSummary(data) {
  // Removed: the journey card the user tapped already shows route + times, and
  // the overlay's back-bar gives context — a header here was a duplicate card.
  return '';
}
// Walk row for the details view — shows duration AND where you're walking to,
// so a leg like the final wharf→destination walk isn't just a bare "Walk 20 min".
export function _walkRow(leg) {
  const m = Math.round((leg.duration || 0) / 60);
  const to = leg.destination?.disassembledName || leg.destination?.name
          || leg.stopSequence?.at(-1)?.disassembledName || '';
  const toTxt = to ? ` <span class="sv-walk-to">→ ${to}</span>` : '';
  return `<div class="sv-walk-row">🚶 ${t('walk_label')} ${m} ${t('min')}${toTxt}</div>`;
}

// ── Skeleton: show known leg stops while API fetches are in flight ────────────
export function _buildSvSkeleton(data) {
  let html = _buildSvSummary(data);
  let transitIdx = 0;
  data.legs.forEach((leg, li) => {
    if (isWalkLeg(leg)) {
      // A walk feeding into a later transit leg is shown inside that leg's
      // "Change at" banner — only the leading/trailing walk gets its own row.
      if (_walkAbsorbed(data.legs, li, transitIdx)) return;
      html += _walkRow(leg);
      return;
    }
    html += _buildLegSection(leg, li, null, true, data.legs);
    transitIdx++;
  });
  return html;
}

// True when this walk leg is a mid-journey transfer walk (a transit leg already
// ran before it AND a transit leg follows) — it's rendered in the next leg's
// change banner, so showing a separate walk row would duplicate it.
export function _walkAbsorbed(legs, li, transitIdx) {
  if (transitIdx === 0) return false;            // leading walk → own row
  const next = legs[li + 1];
  return !!next && !isWalkLeg(next);             // followed by transit → absorbed
}

// ── Full multi-leg render ─────────────────────────────────────────────────────
export function _buildAllLegsHtml(data, legsFullStops) {
  let transitIdx = 0;
  const transitCount = data.legs.reduce((n, l) => n + (isWalkLeg(l) ? 0 : 1), 0);
  // Focused stops screen: when a leg is expanded, render ONLY that leg (its slim
  // header + full stop list) — a dedicated "tab", not an accordion buried in the
  // list. Back / the header's Back chip returns to the overview.
  if (svState.expandedLegs.size) {
    const fKey = [...svState.expandedLegs][0];
    const fIdx = +fKey;
    const fLeg = data.legs[fIdx];
    if (fLeg && !isWalkLeg(fLeg)) {
      let tIdx = 0;
      for (let i = 0; i < fIdx; i++) if (!isWalkLeg(data.legs[i])) tIdx++;
      const fEntry = legsFullStops[tIdx] || { stops: null, loading: false };
      return _buildLegSection(fLeg, fIdx, fEntry, !!fEntry.loading, data.legs, true);
    }
  }
  let html = _buildSvSummary(data);
  data.legs.forEach((leg, li) => {
    if (isWalkLeg(leg)) {
      if (_walkAbsorbed(data.legs, li, transitIdx)) return;   // shown in change banner
      html += _walkRow(leg);
      return;
    }
    const entry  = legsFullStops[transitIdx] || { stops: null, loading: false };
    const isLast = transitIdx === transitCount - 1;
    html += _buildLegSection(leg, li, entry, !!entry.loading, data.legs);
    transitIdx++;
  });
  return html;
}

// ── Render a single transit leg as a section ─────────────────────────────────
export function _buildLegSection(leg, legIdx, entry, loading, allLegs, focusMode = false) {
  const mot   = leg.transportation?.product?.class || 0;
  const nm    = leg.transportation?.disassembledName || leg.transportation?.number || '';
  const { bg, fg } = getLineColors(mot, nm);
  const vIcon = VEHICLE_ICON[mot] || '🚌';
  const headsign = leg.transportation?.destination?.name
    ? cleanStationName(leg.transportation.destination.name) : '';

  // Determine from/to station names for this leg
  const fromName = cleanStationName(leg.origin?.name || '');
  const toName   = cleanStationName(leg.destination?.name || '');

  // Find if a PRECEDING leg exists (for change banner)
  const prevLeg = legIdx > 0 ? allLegs[legIdx - 1] : null;
  const prevTransit = prevLeg && !isWalkLeg(prevLeg) ? prevLeg : null;
  const walkBefore  = prevLeg && isWalkLeg(prevLeg) ? prevLeg : null;

  let html = '';

  // Change/transfer banner before this leg (if not the first transit leg).
  // Compact, high-contrast row that doubles as the visual break between legs.
  // Suppressed on the FIRST transit leg: a leading walk isn't a "change" — you
  // started there. The leg button already shows board/departs.
  const isFirstTransit = allLegs.slice(0, legIdx).every(isWalkLeg);
  // In the focused single-leg screen the change banner is redundant (you navigated
  // here on purpose) and its non-sticky block scrolls oddly above the sticky header.
  if (!focusMode && !isFirstTransit && (prevTransit || walkBefore)) {
    const changeAt = fromName;
    const boardPlat = legOriginPlat(leg, mot);
    const depT = estDep(leg);
    const walkM = walkBefore ? Math.round((walkBefore.duration || 0) / 60) : 0;
    // Where you walk TO = the stop you board next (more specific than the
    // station name in the head — includes the stand/platform side).
    const walkTo = walkBefore
      ? (walkBefore.destination?.disassembledName || walkBefore.destination?.name
         || leg.stopSequence?.[0]?.disassembledName || leg.origin?.disassembledName || '')
      : '';
    // The transfer walk gets its own readable line ("8 min walk to …") so it's
    // clear where to go; board platform + departure stay as compact pills.
    const walkLine = walkM > 0
      ? `<div class="sv-change-walk">🚶 ${walkM} ${t('min')} ${t('walk_label').toLowerCase()}${walkTo ? ` ${t('to') || 'to'} <b>${walkTo}</b>` : ''}</div>`
      : '';
    const acts = [
      boardPlat ? `<span class="sv-change-act"><span class="sv-change-k">Board</span><b>${boardPlat}</b></span>` : '',
      depT      ? `<span class="sv-change-act"><span class="sv-change-k">Departs</span><b>${fmt(depT)}</b></span>` : '',
    ].filter(Boolean).join('');
    // Clickable — tapping the change expands the leg you transfer onto.
    html += `<div class="sv-change sv-change-click" onclick="_svToggleLeg('${String(legIdx)}')" role="button" tabindex="0">
      <div class="sv-change-head"><span class="sv-change-ic">⇄</span>${t('change_at') || 'Change at'} <b>${changeAt}</b></div>
      ${walkLine}
      ${acts ? `<div class="sv-change-acts">${acts}</div>` : ''}
    </div>`;
  }

  // Match a live vehicle: exact GTFS-RT trip_id first, then route name.
  const _vByT = _vpByTripId(_vpTripId(leg), mot);
  const _vByR = !_vByT ? _vpByRouteName(nm, mot) : null;
  const liveVehicle = _vByT || _vByR || null;
  // Opt-in VP match logging: run `localStorage.nsw_vpdebug = 1` in the console to
  // re-enable the [VP] trace; off by default so production isn't spammed.
  if (nm && _lsGet('nsw_vpdebug', '')) console.debug(`[VP] ${nm} → trip:${!!_vByT} route:${!!_vByR}`, liveVehicle ? `✓ ${liveVehicle.route_id || '?'}` : '✗ no match');

  // Live vehicle facts, ordered by what a rider acts on: crowding → access →
  // comfort → formation → model. Rendered as ONE muted line, not a row of pills,
  // so none of it competes with the leg's destination and times. Colour is spent
  // only on exceptions (crowding, prior trip).
  const featureChips = [];
  // Live occupancy (works for ferry / light rail / bus when the feed provides it)
  if (liveVehicle?.occ) {
    const _OCC_CHIP = {
      empty:    ['🟢', t('occ_seats'), ''], many: ['🟢', t('occ_seats'), ''],
      few:      ['🟡', t('occ_few'), ''],   standing: ['🟡', t('occ_standing'), 'svm-warn'],
      crowded:  ['🔴', t('occ_crowded'), 'svm-bad'], full: ['🔴', t('occ_full'), 'svm-bad'],
    };
    const oc = _OCC_CHIP[liveVehicle.occ];
    if (oc) featureChips.push(`<span class="svm-i ${oc[2]}">${oc[0]} ${oc[1]}</span>`);
  }
  if (liveVehicle?.accessible) featureChips.push(`<span class="svm-i">♿ Accessible</span>`);
  if (liveVehicle?.air_con)    featureChips.push(`<span class="svm-i">❄ A/C</span>`);
  if (liveVehicle?.carriages)  featureChips.push(`<span class="svm-i">${liveVehicle.carriages} cars</span>`);
  if (liveVehicle?.model) {
    // Model strings come through as raw vehicle descriptors like
    // "BYD~D9RA~Gemilang~ECORANGE" — show a clean, readable subset.
    const _pm = String(liveVehicle.model).replace(/[~_]+/g, ' ').replace(/-?set$/i, '').trim();
    const _isTrain = mot === 1 || mot === 2;   // "-set" only reads right for rolling stock
    const _modelTxt = _pm.length > 22 ? _pm.split(' ').slice(0, 2).join(' ') : _pm;
    featureChips.push(`<span class="svm-i">${_modelTxt}${_isTrain ? '-set' : ''}</span>`);
  }
  if (liveVehicle?.prior_trip) featureChips.push(`<span class="svm-i svm-warn">⚠ Prior trip</span>`);

  // Each leg is an accordion: collapsed → a clickable button (route, segment,
  // times, seats/features); expanded → the full terminus-to-terminus stop list.
  const legKey   = String(legIdx);
  const expanded = svState.expandedLegs.has(legKey);
  const _hDep = estDep(leg), _hArr = estArr(leg);
  const _legDepPlan = leg.origin?.departureTimePlanned || leg.stopSequence?.[0]?.departureTimePlanned;
  const _legArrPlan = leg.destination?.arrivalTimePlanned || leg.stopSequence?.at(-1)?.arrivalTimePlanned;
  const _hDur = leg.duration ? Math.round(leg.duration / 60)
             : (_hDep && _hArr ? Math.round((new Date(_hArr) - new Date(_hDep)) / 60000) : 0);
  // Show original → new like the journey card: when off-schedule, the planned
  // time is struck through next to the live estimate.
  const _fmtPN = (plan, est) => {
    if (!est) return '';
    if (plan && delayMins(plan, est) && fmt(plan) !== fmt(est))
      return `<s class="sv-time-old">${fmt(plan)}</s> <span class="sv-time-new">${fmt(est)}</span>`;
    return fmt(est);
  };
  const _hTimes = _hDep ? `${_fmtPN(_legDepPlan, _hDep)}${_hArr ? ' – ' + _fmtPN(_legArrPlan, _hArr) : ''}` : '';
  const _hMeta = [ _hTimes, _hDur ? `${_hDur} ${t('min')}` : '' ].filter(Boolean).join(' · ');
  // Boarding + alighting platforms for this leg — shown on the button so you know
  // where to wait AND which platform you arrive at, without expanding the list.
  const _hBoardPlat = legOriginPlat(leg, mot);
  const _hAlightPlat = legDestPlat(leg, mot);

  // No status pill: _fmtStack below already colours the live time red/blue and
  // strikes the planned one, so a pill repeated it — and the "On time" variant
  // fired on every leg. An uncoloured time IS the on-time signal.

  // Stacked time cell: live estimate on top, struck planned small underneath —
  // avoids the two times colliding side-by-side in the narrow time column.
  const _fmtStack = (plan, est) => {
    if (!est) return '';
    const d = plan ? delayMins(plan, est) : 0;
    const off = d && fmt(plan) !== fmt(est);
    const cls = off ? (d > 0 ? 'is-late' : 'is-early') : '';
    return `<span class="sv-legc-tnew ${cls}">${fmt(est)}</span>${off ? `<span class="sv-legc-told">${fmt(plan)}</span>` : ''}`;
  };
  const _hDepFmt = _fmtStack(_legDepPlan, _hDep);
  const _hArrFmt = _fmtStack(_legArrPlan, _hArr);
  html += `<div class="sv-leg-head ${expanded ? 'sv-leg-open' : ''}" data-leghead="${legKey}">`;
  // Expanded → SLIM sticky header (badge + destination + Hide), so the stop list
  // scrolls freely and the big timeline card isn't pinned taking half the screen.
  // Collapsed → the full O/D timeline card with chips and a View-stops CTA.
  // No Back here: the view header's "← Back" now steps back one level itself
  // (open leg → leg list → results), so a second "‹ Back" inside the leg header
  // said the same word and did the same thing, two inches apart.
  const _topRow = `<div class="sv-legc-top">
      <span class="sv-badge" style="background:${bg};color:${fg}">${nm}</span>
      <span class="sv-legc-dest">${headsign || toName}</span>
      ${loading ? '<span class="sv-loading-inline"><div class="sv-spin"></div></span>' : ''}
    </div>`;
  if (expanded) {
    const _auto = svState.autoLeg === legKey;
    html += `<button type="button" class="sv-legc sv-legc-slim sv-leg-btn sv-legc-open" style="--leg:${bg}" onclick="${_auto ? '_svBack()' : `_svToggleLeg('${legKey}')`}" aria-expanded="true">
    ${_topRow}
  </button>`;
    // Live vehicle facts (A/C, seats, carriages, model) were only rendered on the
    // COLLAPSED card — they vanished exactly when the stops opened. Pinned here so
    // they stay readable while you scroll the stop list.
    if (featureChips.length) {
      html += `<div class="sv-meta-row sv-meta-row-slim">${featureChips.join('<span class="svm-sep">·</span>')}</div>`;
    }
  } else {
    html += `<button type="button" class="sv-legc sv-leg-btn" style="--leg:${bg}" onclick="_svToggleLeg('${legKey}')" aria-expanded="false">
    ${_topRow}
    <div class="sv-legc-od">
      <div class="sv-legc-line">
        <span class="sv-legc-t">${_hDepFmt || ''}</span>
        <span class="sv-legc-rail"><span class="sv-legc-dot"></span></span>
        <span class="sv-legc-name">${fromName}</span>
        ${_hBoardPlat ? `<span class="sv-rt-plat">${_hBoardPlat}</span>` : ''}
      </div>
      ${_hDur ? `<div class="sv-legc-mid">
        <span class="sv-legc-mid-sp"></span>
        <span class="sv-legc-rail sv-legc-rail-mid"></span>
        <span class="sv-legc-dur-inline">${_hDur} ${t('min')}</span>
      </div>` : ''}
      <div class="sv-legc-line sv-legc-line-dest">
        <span class="sv-legc-t">${_hArrFmt || ''}</span>
        <span class="sv-legc-rail sv-legc-rail-end"><span class="sv-legc-dot sv-legc-dot-dest"></span></span>
        <span class="sv-legc-name">${toName}</span>
        ${_hAlightPlat ? `<span class="sv-rt-plat">${_hAlightPlat}</span>` : ''}
      </div>
    </div>
    ${featureChips.length ? `<div class="sv-meta-row">${featureChips.join('<span class="svm-sep">·</span>')}</div>` : ''}
    <div class="sv-legc-cta-wrap"><span class="sv-legc-cta">${t('view_stops') || 'View stops'}<span class="sv-legc-cta-ic">▾</span></span></div>
  </button>`;
  }
  // Formation stays INSIDE the sticky header (pinned, always visible) when expanded.
  // The scroll-to-board offset measures the full header height, so the boarding stop
  // lands just below the formation — not behind it, and the formation never scrolls away.
  if (expanded && liveVehicle?.formation?.length) {
    html += _buildFormationFull(liveVehicle.formation, liveVehicle.model, liveVehicle.accessible, liveVehicle.air_con);
  }
  // The more/fewer toggle pins here too, for the same reason as the formation:
  // the view auto-scrolls to the boarding stop, so anything placed above the stop
  // list scrolls UNDER this sticky header — invisible, and clicks land on the
  // header instead (which collapses the leg). Its inputs aren't known until the
  // stops resolve below, so reserve the slot and fill it in.
  const _ALLSTOPS_SLOT = '<!--allstops-slot-->';
  html += _ALLSTOPS_SLOT;
  html += `</div>`;  // /sv-leg-head (slim header + formation + stop-list toggle)

  // Collapsed: stop here — the button above is the whole leg.
  if (!expanded) return html.replace(_ALLSTOPS_SLOT, '');

  // Stop list
  const now = new Date();
  const depT  = estDep(leg);
  const arrT  = estArr(leg);
  const hasDeparted = depT && new Date(depT) <= now;
  const hasArrived  = arrT && new Date(arrT) <= now;
  const isInTransit = hasDeparted && !hasArrived;

  // Resolve stop list: full API stops > leg.stopSequence fallback
  const fullStops = entry?.stops;
  const stops = fullStops && fullStops.length
    ? fullStops
    : (leg.stopSequence || []).map(s => ({
        name:    s.name || '',
        disasm:  s.disassembledName || s.name || '',
        depPlan: s.departureTimePlanned || '',
        depEst:  s.departureTimeEstimated || '',
        arrPlan: s.arrivalTimePlanned || '',
        arrEst:  s.arrivalTimeEstimated || '',
        plat:    platLabel(s.name, s.disassembledName, s, mot),
      }));

  // ── Find boarding / alighting indices in stop list ───────────────────────
  const fromNorm = fromName.toLowerCase();
  const toNorm   = toName.toLowerCase();
  const _match = (sName, norm) =>
    cleanStationName(sName).toLowerCase().includes(norm) ||
    norm.includes(cleanStationName(sName).toLowerCase());
  // A station can appear TWICE in one trip via City Circle through-running
  // (e.g. board the 1:53 Central P23, not the 1:35 Central P17 the same train
  // visited on its loop). Plain findIndex grabs the first → wrong "Board" marker.
  // Disambiguate: among name matches, pick the stop whose scheduled time is
  // closest to the leg's board/alight time.
  const _legMin = v => { if (!v) return null; const p = sydParts(v); return p.hour * 60 + p.minute; };
  const _circDiff = (a, b) => { const d = Math.abs(a - b); return d > 720 ? 1440 - d : d; };
  const _pickIdx = (norm, targetT, after = -1) => {
    const cands = [];
    stops.forEach((s, i) => { if (i > after && _match(s.name, norm)) cands.push(i); });
    if (cands.length <= 1) return cands.length ? cands[0] : -1;
    const tgt = _legMin(targetT);
    if (tgt == null) return cands[0];
    let best = cands[0], bestD = Infinity;
    for (const i of cands) {
      const m = _legMin(stops[i].depEst || stops[i].depPlan || stops[i].arrEst || stops[i].arrPlan);
      if (m == null) continue;
      const d = _circDiff(m, tgt);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const fromIdx = _pickIdx(fromNorm, depT);
  const toIdx   = _pickIdx(toNorm, arrT, fromIdx);   // alight must be after board
  // Show the RIDE, not the vehicle's whole working. The stop list is chained
  // through the vehicle's block, so past the alight point it runs on to the
  // terminus and then back again — 60 rows for a 2-stop trip. Default to
  // board-1 … alight+1; the rest is one tap away.
  const _showAll = svState.allStops.has(legKey);
  const _canWindow = fromIdx >= 0 && toIdx > fromIdx;
  // Default = exactly the ridden segment, board → alight. "View more stops"
  // reveals the vehicle's whole working; "Show fewer stops" comes straight back
  // to board → alight.
  const visStart = (_showAll || !_canWindow) ? 0 : fromIdx;
  const visEnd   = (_showAll || !_canWindow) ? stops.length - 1 : toIdx;
  // How many stops the WINDOW hides — computed from the ride, NOT from what is
  // currently on screen. Deriving it from visStart/visEnd made it 0 once expanded,
  // which switched the toggle off and left no way back to board → alight.
  const _hiddenCount = _canWindow ? stops.length - (toIdx - fromIdx + 1) : 0;

  // ── Service position ─────────────────────────────────────────────────────
  // Position is always timetable-based: the last stop whose departure time has
  // passed is used as the "current" position. This works with no GTFS-RT at all.
  //
  // GTFS-RT adds two things:
  //   1. Confirms the service is actually running (vehicle found via trip_id).
  //   2. Provides occupancy, model, A/C, formation data on the card.
  //
  // What GTFS-RT CANNOT do here: map its internal stop_id
  // (e.g. "Sydney.Central 20 Loc") to the trip planner's stopId ("10101100").
  // These are different ID systems with no shared key, so exact stop matching
  // is impossible. Position always comes from the timetable.
  // Compare by Sydney minute-of-day so it works for both ISO leg times AND the
  // bare "HH:MM:SS" GTFS times on before-boarding stops (new Date(HMS)=Invalid,
  // which previously froze the marker at the boarding stop).
  const _nowMin = (() => { const np = sydParts(new Date()); return np.hour * 60 + np.minute; })();
  const _minOfDay = v => { const p = sydParts(v); return p.hour * 60 + p.minute; };
  let lastPassedIdx = -1;
  stops.forEach((s, i) => {
    const t = s.depEst || s.depPlan || s.arrEst || s.arrPlan;
    if (!t) return;
    let diff = _nowMin - _minOfDay(t);   // >= 0 → already in the past
    if (diff < -720) diff += 1440;       // midnight wrap
    if (diff >  720) diff -= 1440;
    if (diff >= 0) lastPassedIdx = i;
  });

  // "LIVE" means the vehicle was found via trip_id — the service is confirmed
  // running. The position badge shows SCHED when there's no vehicle data at all
  // (service may have been cancelled or data not yet available).
  // LIVE only when an actual GTFS-RT vehicle position matches this service.
  // Estimated times alone (legIsRealtime) are NOT enough → those show SCHED.
  const isLiveConfirmed = !!liveVehicle;
  const vehicleStopIdx  = lastPassedIdx;  // always timetable-based

  // Minutes until the service reaches our boarding stop
  const minsUntilDep = depT ? Math.round((new Date(depT) - now) / 60000) : null;
  // Service approaching (before it reaches our first stop)
  const serviceApproaching = !hasDeparted && minsUntilDep !== null && minsUntilDep > -2;

  // The timeline ends at the alighting stop — we don't draw the "continues to
  // terminus" stub past where the rider gets off.
  const showPostGap = false;

  // LIVE badge = vehicle confirmed running this trip via GTFS-RT trip_id match.
  // Position is always timetable-estimated; LIVE means "service is confirmed running",
  // not "GPS-confirmed at this exact stop" (stop_id formats are incompatible).
  const liveBadge = isLiveConfirmed
    ? `<span class="sv-live-badge"><span class="sv-live-dot"></span>LIVE</span>`
    : `<span class="sv-sched-badge">SCHED</span>`;

  let vehicleShown = false;
  const tlStops = []; let tlBoardIdx = 0, tlAlightIdx = -1;   // built for stopTimeline()
  html += '<div class="sv-timeline">';

  // Fill the slot reserved in the sticky header above.
  if (_canWindow && _hiddenCount > 0) {
    html = html.replace(_ALLSTOPS_SLOT,
      `<button type="button" class="sv-allstops sv-allstops-top" onclick="_svToggleAllStops('${legKey}')">
        <span class="sv-allstops-ic">${_showAll ? '▴' : '▾'}</span>
        ${_showAll ? (t('sv_show_ride') || 'Show fewer stops')
                   : `${t('sv_show_all') || 'View more stops'} · +${_hiddenCount}`}
      </button>`);
  }

  // ── Pre-boarding position marker ─────────────────────────────────────────
  // Always shown when service hasn't reached boarding stop yet.
  // Uses timetable timing (always) + GTFS-RT confirmation (when available).
  if (serviceApproaching) {
    const minsTxt = minsUntilDep <= 0 ? t('dep_now') : `${minsUntilDep} ${t('min')}`;
    const preTxt = (liveVehicle ? t('en_route_in') : t('sched_departs_in')).replace('{t}', minsTxt);
    html += `<div class="sv-position-pre">
      <div class="sv-position-icon">${vIcon}</div>
      <div class="sv-position-content">
        <span class="sv-position-txt">${preTxt}</span>
        ${liveBadge}
      </div>
    </div>`;
    // Don't set vehicleShown here: we still want the inline marker below to show
    // the train's actual position among the before-boarding stops.
  }

  stops.forEach((s, i) => {
    if (i < visStart || i > visEnd) return;
    const isFrom  = i === (fromIdx >= 0 ? fromIdx : 0);
    const isTo    = i === (toIdx   >= 0 ? toIdx   : stops.length - 1);
    const isTerm  = i === stops.length - 1 && !showPostGap;
    const isPast  = i <= vehicleStopIdx;
    const isBeforeBoard = fromIdx > 0 && i < fromIdx;
    const isAfterAlight = toIdx   > 0 && i > toIdx;

    // You ALIGHT on arrival, so the alighting stop (and the terminus) show the
    // arrival time — not the post-dwell departure the card never sees. Every
    // other stop is departure-first (when the service leaves that stop).
    const arrFirst = isTo || isTerm;
    let tt     = arrFirst
      ? (s.arrEst || s.arrPlan || s.depEst || s.depPlan)
      : (s.depEst || s.depPlan || s.arrEst || s.arrPlan);
    const ttPlan = arrFirst ? (s.arrPlan || s.depPlan) : (s.depPlan || s.arrPlan);
    // Realtime delay from TripUpdates (set by _mergeTripUpdates) wins; otherwise
    // derive it from estimated-vs-planned times the trip planner supplied.
    let delay  = (s._delayMin != null) ? s._delayMin : delayMins(ttPlan, tt);
    // SINGLE SOURCE OF TRUTH at board/alight: pin these two stops to the leg's
    // own estimate (the same value the leg card AND journey card show), so the
    // three views never disagree on the times that matter. Intermediate stops
    // keep their GTFS-RT deltas.
    if (isFrom && _hDep) { tt = _hDep; delay = delayMins(_legDepPlan, _hDep); }
    else if (isTo && _hArr) { tt = _hArr; delay = delayMins(_legArrPlan, _hArr); }
    const sName  = _stopDisplayName(s.name);
    // platLabel misses stops whose platform is baked into the name with no comma
    // ("Redfern Station Platform 6") — recover it rather than lose the number.
    const plat   = _platText(s.plat || (s.name || '').match(/(Platform|Stand|Wharf|Track)\s*[A-Z0-9]+/i)?.[0] || '');
    const occIco = { many:'🟢', few:'🟡', standing:'🟠', crowded:'🔴', full:'🔴' }[s.occ] || '';

    // Vehicle "approaching" marker → attach to the stop it precedes (rendered by
    // stopTimeline's markerBefore slot). Same trigger as before.
    let markerBefore = null;
    if (!vehicleShown && !hasArrived && i > 0 && !isPast && lastPassedIdx >= 0) {
      vehicleShown = true;
      markerBefore = { icon: vIcon, text: t('approaching').replace('{icon}', '').replace('{stop}', sName).trim(), live: isLiveConfirmed };
    }
    void occIco;   // occupancy now mapped by stopTimeline from s.occ
    if (isFrom) tlBoardIdx = tlStops.length;
    if (isTo)   tlAlightIdx = tlStops.length;
    tlStops.push({
      name: sName,
      time: s.skipped ? '' : (tt ? fmt(tt) : ''),
      platform: plat,
      delay: s.skipped ? null : (delay || null),
      occ: s.occ || null,
      skipped: !!s.skipped,
      terminus: isTerm,
      // dimming: reuse the section's own past/before/after judgement
      dim: (isPast || isBeforeBoard || (isAfterAlight && !isTerm)),
      label: isFrom ? t('board_label') : isTo ? t('alight_label') : '',
      anchor: isFrom ? legKey : null,
      markerBefore,
    });
  });
  html += stopTimeline({
    stops: tlStops,
    boardIdx: tlBoardIdx,
    alightIdx: tlAlightIdx >= 0 ? tlAlightIdx : tlStops.length - 1,
    lineColor: bg,
  });

  // Repeat the control at the FOOT only when the list is long enough that the one
  // at the top has scrolled away — on a 2-stop ride two identical buttons just
  // sandwich two rows.
  // (The old "Show less" that collapsed the whole leg used to sit here and read as
  // the pair to this button, so the two fought — leg collapse is the header's Back.)
  if (_canWindow && _hiddenCount > 0 && (visEnd - visStart + 1) >= 8) {
    html += `<button type="button" class="sv-allstops" onclick="_svToggleAllStops('${legKey}')">
      <span class="sv-allstops-ic">${_showAll ? '▴' : '▾'}</span>
      ${_showAll ? (t('sv_show_ride') || 'Show fewer stops')
                 : `${t('sv_show_all') || 'View more stops'} · +${_hiddenCount}`}
    </button>`;
  }

  html += '</div>';
  // Strip the slot if it was never filled (no window / nothing hidden).
  return html.replace(_ALLSTOPS_SLOT, '');
}


// "Redfern Station Platform 6" → "Redfern". On a rail stop list, "Station" and
// "Platform" are on every single row: constants, not information. The platform
// NUMBER is information, so it survives — as its own compact tag (_shortPlat).
export function _stopDisplayName(name) {
  if (!name) return '';
  let n = cleanStationName(name);                                        // drop after first comma
  n = n.replace(/\s*(Platform|Stand|Wharf|Track)\s*[A-Z0-9]+\s*$/i, ''); // trailing "Platform 6"
  n = n.replace(/\s+Station$/i, '');                                     // trailing "Station"
  return n.trim() || cleanStationName(name);
}
// Platform/stand label, kept in FULL ("Platform 6", "Stand B") — the same wording
// the station signage and the leg card use. Abbreviating it here was the only
// place in the app that said "Plat".
export function _platText(p) {
  return p ? String(p).trim() : '';
}

// Only show disassembledName if it adds info the stop name doesn't already have.
// Bus stops: name="Glenfield Station, Railway Pde, Glenfield", disasm="Glenfield Station, Railway Pde"
// → name starts with disasm → redundant → hide.
// Trains: name="Central Station", disasm="Platform 1" → different → show.
export function usefulDisasm(name, disasm) {
  if (!disasm || !name) return disasm || '';
  const n = name.trim(), d = disasm.trim();
  if (n === d) return '';
  if (n.startsWith(d)) return '';   // disasm is just name without suburb
  return d;
}

export function buildLegs(legs) {
  const now = new Date();
  let html = '';

  legs.forEach((leg, li) => {
    if (isWalkLeg(leg)) {
      const m = Math.round((leg.duration || 0) / 60);
      html += `<div class="transfer-row">🚶 ${t('walk_leg')} ${m} ${t('min')}</div>`;
      return;
    }

    const mot      = leg.transportation?.product?.class || 0;
    const nm       = leg.transportation?.disassembledName || leg.transportation?.number || '';
    const { bg, fg } = getLineColors(mot, nm);
    const vIcon    = VEHICLE_ICON[mot] || '🚌';
    const depT     = estDep(leg);
    const depTPlan = leg.origin?.departureTimePlanned;
    const arrT     = estArr(leg);
    const arrTPlan = leg.destination?.arrivalTimePlanned;
    const depD     = delayMins(depTPlan, depT);
    const arrD     = delayMins(arrTPlan, arrT);
    const seq      = leg.stopSequence || [];

    // ── Vehicle position ───────────────────────────────────────────────────
    // hasDeparted: service has left the origin
    // lastPassedIdx: last stop in seq whose departure time is in the past
    // hasArrived: service has reached the destination
    const hasDeparted  = depT  && new Date(depT)  <= now;
    const hasArrived   = arrT  && new Date(arrT)  <= now;
    const isInTransit  = hasDeparted && !hasArrived;

    let lastPassedIdx = hasDeparted ? 0 : -1; // origin counts as passed once departed
    if (seq.length > 1) {
      for (let i = 1; i < seq.length - 1; i++) {
        const st = seq[i].departureTimeEstimated || seq[i].departureTimePlanned;
        if (st && new Date(st) <= now) lastPassedIdx = i; else break;
      }
    }

    const isTransfer = li > 0 && !isWalkLeg(legs[li - 1]);
    if (isTransfer) html += `<div class="transfer-row">🔄 ${t('transfer')}: ${cleanStationName(leg.origin?.name || '')}</div>`;

    const op = platLabel(leg.origin?.name, seq[0]?.disassembledName || leg.origin?.disassembledName, seq[0] || leg.origin, mot);
    html += `<div class="leg-row">
      <div style="min-width:46px;flex-shrink:0;padding-top:2px;">
        <span class="lr-time">${fmt(depT)}</span>${delayBadge(depD)}
        ${plannedLine(depTPlan, depT)}
      </div>
      <span class="lr-dot orig"></span>
      <div class="lr-body">
        <div class="lr-badge"><span class="lbadge" style="background:${bg};color:${fg}">${nm}</span></div>
        <div class="lr-station">${cleanStationName(leg.origin?.name || '')}</div>
        ${op ? `<div class="lr-plat">${op}</div>` : ''}
      </div>
    </div>`;

    const mid = seq.slice(1, -1);
    html += `<div class="leg-connector"><div class="lc-sp"></div><div class="lc-line" style="background:${bg};opacity:0.35;"></div><div class="lc-stops">`;

    if (mid.length) {
      let markerShown = false;
      mid.forEach((s, mi) => {
        const seqIdx = mi + 1; // index in full seq (0 = origin)
        const isPast = seqIdx <= lastPassedIdx;
        const ttEst  = s.departureTimeEstimated || s.arrivalTimeEstimated;
        const ttPlan = s.departureTimePlanned || s.arrivalTimePlanned || '';
        const tt     = ttEst || ttPlan;
        const sDelay = delayMins(ttPlan, tt);
        const sp     = platLabel(s.name, s.disassembledName, s, mot);

        // Insert vehicle marker just before the first upcoming stop
        if (isInTransit && !markerShown && !isPast) {
          markerShown = true;
          html += `<div class="vehicle-marker">${t('en_route_next').replace('{icon}', vIcon).replace('{stop}', cleanStationName(s.name || ''))}</div>`;
        }

        html += `<div class="lc-row" style="${isPast ? 'opacity:0.38;' : ''}">
          <div style="min-width:42px;flex-shrink:0;">
            <span class="lc-t">${fmt(tt)}</span>
            ${!isPast && sDelay ? `<div style="margin-top:1px;">${delayBadge(sDelay)}</div>` : ''}
          </div>
          <div style="flex:1;min-width:0;">
            <span class="lc-n">${cleanStationName(s.name || '')}</span>
            ${sp ? `<span class="lc-p"> · ${sp}</span>` : ''}
          </div>
        </div>`;
      });

      // Vehicle past all intermediate stops but not yet at destination
      if (isInTransit && !markerShown) {
        html += `<div class="vehicle-marker">${t('approaching').replace('{icon}', vIcon).replace('{stop}', cleanStationName(leg.destination?.name || ''))}</div>`;
      }
    } else if (isInTransit) {
      // No intermediate stops — show simple en-route marker
      html += `<div class="vehicle-marker" style="margin:8px 0;">${t('en_route_to').replace('{icon}', vIcon).replace('{stop}', cleanStationName(leg.destination?.name || ''))}</div>`;
    } else {
      html += `<div style="min-height:20px"></div>`;
    }

    html += `</div></div>`;

    const dp2 = platLabel(leg.destination?.name, seq.at(-1)?.disassembledName || leg.destination?.disassembledName, seq.at(-1) || leg.destination, mot);
    html += `<div class="leg-row">
      <div style="min-width:46px;flex-shrink:0;padding-top:2px;">
        <span class="lr-time">${fmt(arrT)}</span>${delayBadge(arrD)}
        ${plannedLine(arrTPlan, arrT)}
      </div>
      <span class="lr-dot dest"></span>
      <div class="lr-body">
        <div class="lr-station">${cleanStationName(leg.destination?.name || '')}</div>
        ${dp2 ? `<div class="lr-plat">${dp2}</div>` : ''}
      </div>
    </div>`;
  });
  return html;
}
