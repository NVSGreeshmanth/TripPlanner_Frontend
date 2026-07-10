// Tracked-service persistence + live updates: pin a service, keep it fresh on the
// Journey list and Home dashboard (re-poll + live vehicle positions), and the Home
// auto-refresh timers. Imports primitives from core/i18n and cross-feature runtime
// fns from the app entry / other modules.
import { byId, esc, PROXY, REFRESH_MS, MOT_ICONS, _evIsRealtime,
         state, jr, depState, trackState, homeState, svState, pref, _lsGet, _lsGetJSON, _lsSet } from "./core.js";
import { t, i18n } from "./i18n.js";
import { getLineColors } from "./line_colors.js";
import { weatherHomeHtml } from "./weather.js";
import { _vpModesFor, countdown, loadDepartures, loadVehiclePos } from "./vehicles.js";
import { _ovOpen, showToast } from "./stops.js";
import {
  MAX_TRACKED, _closeJourneyRoute, agoText, carsBadgeHtml, cleanStationName, currentJourneyData,
  delayMins, departAt, deviceOffSydney, doSearch, escAttr, estArr, estDep, fetchJourneys, fmtParts, getFavJ,
  getRecents, greeting, haptic, isTracked, isWalkLeg, legDestPlat, legOriginPlat, liveVehicleForLeg,
  rerenderJourneys, seatBadgeHtml, selectStop, serverReady, setClearBtn, switchTab, sydAbbr, sydParts,
  timedFetch, warmServer, z2,
} from "../app.js";
// ── Tracked service persistence (up to MAX_TRACKED) ──────────────────────────
// Snapshots are stashed in localStorage as an array so pinned services survive a
// reload / tab switch (when the in-memory svState.stops is empty) and can reopen.
export function persistTracked() {
  const arr = trackState.uids.map(uid => {
    const d = trackState.data.get(uid) || svState.stops.get(uid);
    return d?.legs?.length ? { uid, data: { legs: d.legs, origName: d.origName, destName: d.destName } } : null;
  }).filter(Boolean);
  try { _lsSet('nsw_track', arr.length ? JSON.stringify(arr) : ''); } catch {}
}
// In pin order: [{ uid, data:{legs,origName,destName} }]
export function getTrackedServices() {
  return trackState.uids.map(uid => {
    const d = trackState.data.get(uid);
    return d ? { uid, data: d } : null;
  }).filter(Boolean);
}
export function addTracked(uid) {
  if (isTracked(uid)) return 'exists';
  if (trackState.uids.length >= MAX_TRACKED) return 'full';
  const data = svState.stops.get(uid);
  if (!data?.legs?.length) return 'nodata';
  trackState.uids.push(uid);
  trackState.data.set(uid, { legs: data.legs, origName: data.origName, destName: data.destName });
  persistTracked();
  return 'added';
}
export function removeTracked(uid) {
  trackState.uids = trackState.uids.filter(u => u !== uid);
  trackState.data.delete(uid);
  persistTracked();
}
export function toggleTracked(uid) {
  if (isTracked(uid)) { removeTracked(uid); return 'removed'; }
  return addTracked(uid);             // 'added' | 'full' | 'nodata'
}
// Untrack a specific service from its Home card.
export function untrackFromHome(uid) {
  removeTracked(uid);
  haptic([8]); showToast(t('track_stopped'));
  renderHome();
  rerenderJourneys();
}
// Restore pins into memory at startup so the journey card + stops view know them.
export function restoreTracked() {
  let arr;
  try { arr = JSON.parse(_lsGet('nsw_track', '') || '[]'); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = arr?.uid ? [arr] : [];   // migrate old single-object format
  trackState.uids = []; trackState.data.clear();
  arr.forEach(tr => {
    if (!tr?.data?.legs?.length || trackState.uids.length >= MAX_TRACKED) return;
    if (_trackStale(estArr(tr.data.legs[tr.data.legs.length - 1]))) return;  // very old — don't resurrect
    trackState.uids.push(tr.uid);
    trackState.data.set(tr.uid, tr.data);
    svState.stops.set(tr.uid, tr.data);
  });
  persistTracked();   // rewrite the cleaned list
}
// Has the service reached its destination? (arrival time passed, +60s skew buffer).
// When true the card switches to an "Arrived" state — it does NOT auto-close.
export function _trackArrived(arrIso) {
  if (!arrIso) return false;
  return Date.now() > new Date(arrIso).getTime() + 60000;
}
// Safety cap so an arrived trip doesn't linger forever across sessions: drop it
// only if its arrival was more than 6 hours ago (e.g. left open overnight).
export function _trackStale(arrIso) {
  if (!arrIso) return false;
  return Date.now() > new Date(arrIso).getTime() + 6 * 3600000;
}
// Overall trip departure/arrival from the actual boarding leg and final leg,
// ignoring leading/trailing walk legs (whose times would skew the countdown).
export function _trackDepArr(legs) {
  const transit = legs.filter(l => !isWalkLeg(l));
  const depLeg = transit[0] || legs[0];
  const arrLeg = transit[transit.length - 1] || legs[legs.length - 1];
  return { dep: estDep(depLeg), arr: estArr(arrLeg) };
}
// One end of the times row: time (+ am/pm) and platform/stand chip.
export function _trackEndHtml(iso, plat) {
  const p = fmtParts(iso);
  return `${p.time}${p.ap ? `<span class="ampm">${p.ap}</span>` : ''}${plat ? ` <span class="home-track-plat">${plat}</span>` : ''}`;
}
// Boarding-leg origin platform/stand + final-leg destination platform/stand.
export function _trackPlats(legs) {
  const firstTL = legs.find(l => !isWalkLeg(l)) || legs[0];
  const lastTL  = [...legs].reverse().find(l => !isWalkLeg(l)) || legs[legs.length - 1];
  return {
    orig: legOriginPlat(firstTL),
    dest: legDestPlat(lastTL),
  };
}
// Fraction of the trip elapsed (0 before departure → 1 at arrival), for the bar.
export function _trackProgress(legs) {
  const { dep, arr } = _trackDepArr(legs);
  if (!dep || !arr) return 0;
  const d = new Date(dep).getTime(), a = new Date(arr).getTime(), now = Date.now();
  if (now <= d) return 0;
  if (now >= a) return 1;
  return Math.max(0, Math.min(1, (now - d) / (a - d)));
}
// Live ETA for the tracked trip: counts down to departure, then to arrival.
export function _trackEtaParts(legs) {
  const { dep, arr } = _trackDepArr(legs);
  const now = Date.now();
  if (dep && new Date(dep).getTime() > now) {
    const m = Math.round((new Date(dep).getTime() - now) / 60000);
    return { phase: 'pre', txt: m <= 0 ? t('departing_now') : `${t('departs_in')} ${m} ${t('min')}`, cls: 'soon' };
  }
  if (arr && new Date(arr).getTime() > now) {
    const m = Math.round((new Date(arr).getTime() - now) / 60000);
    return { phase: 'transit', txt: m <= 0 ? `${t('arrives_in')} <1 ${t('min')}` : `${t('arrives_in')} ${m} ${t('min')}`, cls: 'go' };
  }
  return { phase: 'arrived', txt: t('arrived_word'), cls: 'done' };
}
// Refresh just the ETA chip on each home tick (no full re-render → no flicker).
export function updateTrackEta() {
  const el = byId('home-track-eta');
  if (!el) return;
  const tr = getTrackedServices()[0];
  if (!tr?.data?.legs?.length) return;
  const { dep, arr } = _trackDepArr(tr.data.legs);
  if (_trackStale(arr)) { removeTracked(tr.uid); renderHome(); return; }
  const arrived = _trackArrived(arr);
  const enRoute = !arrived && dep && new Date(dep).getTime() <= Date.now();
  const p = _trackEtaParts(tr.data.legs);
  el.innerHTML = p.txt;
  el.className = 'home-track-eta ' + p.cls;
  // Advance the live progress bar (dep → arr).
  const fill = byId('home-track-fill');
  if (fill) fill.style.width = Math.round(_trackProgress(tr.data.legs) * 100) + '%';
  // Refresh live seat + carriage badges (occupancy from trip-plan or GTFS-RT,
  // carriage count from GTFS-RT — the same data the journey card shows).
  const ftl = tr.data.legs.find(l => !isWalkLeg(l)) || tr.data.legs[0];
  const seatEl = byId('home-track-seat');
  if (seatEl) seatEl.innerHTML = seatBadgeHtml(ftl, dep);
  const carsEl = byId('home-track-cars');
  if (carsEl) carsEl.innerHTML = carsBadgeHtml(ftl);
  // Live times + platforms (they can change in realtime — delays, platform moves).
  const plats = _trackPlats(tr.data.legs);
  const depEl = byId('home-track-dep');
  if (depEl) depEl.innerHTML = _trackEndHtml(dep, plats.orig);
  const arrEl = byId('home-track-arr');
  if (arrEl) arrEl.innerHTML = _trackEndHtml(arr, plats.dest);
  // Live indicator: "Arrived" when done, "En route" once departed, else "LIVE";
  // append "· GPS" when a live vehicle is matched.
  const card = byId('home-track-card');
  if (card) card.classList.toggle('home-track-arrived', arrived);
  const live = card?.querySelector('.home-track-live');
  if (live) live.innerHTML = arrived
    ? `✓ ${t('arrived_word')}`
    : `<span class="ldot"></span>${enRoute ? t('en_route_word') : t('live_word')}${liveVehicleForLeg(ftl) ? ' · GPS' : ''}`;
}

// ── Live re-poll for the tracked trip (Home) ────────────────────────────────
// Reuses the SAME mechanism the Journey tab uses: re-query the trip plan
// (/trip?from=&to=) and re-identify this exact service among the fresh results
// by its line signature + planned departure. That refreshes both the departure
// AND the in-transit arrival estimates — fully live, identical to the journey list.
export const _planMin = iso => iso ? Math.round(new Date(iso).getTime() / 60000) : NaN;
export function _legSig(legs) {
  return legs.filter(l => !isWalkLeg(l)).map(l => l.transportation?.disassembledName || l.transportation?.number || '?').join('>');
}
export async function refreshTrackedLive() {
  if (trackState.liveBusy || !navigator.onLine) return;
  const tr = getTrackedServices()[0];
  if (!tr?.data?.legs?.length) return;
  const legs = tr.data.legs;
  const { dep, arr } = _trackDepArr(legs);
  if (_trackArrived(arr)) return;   // arrived → stop polling
  // Throttle when the trip is far off — delays rarely change hours ahead, so poll
  // every ~2 min then; tighten to ~30s once inside the last half hour before
  // boarding AND for the whole in-transit phase (so the arrival ETA stays live).
  const minsToDep = dep ? (new Date(dep).getTime() - Date.now()) / 60000 : 0;
  const minGap = minsToDep > 30 ? 120000 : 25000;
  if (Date.now() - trackState.lastPoll < minGap) return;
  trackState.lastPoll = Date.now();
  const fromId = legs[0]?.origin?.id;
  const toId   = legs[legs.length - 1]?.destination?.id;
  if (!fromId || !toId) return;
  const sig = _legSig(legs);
  const snapDepPlan = legs[0]?.origin?.departureTimePlanned || legs[0]?.stopSequence?.[0]?.departureTimePlanned;
  trackState.liveBusy = true;
  try {
    // Query the plan AT the service's planned departure (−3 min window) so the trip
    // is still returned even after it has left — that keeps the in-transit arrival
    // estimate live instead of frozen at the time tracking started.
    const params = { from: fromId, to: toId };
    if (snapDepPlan) {
      const base = new Date(new Date(snapDepPlan).getTime() - 180000);
      const sp = sydParts(base);
      params.itdDate = `${sp.year}${z2(sp.month)}${z2(sp.day)}`;
      params.itdTime = `${z2(sp.hour)}${z2(sp.minute)}`;
    }
    const r = await timedFetch(PROXY + '/trip?' + new URLSearchParams(params));
    if (!r.ok) return;
    const data = await r.json();
    const match = (data?.journeys || []).find(j => {
      const jl = j.legs || []; if (!jl.length) return false;
      const jdp = jl[0]?.origin?.departureTimePlanned || jl[0]?.stopSequence?.[0]?.departureTimePlanned;
      return _legSig(jl) === sig && _planMin(jdp) === _planMin(snapDepPlan);
    });
    if (match?.legs?.length) {
      tr.data.legs = match.legs;            // swap in the freshest live estimates (mutates the snapshot)
      svState.stops.set(tr.uid, tr.data);
      persistTracked();
      updateTrackEta();
    }
  } catch {} finally { trackState.liveBusy = false; }
}

// ── Live vehicle positions for the tracked trip (Home) ──────────────────────
// Loads GTFS-RT vehicle positions so the Home card can show carriage count,
// GPS-confirmed occupancy and the "· GPS" live tag — the same feed the journey
// tab loads. Gated to the active window (≤20 min before boarding through arrival)
// so it only runs during the part of the trip where live position is meaningful.
export async function refreshTrackedVP() {
  if (!navigator.onLine) return;
  const tr = getTrackedServices()[0];
  if (!tr?.data?.legs?.length) return;
  const legs = tr.data.legs;
  const { dep, arr } = _trackDepArr(legs);
  if (_trackArrived(arr)) return;
  const minsToDep = dep ? (new Date(dep).getTime() - Date.now()) / 60000 : 999;
  if (minsToDep > 20) return;                 // not active yet — skip the VP fetch
  if (Date.now() - trackState.lastVP < 25000) return;
  trackState.lastVP = Date.now();
  const firstTL = legs.find(l => !isWalkLeg(l)) || legs[0];
  const modes = _vpModesFor(firstTL?.transportation?.product?.class);
  if (!modes.length) return;
  await Promise.all(modes.map(m => loadVehiclePos(m).catch(() => null)));
  updateTrackEta();                           // repaint seat/cars/GPS from fresh VP
}

// Build the Home "Tracking now" card from the persisted snapshot.
export function _buildTrackedHome() {
  const tr = getTrackedServices()[0];
  if (!tr || !tr.data?.legs?.length) return '';
  const legs = tr.data.legs;
  const { dep, arr } = _trackDepArr(legs);
  if (_trackStale(arr)) { removeTracked(tr.uid); return ''; }   // drop only very old (6h+) trips
  const arrived = _trackArrived(arr);
  const enRoute = !arrived && dep && new Date(dep).getTime() <= Date.now();
  svState.stops.set(tr.uid, tr.data);   // seed so the card can reopen the stops view
  const firstTL = legs.find(l => !isWalkLeg(l)) || legs[0];
  const mot = firstTL?.transportation?.product?.class || 0;
  const nm  = firstTL?.transportation?.disassembledName || firstTL?.transportation?.number || '';
  const { bg, fg } = getLineColors(mot, nm);
  const plats = _trackPlats(legs);
  const eta = _trackEtaParts(legs);
  return `<div class="home-section-label" style="margin-top:18px">📍 ${t('tracking_now')}</div>
    <div class="home-track-card${arrived ? ' home-track-arrived' : ''}" id="home-track-card" onclick="openStopsView('${tr.uid}')">
      <div class="home-track-top">
        <span class="home-track-live">${arrived ? `✓ ${t('arrived_word')}` : `<span class="ldot"></span>${enRoute ? t('en_route_word') : t('live_word')}`}</span>
        <span class="home-track-eta ${eta.cls}" id="home-track-eta">${eta.txt}</span>
        <button class="home-track-stop" onclick="event.stopPropagation();untrackFromHome('${tr.uid}')" aria-label="${t('track_stopped')}">✕</button>
      </div>
      <div class="home-track-route">
        ${nm ? `<span class="lbadge" style="background:${bg};color:${fg}">${nm}</span>` : ''}
        <span class="home-track-od">${cleanStationName(tr.data.origName)} <span class="hr-arrow">→</span> ${cleanStationName(tr.data.destName)}</span>
        <span id="home-track-seat">${seatBadgeHtml(firstTL, dep)}</span>
        <span id="home-track-cars">${carsBadgeHtml(firstTL)}</span>
      </div>
      <div class="home-track-times">
        <span class="home-track-end" id="home-track-dep">${_trackEndHtml(dep, plats.orig)}</span>
        <span class="hr-arrow">→</span>
        <span class="home-track-end" id="home-track-arr">${_trackEndHtml(arr, plats.dest)}</span>
      </div>
      <div class="home-track-bar"><div class="home-track-fill" id="home-track-fill" style="width:${Math.round(_trackProgress(legs) * 100)}%"></div></div>
    </div>`;
}

// Popular Sydney stops for the empty-state quick-access chips → open Departures.
export const POPULAR_STOPS = [
  { label: 'Central',       name: 'Central Station, Sydney',       id: '200060' },
  { label: 'Town Hall',     name: 'Town Hall Station, Sydney',     id: '200070' },
  { label: 'Wynyard',       name: 'Wynyard Station, Sydney',       id: '200080' },
  { label: 'Circular Quay', name: 'Circular Quay Station, Sydney', id: '200020' },
  { label: 'Parramatta',    name: 'Parramatta Station, Parramatta',id: '215020' },
  { label: 'Chatswood',     name: 'Chatswood Station, Chatswood',  id: '207263' },
];
export function renderHome() {
  const el = byId('home-content');
  if (!el) return;
  const favs = getFavJ(), recents = getRecents(), favStops = getFavStops();
  const trackedHtml = _buildTrackedHome();
  let html = `<div class="home-state">
    <div class="home-hero">
      <div class="home-hero-row">
        <div class="home-greeting">${greeting()}</div>
        ${(favStops.length || trackState.uids.length) ? `<span class="home-auto" title="${t('auto_refresh')}"><span class="ldot"></span><span class="home-updated-txt">${agoText(homeState.updatedAt)}</span></span>` : ''}
      </div>
      ${weatherHomeHtml()}
      ${deviceOffSydney() ? `<div class="home-tznote">🕑 ${t('syd_showing')} · ${sydAbbr()}</div>` : ''}
    </div>`;

  // Primary call-to-action — always available, opens the Journey planner
  html += `<button class="home-cta" onclick="openJourneyView()">
    <svg class="home-cta-ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="3"/><path d="M12 21s-7-5.4-7-11a7 7 0 0 1 14 0c0 5.6-7 11-7 11z"/></svg>
    ${t('plan_journey_cta')}</button>`;

  if (!recents.length && !favStops.length && !trackedHtml) {
    html += `<div class="home-empty">
      <div class="home-empty-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><circle cx="8.5" cy="14" r="1"/><circle cx="15.5" cy="14" r="1"/><path d="M8 21l1.5-2M16 21l-1.5-2"/></svg></div>
      <div class="home-empty-t">${t('home_empty_t')}</div>
      <div class="home-empty-s">${t('home_empty_s')}</div>
      <div class="home-empty-chips">
        <div class="home-empty-chips-label">${t('popular_stops') || 'Popular stops'}</div>
        <div class="home-chip-row">
          ${POPULAR_STOPS.map(s => `<button class="home-chip" data-livestop="${escAttr(s.id)}" data-livename="${escAttr(s.name)}">${s.label}</button>`).join('')}
        </div>
      </div>
    </div>`;
    el.innerHTML = html + `</div>`;
    return;
  }

  // ── Live "My stops" board — real next departures for each saved stop ──
  if (favStops.length) {
    html += `<div class="home-section-label">🚏 ${t('my_stops')}</div>`;
    html += favStops.slice(0, 6).map((s, i) => `<div class="home-stop-card" data-livestop="${escAttr(s.id)}" data-livename="${escAttr(s.name)}">
      <div class="home-stop-head">
        <span class="home-stop-name">${cleanStationName(s.name)}</span>
        <span class="home-stop-go">›</span>
      </div>
      <div class="home-stop-deps" id="live-${i}"><span class="home-stop-loading"><span class="spin-sm"></span>${t('searching')}</span></div>
    </div>`).join('');
  }

  // Tracked service sits above recents so a live trip you're following is easy to reach
  html += trackedHtml;

  if (recents.length) {
    html += `<div class="home-section-label" style="margin-top:18px">🕘 ${t('recent')}</div>`;
    html += recents.slice(0, 3).map(j => `<div class="home-recent-card" data-launch="1" data-fn="${escAttr(j.from.name)}" data-fid="${escAttr(j.from.id)}" data-tn="${escAttr(j.to.name)}" data-tid="${escAttr(j.to.id)}">
      <span class="home-recent-ic">🕘</span>
      <div class="home-recent-route">${j.from.name}<span class="hr-arrow">→</span>${j.to.name}</div>
      <span class="home-recent-go">›</span></div>`).join('');
  }
  el.innerHTML = html + `</div>`;

  // Fill the live boards after paint (one light call per saved stop, max 6)
  if (favStops.length || trackedHtml) homeState.updatedAt = Date.now();
  if (favStops.length) fillHomeStops(favStops.slice(0, 6));
  if (trackedHtml) { refreshTrackedLive(); refreshTrackedVP(); }   // pull fresh live times + vehicle data
}
export function updateHomeAgo() {
  const el = byId('home-updated-txt');
  if (el) el.textContent = agoText(homeState.updatedAt);
}

// Fetch the next couple of departures for each saved stop and render them inline.
// A short cache avoids re-hitting the proxy on every minor re-render (tab switch,
// language toggle) — the data only meaningfully changes on the minute anyway.
export const HOME_TTL = 20000;
export async function fillHomeStops(stops) {
  if (!navigator.onLine) {
    stops.forEach((s, i) => { const c = byId('live-' + i); if (c) c.innerHTML = `<span class="home-stop-none">${t('off_title')}</span>`; });
    return;
  }
  // Serve any fresh cached cells immediately
  stops.forEach((s, i) => {
    const cached = homeState.cache[s.id];
    const c = byId('live-' + i);
    if (c && cached && Date.now() - cached.at < HOME_TTL) c.innerHTML = cached.html;
  });
  const toFetch = stops.map((s, i) => ({ s, i }))
    .filter(({ s }) => !(homeState.cache[s.id] && Date.now() - homeState.cache[s.id].at < HOME_TTL));
  if (!toFetch.length) return;

  if (!serverReady) await warmServer().catch(() => {});
  const sp = sydParts(new Date());
  const dateStr = `${sp.year}${z2(sp.month)}${z2(sp.day)}`, timeStr = `${z2(sp.hour)}${z2(sp.minute)}`;

  toFetch.forEach(async ({ s, i }) => {
    const cell = byId('live-' + i);
    try {
      const r = await timedFetch(PROXY + '/depart?' + new URLSearchParams({ stop: s.id, itdDate: dateStr, itdTime: timeStr }));
      if (!r.ok) throw 0;
      const data = await r.json();
      const cutoff = Date.now() - 300000;
      const evs = (data?.stopEvents || [])
        .filter(ev => new Date(ev.departureTimeEstimated || ev.departureTimePlanned).getTime() >= cutoff)
        .sort((a, b) => new Date(a.departureTimeEstimated || a.departureTimePlanned) - new Date(b.departureTimeEstimated || b.departureTimePlanned))
        .slice(0, 2);
      let cellHtml;
      if (!evs.length) {
        cellHtml = `<span class="home-stop-none">${t('no_live')}</span>`;
      } else {
        cellHtml = evs.map(ev => {
          const tr = ev.transportation || {}, mot = tr.product?.class || 0, nm = tr.disassembledName || tr.number || '';
          const { bg, fg } = getLineColors(mot, nm);
          const est = ev.departureTimeEstimated || ev.departureTimePlanned;
          const cd = countdown(est), delay = delayMins(ev.departureTimePlanned, est);
          const dest = tr.destination?.name || '';
          return `<div class="home-dep">
            <span class="home-dep-line" style="background:${bg};color:${fg}">${nm || (MOT_ICONS[mot] || '🚌')}</span>
            <span class="home-dep-dest">${cleanStationName(dest)}</span>
            <span class="home-dep-when ${cd.cls}">${cd.big}${cd.sub ? ' ' + cd.sub : ''}</span>
            ${delay > 0 ? `<span class="home-dep-late">+${delay}</span>` : delay < 0 ? `<span class="home-dep-early">${delay}</span>` : ''}
          </div>`;
        }).join('');
      }
      homeState.cache[s.id] = { at: Date.now(), html: cellHtml };
      if (cell) cell.innerHTML = cellHtml;
    } catch {
      if (cell) cell.innerHTML = `<span class="home-stop-none">${t('no_live')}</span>`;
    }
  });
}
// ── Home auto-refresh — keep the saved-stop live boards fresh, like the board ──
// Runs only while the Home tab is visible. Each tick busts the short cache so the
// next departures genuinely update; weather re-fetches on its own 15-min cycle.
export function startHomeTimer() {
  stopHomeTimer();
  const favStops = getFavStops();
  if (!favStops.length && !trackState.uids.length) return;   // nothing live to refresh
  homeState.agoTimer = setInterval(updateHomeAgo, 10000);      // tick the "updated Xs ago" label
  homeState.timer = setInterval(() => {
    if (document.hidden) return;   // paused while backgrounded
    if (byId('page-home')?.style.display === 'none') { stopHomeTimer(); return; }
    homeState.updatedAt = Date.now(); updateHomeAgo();
    updateTrackEta();                                      // live countdown on the tracked card
    refreshTrackedLive();                                  // re-poll live delays for the tracked trip
    refreshTrackedVP();                                    // live carriage/occupancy/GPS (active window)
    if (favStops.length) {
      for (const k in homeState.cache) delete homeState.cache[k];
      fillHomeStops(favStops.slice(0, 6));
    }
  }, REFRESH_MS);
}
export function stopHomeTimer() {
  if (homeState.timer) { clearInterval(homeState.timer); homeState.timer = null; }
  if (homeState.agoTimer) { clearInterval(homeState.agoTimer); homeState.agoTimer = null; }
}
// Pause when the app is backgrounded; resume on return if Home is showing.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopHomeTimer(); return; }
  const vis = id => byId(id)?.style.display !== 'none';
  if (vis('page-home')) startHomeTimer();
  // Timers paused while hidden only tick again on their next interval — refresh
  // the active view immediately on return so it isn't stale.
  else if (vis('page-journey') && currentJourneyData && !departAt) fetchJourneys(false);
  else if (vis('page-departures')) loadDepartures(false);
});
export function launchJourney(fn, fid, tn, tid) {
  state.from = { name: fn, id: fid }; state.to = { name: tn, id: tid };
  const fi = byId('from-input'), ti = byId('to-input');
  if (fi) { fi.value = fn; fi.classList.add('sel'); } if (ti) { ti.value = tn; ti.classList.add('sel'); }
  setClearBtn('from', true); setClearBtn('to', true);
  homeState.view = 'journey';
  switchTab('journey');
  document.body.classList.add('route-journey');
  _ovOpen('journey', _closeJourneyRoute);
  doSearch();
}
// Delegated launch (favourite + recent cards on the landing)
document.addEventListener('click', e => {
  const live = e.target.closest('[data-livestop]');
  if (live) { selectStop('dep', live.dataset.livename, live.dataset.livestop); switchTab('depart'); return; }
  const c = e.target.closest('[data-launch="1"]');
  if (!c) return;
  launchJourney(c.dataset.fn, c.dataset.fid, c.dataset.tn, c.dataset.tid);
});

// ════════════════════════════════════════════════════════════════════════════
// FAVOURITE STOPS  (Departures board quick-access)
// ════════════════════════════════════════════════════════════════════════════
export function getFavStops() { return _lsGetJSON('nsw_fav_stops', []); }
export function saveFavStops(a) { _lsSet('nsw_fav_stops', JSON.stringify(a)); }
export function isFavStop(id) { return !!id && getFavStops().some(s => s.id === id); }
export function toggleFavStop() {
  const s = state.dep; if (!s.id) return;
  let arr = getFavStops();
  arr = isFavStop(s.id) ? arr.filter(x => x.id !== s.id) : [{ name: s.name, id: s.id }, ...arr].slice(0, 12);
  saveFavStops(arr); renderFavStopChips(); updateDepStar();
}
export function removeFavStop(id) { saveFavStops(getFavStops().filter(s => s.id !== id)); renderFavStopChips(); updateDepStar(); }
export function renderFavStopChips() {
  const row = byId('fstop-row'); if (!row) return;
  const stops = getFavStops();
  if (!stops.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = 'flex';
  row.innerHTML = stops.map((s, i) =>
    `<div class="fstop-chip" data-fstop="${i}">🚏 <span class="fstop-name">${escAttr(cleanStationName(s.name))}</span><span class="fstop-x" data-fstopx="${escAttr(s.id)}">✕</span></div>`).join('');
}
export function updateDepStar() {
  const star = byId('dep-star'); if (!star) return;
  const on = isFavStop(state.dep.id);
  star.textContent = on ? '★' : '☆';
  star.setAttribute('aria-label', on ? t('tab_favs') : 'Save');
}
// Delegated clicks for favourite-stop chips
document.addEventListener('click', e => {
  const x = e.target.closest('[data-fstopx]');
  if (x) { e.stopPropagation(); removeFavStop(x.dataset.fstopx); return; }
  const chip = e.target.closest('.fstop-chip[data-fstop]');
  if (chip) { const s = getFavStops()[parseInt(chip.dataset.fstop, 10)]; if (s) selectStop('dep', s.name, s.id); }
});

// Show more / show less — expand a route's full timetable on the board
document.addEventListener('click', e => {
  const btn = e.target.closest('.dep-more-btn[data-gkey]');
  if (!btn) return;
  const key = btn.dataset.gkey;
  const row = btn.closest('.dep-row');
  if (depState.expanded.has(key)) {
    depState.expanded.delete(key);
    if (row) row.classList.remove('open');
    btn.textContent = '+' + btn.dataset.rest + ' ' + t('dep_more') + ' ⌄';
  } else {
    depState.expanded.add(key);
    if (row) row.classList.add('open');
    btn.textContent = t('dep_less') + ' ⌃';
  }
});
