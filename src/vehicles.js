// Live vehicle data: GTFS-RT vehicle positions cache, route matching, the
// leg-match debug helper, and the vehicle-position badge + carriage formation
// rendering. Imports primitives from core/i18n and cross-feature runtime fns from
// the app entry (circular but runtime-only).
import { byId, esc, safeUrl, PROXY, MOT_ICONS, REFRESH_MS, _evIsRealtime,
         state, jr, depState, trackState, homeState, svState, pref, nearbyState } from "./core.js";
import { t, i18n } from "./i18n.js";
import { getLineColors } from "./line_colors.js";
import { _ovOpen, _ovDismiss } from "./stops.js";
import { updateDepStar } from "./tracking.js";
import {
  SYD_TZ, _vpByRouteName, _vpByTripId, _vpEpochSum, _vpTripId, cleanStationName, delayBadge, delayMins, escAttr, fmt, isWalkLeg, legIsRealtime, platLabel, selectStop, serverReady, setServerReady, showOfflineCard, sydParts, timedFetch, tzNote, warmServer, z2,
} from "../app.js";
// ── Vehicle Positions ────────────────────────────────────────────────────────
// MOT product class → GTFS-RT vehiclepos feed slug(s). Some classes map to more
// than one feed: class 1 covers BOTH Sydney Trains ('trains') and NSW TrainLink
// intercity/regional ('nswtrains'), so we check both.
// (This was previously scrambled — class 1 → 'nswtrains' only, class 4/light-rail
// → 'trains', class 7 → 'lightrail' — so Sydney trains and light rail could never
// match a live vehicle and never showed LIVE.)
export const MOT_TO_VP_MODES = {
  1:  ['trains', 'nswtrains'],   // Sydney Trains + NSW TrainLink (both are class 1)
  2:  ['metro'],
  4:  ['lightrail'],
  5:  ['buses'],
  7:  ['regionbuses'],           // coaches — best-effort (often no live feed)
  9:  ['ferries'],
  11: ['buses', 'regionbuses'],  // school / region services
};
export function _vpModesFor(motClass) { return MOT_TO_VP_MODES[motClass] || []; }

// ── Console debug: why doesn't a leg match a live vehicle? ────────────────────
// Run in DevTools:  await vpDebug()           → inspects the open/last journey
//                   await vpDebug('lightrail')→ dumps a raw mode feed
// Prints the VP feed's trip_id/route_id samples next to each transit leg's ids
// and the match results, so you can see exactly where the formats diverge.
window.vpDebug = async function (mode) {
  if (typeof mode === 'string') {
    const vs = await loadVehiclePos(mode);
    console.group(`%cVP feed "${mode}" — ${vs?.length || 0} vehicles`, 'font-weight:bold');
    const withOcc = (vs || []).filter(v => v.occ).length;
    console.log(`%c${withOcc}/${vs?.length || 0} vehicles report occupancy`, 'color:#0a6fdc');
    (vs || []).slice(0, 12).forEach(v =>
      console.log({ trip_id: v.trip_id, route_id: v.route_id, occ: v.occ || '—', air_con: v.air_con, accessible: v.accessible }));
    console.groupEnd();
    return vs;
  }
  // Collect transit legs from every open/cached journey
  const legs = [];
  svState.stops.forEach(d => (d.legs || []).forEach(l => { if (!isWalkLeg(l)) legs.push(l); }));
  if (!legs.length) { console.warn('No journey legs cached. Open a journey (or its View details) first, then re-run vpDebug().'); return; }
  // Make sure every needed mode feed is loaded
  const modes = [...new Set(legs.flatMap(l => _vpModesFor(l.transportation?.product?.class)))];
  await Promise.all(modes.map(m => loadVehiclePos(m).catch(() => null)));
  console.group('%cVP feeds loaded', 'font-weight:bold');
  modes.forEach(m => console.log(m, '→', (_vpCache.get(m)?.vehicles || []).length, 'vehicles'));
  console.groupEnd();

  console.group('%cTransit legs vs live vehicles', 'font-weight:bold');
  legs.forEach(l => {
    const mot = l.transportation?.product?.class;
    const nm  = l.transportation?.disassembledName || l.transportation?.number;
    const rt  = _vpTripId(l);
    const tripHit  = _vpByTripId(rt, mot);
    const routeHit = _vpByRouteName(nm, mot);
    console.log({
      line: nm, motClass: mot, feeds: _vpModesFor(mot),
      RealtimeTripId: rt,
      legIsRealtime: legIsRealtime(l),
      tripIdMatch: !!tripHit,
      routeNameMatch: !!routeHit,
      sampleFeedRouteIds: JSON.stringify((_vpCache.get(_vpModesFor(mot)[0])?.vehicles || []).slice(0, 8).map(v => v.route_id)),
      sampleFeedTripIds:  JSON.stringify((_vpCache.get(_vpModesFor(mot)[0])?.vehicles || []).slice(0, 8).map(v => v.trip_id)),
    });
  });
  console.groupEnd();
  console.info('Tip: compare RealtimeTripId against sampleFeedTripIds, and the line (e.g. "L1"/"F1") against sampleFeedRouteIds — that shows which field to match on.');
};

// Client-side cache lives here and is referenced by both the VP functions and the stops view
export const _vpCache = new Map();
export const VP_CLIENT_TTL = 14000;

// Index vehicles by trip_id ONCE per fetch so _vpByTripId is O(1), not a linear
// .find() per leg per render. Buses feed is hundreds of vehicles; the journey
// list re-renders on refresh/VP-prefetch/i18n.lang toggle → this was O(renders×legs×N).
export function _indexByTrip(vehicles) {
  const m = new Map();
  for (const v of vehicles) if (v.trip_id && !m.has(v.trip_id)) m.set(v.trip_id, v);
  return m;
}
// O(1) route lookup: index every name vpMatchesRoute would accept for a vehicle,
// keeping the newest per key. Replaces the per-leg O(vehicles) scan in
// _vpByRouteName (buses feed ~1500 vehicles).
export function _indexByRoute(vehicles) {
  const m = new Map();
  const put = (k, v) => { if (!k) return; const e = m.get(k); if (!e || (v.ts || 0) > (e.ts || 0)) m.set(k, v); };
  for (const v of vehicles) {
    const rid = (v.route_id || '').toUpperCase();
    if (!rid) continue;
    put(rid, v);                                   // exact route_id
    const parts = rid.split(/[-_]/);
    for (const tk of parts) put(tk, v);            // any token (vpMatchesRoute's includes())
    const first = parts[0];
    if (!/^\d+$/.test(first)) {                    // rail: also the mapped prefix
      const mapped = _GTFS_ROUTE_PREFIX[first] || first;
      put(mapped, v);
    }
  }
  return m;
}

export async function loadVehiclePos(mode) {
  const cached = _vpCache.get(mode);
  if (cached && Date.now() - cached.ts < VP_CLIENT_TTL) return cached.vehicles;
  try {
    const r = await timedFetch(PROXY + '/vehiclepos?' + new URLSearchParams({ mode }), 20000);
    if (!r.ok) return null;
    const d = await r.json();
    const vehicles = d.vehicles || [];
    _vpCache.set(mode, { ts: Date.now(), vehicles, byTrip: _indexByTrip(vehicles), byRoute: _indexByRoute(vehicles) });
    return vehicles;
  } catch { return null; }
}

// GTFS-RT route_id prefix → TfNSW public line name.
// Sydney Trains uses coded prefixes (e.g. "APS" for Airport & East Hills = T8).
// Without this table, route matching fails for every line except T3.
// Source: TfNSW GTFS static routes.txt + open data portal.
export const _GTFS_ROUTE_PREFIX = {
  // Sydney Trains lines
  'APS':  'T8',   // Airport & East Hills Line
  'IWL':  'T2',   // Inner West & Leppington Line
  'ESI':  'T4',   // Eastern Suburbs & Illawarra Line
  'NSN':  'T1',   // North Shore Line → T1
  'WST':  'T1',   // Western Line → T1
  'NTH':  'T9',   // Northern Line → T9
  'CMB':  'T5',   // Cumberland Line → T5
  'OLY':  'T7',   // Olympic Park Line
  'BMT':  'BMT',  // Blue Mountains Line (intercity)
  'CCN':  'CCN',  // Central Coast & Newcastle Line
  'SCO':  'SCO',  // South Coast Line
  'SHL':  'SHL',  // Southern Highlands Line
  'CTY':  'CTY',  // Country / interstate
  'RTTA': null,   // Empty cars / non-revenue running — no passenger line
  // T3, T6 etc. already appear literally as "T3_*", "T6_*" and match via first===nm
};

// Match a GTFS-RT route_id against a TfNSW public line name.
//   Trains:  "APS_1a"  → prefix "APS" → mapped to "T8"   → matches nm="T8"
//            "T3_1a"   → prefix "T3"  → literal match     → matches nm="T3"
//   Buses:   "2508_144" → all-digit prefix → use last part → matches nm="144"
export function vpMatchesRoute(route_id, nm) {
  if (!route_id || !nm) return false;
  const rid = route_id.toUpperCase();
  const n   = nm.toUpperCase();
  if (rid === n) return true;
  // Token match: ferries use "9-F3-sj2-1", light rail "9-L1-...", buses "2508_144"
  // — the line name (F3 / L1 / 144) is one whole segment. Split on both - and _.
  // Exact-token only, so "F1" never matches "F10".
  if (rid.split(/[-_]/).includes(n)) return true;
  const parts = rid.split('_');
  const first = parts[0];
  const last  = parts[parts.length - 1];
  if (/^\d+$/.test(first)) {
    // Bus format: "2508_144" → route number is the last segment
    return last === n;
  }
  // Train/rail format: translate prefix via lookup table first
  const mapped = (_GTFS_ROUTE_PREFIX[first] || first);
  return mapped !== null && (mapped === n || first === n);
}

// After the departure board renders, fetch vehicle positions and inject GPS badges.
// Called async so it never blocks the initial render.
// ── Vehicle position badge + carriage formation ───────────────────────────────
export const _OCC_COLOR = {
  empty:'#22c55e', many:'#22c55e', few:'#eab308', standing:'#f97316',
  crowded:'#ef4444', full:'#dc2626',
};
export const _OCC_ICO = { empty:'🟢', many:'🟢', few:'🟡', standing:'🟠', crowded:'🔴', full:'🔴' };
export const _OCC_LBL = { empty:'Seats available', many:'Seats available', few:'Few seats', standing:'Standing room', crowded:'Crowded', full:'Full' };
export const _CONG_ICO = { stop_go:'🐢', congested:'⚠', severe:'🚨' };
export const _CONG_LBL = { smooth:'Running smoothly', stop_go:'Stop & go', congested:'Congestion', severe:'Severe congestion' };

export function _buildVpBadge(v, count) {
  const occIco  = _OCC_ICO[v.occ]    || '';
  const occLbl  = _OCC_LBL[v.occ]    || '';
  const congIco = _CONG_ICO[v.congestion] || '';
  const congLbl = _CONG_LBL[v.congestion] || '';

  let dest = '';
  if (v.label && v.label.includes(' to ') && v.label.length > 15) {
    const m = v.label.match(/to\s+(.+?)(?:\s+Station)?$/i);
    if (m) dest = m[1].trim();
  }

  const titleParts = [
    `${count} vehicle${count > 1 ? 's' : ''} tracked`,
    occLbl, congLbl,
    dest ? `→ ${dest}` : '',
    v.model || '',
    v.carriages ? `${v.carriages} carriages` : '',
    v.air_con ? 'Air conditioned' : '',
    v.accessible ? 'Wheelchair accessible' : '',
    v.prior_trip ? 'Running prior trip' : '',
  ].filter(Boolean).join(' · ');

  const carr = v.carriages ? ` · ${v.carriages} car` : '';
  const a11y = v.accessible ? ' ♿' : '';
  const ac   = v.air_con    ? ' ❄' : '';
  const inline = [occIco, congIco].filter(Boolean).join('');

  // Formation diagram (shown inline if carriages ≤ 10)
  const formation = v.formation?.length ? _buildFormationInline(v.formation) : '';

  return `<span class="vp-badge" title="${titleParts}"><span class="vp-dot"></span>GPS${inline}${carr}${a11y}${ac}</span>${formation}`;
}

export function _buildFormationInline(formation) {
  // Compact carriage dots for departures board
  const cars = formation.map(c => {
    const col = _OCC_COLOR[c.occ] || '#94a3b8';
    const icons = [c.quiet ? '🔇' : '', c.toilet ? '🚻' : ''].filter(Boolean).join('');
    return `<span class="vp-car" style="background:${col}" title="Car ${c.pos}${icons ? ' · ' + icons.replace('🔇','Quiet').replace('🚻','Toilet') : ''}">${icons || ''}</span>`;
  }).join('');
  return `<span class="vp-formation">${cars}</span>`;
}

export function _buildFormationFull(formation, model, accessible, airCon) {
  // Compact, single-row carriage indicator: one streamlined segmented bar instead
  // of 8 tall blocks. Amenities + a legend (only for the occupancy states actually
  // present) sit on one foot row, so the whole thing is ~2 rows tall, not ~5.
  if (!formation?.length) return '';

  const segs = formation.map(c => {
    const col    = _OCC_COLOR[c.occ] || '#94a3b8';
    const occLbl = _OCC_LBL[c.occ]  || 'No data';
    const marks  = [c.quiet ? '🔇' : '', c.toilet ? '🚻' : '', c.luggage ? '🧳' : ''].filter(Boolean).join('');
    const title  = `Car ${c.pos} · ${occLbl}${marks ? ' · ' + marks.replace(/🔇/g,'Quiet').replace(/🚻/g,'Toilet').replace(/🧳/g,'Luggage') : ''}`;
    return `<div class="sv-car-seg" style="background:${col}" title="${title}"><span class="sv-car-seg-n">${c.pos}</span>${marks ? `<span class="sv-car-seg-m">${marks}</span>` : ''}</div>`;
  }).join('');

  // Carriage-level amenities only. A/C and ♿ are already shown as chips in the
  // service header, so they're not repeated here. Quiet/Toilet/Luggage are
  // per-carriage facts (intercity trains) that only the consist data knows.
  const amenities = [];
  if (formation.some(c => c.quiet))    amenities.push('🔇 Quiet');
  if (formation.some(c => c.toilet))   amenities.push('🚻 Toilet');
  if (formation.some(c => c.luggage))  amenities.push('🧳 Luggage');

  // Legend only for occupancy states actually present (all-seats ⇒ one item).
  // 'empty' and 'many' both mean "seats available" (green) — fold them together so
  // we never show a duplicate or an unlabelled ("undefined") entry.
  const ORDER = ['many', 'few', 'standing', 'crowded', 'full'];
  const present = [...new Set(formation.map(c => (c.occ === 'empty' ? 'many' : c.occ)).filter(Boolean))]
    .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  const legend = present.map(o =>
    `<span class="sv-leg-item"><span class="sv-leg-dot" style="background:${_OCC_COLOR[o]}"></span>${_OCC_LBL[o] || ''}</span>`).join('');

  return `<div class="sv-formation-wrap">
    <div class="sv-formation-bar" aria-label="${formation.length} carriage formation">${segs}</div>
    <div class="sv-formation-foot">
      <span class="sv-formation-count">🚃 ${formation.length} cars</span>
      ${amenities.map(a => `<span class="sv-formation-am">${a}</span>`).join('')}
      ${legend ? `<span class="sv-formation-spacer"></span>${legend}` : ''}
    </div>
  </div>`;
}

export async function applyVehiclePositions() {
  const resEl = byId('depart-results');
  if (!resEl) return;

  // Detect which modes are present in the current board
  const rows = [...resEl.querySelectorAll('.dep-row[data-vp-mot]')];
  if (!rows.length) return;

  // data-vp-mot may carry several comma-separated feed slugs (e.g. "trains,nswtrains")
  const modesPresent = [...new Set(rows.flatMap(r => (r.dataset.vpMot || '').split(',').filter(Boolean)))];
  const modeMap = {};
  await Promise.all(modesPresent.map(async mode => {
    const vehicles = await loadVehiclePos(mode);
    if (vehicles) modeMap[mode] = vehicles;
  }));

  // Annotate each row
  rows.forEach(row => {
    const modes   = (row.dataset.vpMot || '').split(',').filter(Boolean);
    const nm      = (row.dataset.vpRoute || '').toUpperCase();
    const vehicles = modes.flatMap(m => modeMap[m] || []);
    const matched = vehicles.filter(v => vpMatchesRoute(v.route_id, nm));
    const spot = row.querySelector('.vp-spot');
    if (!spot || !matched.length) return;

    // Pick the most recently updated vehicle
    const best = matched.reduce((a, b) => ((b.ts || 0) > (a.ts || 0) ? b : a));
    spot.innerHTML = _buildVpBadge(best, matched.length);
  });

  // Update board header with total count
  const allVehicles = Object.values(modeMap).flat();
  const pill = byId('vp-count-pill');
  if (pill && allVehicles.length) {
    pill.innerHTML = `<span class="vp-count-dot"></span>${allVehicles.length} vehicles tracked`;
    pill.style.display = 'inline-flex';
  }
}


// Mode filter for the board (mirrors the journey mode pills, but independent)
export function setDepMode(el, x) {
  depState.mode = x;
  document.querySelectorAll('#page-depart .mb').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  if (!state.dep.id) return;
  clearTimeout(depState.modeTimer);
  depState.modeTimer = setTimeout(() => loadDepartures(false), 250);
}

export async function loadDepartures(scroll = false) {
  const stop = state.dep;
  if (!stop.id) return;
  const resEl = byId('depart-results');
  if (!resEl) return;

  // Is a board already on screen? (vs. a fresh first load)
  const fresh = !resEl.querySelector('.dep-row') && !resEl.querySelector('.refresh-bar');

  // Offline: only wipe to the offline card on a fresh load; otherwise keep the
  // last board but mark it stale so old countdowns aren't trusted as live.
  if (!navigator.onLine) {
    if (fresh) showOfflineCard(resEl); else setDepStale(true);
    return;
  }

  if (fresh) resEl.innerHTML = `<div class="spin-wrap"><div class="spin"></div>${t('searching')}</div>`;

  if (!serverReady) { await warmServer().catch(() => {}); }

  // Send the browser's local time (real Sydney time for the user) so the request
  // is correctly anchored even if the proxy host runs in another timezone.
  const sp = sydParts(new Date());
  const p = {
    stop: stop.id,
    itdDate: `${sp.year}${z2(sp.month)}${z2(sp.day)}`,
    itdTime: `${z2(sp.hour)}${z2(sp.minute)}`,
  };
  if (depState.mode) p.excl = depState.mode;

  try {
    const r = await timedFetch(PROXY + '/depart?' + new URLSearchParams(p));
    if (!r.ok) { if (fresh) resEl.innerHTML = `<div class="err">Error ${r.status}</div>`; else setDepStale(true); return; }
    setServerReady(true);
    const data = await r.json();
    renderDepartures(data, scroll);   // clears any stale state on success
    // (re)arm auto-refresh only while the tab is visible
    clearInterval(depState.timer);
    depState.timer = setInterval(() => { if (!document.hidden) loadDepartures(false); }, REFRESH_MS);
  } catch (e) {
    if (fresh) {
      const isTimeout = e.name === 'AbortError';
      resEl.innerHTML = `<div class="err" style="flex-direction:column;align-items:flex-start;gap:10px">
        <span>⚠ ${isTimeout ? t('err_timeout') : e.message}</span>
        <button class="retry-btn" onclick="loadDepartures(true)">${t('err_retry')}</button>
      </div>`;
    } else {
      setDepStale(true);   // keep the last board visible, but dimmed + flagged
    }
  }
}

// Dim the board and show a notice when a background refresh fails — so a stale
// "Due"/"3 min" isn't mistaken for a live time.
export function setDepStale(on) {
  const resEl = byId('depart-results');
  if (!resEl) return;
  resEl.classList.toggle('dep-stale', on);
  let note = byId('dep-stale-note');
  if (on) {
    if (!note) {
      note = document.createElement('div');
      note.id = 'dep-stale-note';
      note.className = 'dep-stale-note';
      const bar = resEl.querySelector('.refresh-bar');
      if (bar && bar.nextSibling) resEl.insertBefore(note, bar.nextSibling);
      else resEl.insertBefore(note, resEl.firstChild);
    }
    note.textContent = t('dep_stale');
  } else if (note) {
    note.remove();
  }
}

// Minutes from now → friendly countdown text + colour class
export function countdown(estIso) {
  const mins = Math.round((new Date(estIso) - new Date()) / 60000);
  if (mins < -1)  return { big: String(Math.abs(mins)), sub: 'min ago', cls: 'gone' };
  if (mins <= 0)  return { big: t('dep_due'), sub: '', cls: 'due' };
  if (mins < 60)  return { big: String(mins), sub: t('dep_min'), cls: mins <= 3 ? 'soon' : '' };
  const h = Math.floor(mins / 60), m = mins % 60;
  return { big: h + 'h' + (m ? ' ' + m + 'm' : ''), sub: '', cls: '' };
}
// How many whole days ahead a departure is, in Sydney (0 = today, 1 = tomorrow…)
export function daysAhead(d) {
  const a = sydParts(new Date()), b = sydParts(d);
  const da = Date.UTC(a.year, a.month - 1, a.day);
  const db = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((db - da) / 86400000);
}
export function dayLabel(d) {
  const diff = daysAhead(d);
  if (diff <= 0) return null;
  if (diff === 1) return i18n.lang === 'ko' ? '내일' : 'Tomorrow';
  return new Intl.DateTimeFormat(i18n.lang === 'ko' ? 'ko-KR' : 'en-AU',
    { timeZone: SYD_TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}


// Advance the countdown text/classes in place — no innerHTML rebuild. Driven off
// data-est on each row/sub so times stay live between (and instead of) rebuilds.
export function _refreshDepCountdowns(root) {
  if (!root) return;
  root.querySelectorAll('.dep-row[data-est]').forEach(row => {
    const cd = countdown(row.dataset.est);
    const delay = +row.dataset.delay || 0;
    const c = row.querySelector('.dep-count');
    if (c) { c.textContent = cd.big; c.className = 'dep-count ' + cd.cls; }
    const right = row.querySelector('.dep-right');
    let clk = row.querySelector('.dep-clock');
    if (cd.sub) {
      if (!clk && right) { clk = document.createElement('div'); clk.className = 'dep-clock'; right.appendChild(clk); }
      if (clk) clk.textContent = cd.sub;
    } else if (clk) { clk.remove(); }
    const rowCls = cd.cls === 'gone' ? 'gone-row' : (delay > 0 ? 'late' : (cd.cls === 'due' ? 'due' : ''));
    row.className = 'dep-row ' + rowCls + (row.classList.contains('open') ? ' open' : '');
  });
  root.querySelectorAll('.dep-sub[data-est]').forEach(sub => {
    const ecd = countdown(sub.dataset.est);
    const r = sub.querySelector('.dep-sub-rel');
    if (r) { r.textContent = ecd.big + (ecd.sub ? ' ' + ecd.sub : ''); r.className = 'dep-sub-rel ' + ecd.cls; }
  });
}
export function _startDepCountTicker(root) {
  clearInterval(depState.countTimer);
  depState.countTimer = setInterval(() => {
    if (document.hidden) return;
    const el = byId('depart-results');
    if (!el || el.style.display === 'none') return;
    _refreshDepCountdowns(el);
  }, 15000);
}

export function renderDepartures(data, scroll = false) {
  const resEl = byId('depart-results');
  if (!resEl) return;
  const events = data?.stopEvents || [];
  const stopName = cleanStationName(state.dep.name);
  const empty = () => `<div class="state"><div class="state-ic">🌙</div>
      <div class="state-t">${stopName}</div>
      <div class="state-s">${t('dep_none')}</div>
      <button class="retry-btn" style="margin-top:14px" onclick="loadDepartures(true)">${t('err_retry')}</button></div>`;

  if (!events.length) { resEl.innerHTML = empty(); return; }

  // Let TfNSW decide what's still coming. We re-poll every 30s with the current
  // time, so a late service stays in the feed (with its live estimate) and only
  // disappears once TfNSW drops it — i.e. once it has actually left. The cutoff is
  // NOT a "grace" timer; it's a sanity backstop that rejects only wildly-stale data
  // (>5 min past), which can only happen if a server clock is wrong. Anything the
  // feed still lists within that window is shown — we don't second-guess lateness.
  // No tight cap: we show every service the API returns (the feed is already bounded),
  // grouped by line. A high safety slice only guards against a runaway response.
  const cutoff = Date.now() - 1200000; // 20 min — include recently departed services
  const evs = events
    .filter(ev => new Date(ev.departureTimeEstimated || ev.departureTimePlanned).getTime() >= cutoff)
    .sort((a, b) => new Date(a.departureTimeEstimated || a.departureTimePlanned)
                  - new Date(b.departureTimeEstimated || b.departureTimePlanned))
    .slice(0, 100);

  if (!evs.length) { resEl.innerHTML = empty(); return; }

  depState.lastFetch = Date.now();

  // Group by line + destination so a route that repeats every 30 min doesn't fill
  // the screen with near-identical rows. Groups stay ordered by soonest departure
  // (evs is already chronological, so first-seen order is correct).
  const groups = [];
  const gIndex = {};
  evs.forEach(ev => {
    const tr = ev.transportation || {};
    const key = (tr.disassembledName || tr.number || '') + '|' +
                (tr.destination?.name || tr.destination || '') + '|' + (tr.product?.class || 0);
    if (gIndex[key] == null) { gIndex[key] = groups.length; groups.push([]); }
    groups[gIndex[key]].push(ev);
  });

  // Skip the full rebuild when the feed is unchanged (same services / delays /
  // expanded state / vehicle data). Countdowns still advance via the in-place
  // ticker below, so freezing the DOM is safe and avoids reparsing the board.
  const _vpEpoch = _vpEpochSum();
  const depSig = groups.map(g => {
    const ev = g[0], tr = ev.transportation || {};
    return (tr.disassembledName || tr.number || '') + '|' + (tr.destination?.name || '')
         + '|' + (ev.departureTimeEstimated || ev.departureTimePlanned) + '|' + g.length;
  }).join(',') + '#' + [...depState.expanded].join(',') + '@' + _vpEpoch;
  depState.lastFetch = Date.now();
  if (!scroll && depSig === depState.sig && resEl.querySelector('.dep-row')) {
    _refreshDepCountdowns(resEl);          // just tick the times; keep the DOM
    _startDepCountTicker(resEl);
    return;
  }
  depState.sig = depSig;

  const nLines = groups.length;
  let html = `<div class="refresh-bar fadein">
    <div class="rtitle">🚏 ${cleanStationName(stopName)}</div>
    <div class="refresh-bar-row">
      <div class="rsub"><span id="dep-updated">${t('updated_now')}</span> · ${nLines} ${nLines === 1 ? t('dep_line') : t('dep_lines')} <span class="tz-tag" title="${t('syd_note')}">🕑 ${tzNote()}</span></div>
      <div class="refresh-bar-actions">
        <span class="vp-count-pill" id="vp-count-pill" style="display:none"></span>
        <button class="dep-star" id="dep-star" onclick="toggleFavStop()" aria-label="Save">☆</button>
        <button class="refresh-btn" onclick="manualRefreshDepart(this)" aria-label="Refresh"><span>↻</span></button>
        <div class="auto-badge"><span class="ldot"></span></div>
      </div>
    </div>
  </div>`;

  let lastDay = 0;
  groups.forEach((g, i) => {
    const ev   = g[0];                       // soonest departure for this line
    const tr   = ev.transportation || {};
    const mot  = tr.product?.class || 0;
    const nm   = tr.disassembledName || tr.number || '';
    const dest = tr.destination?.name || tr.destination || '';
    const { bg, fg } = getLineColors(mot, nm);
    const icon = MOT_ICONS[mot] || '🚌';

    const planned = ev.departureTimePlanned;
    const est     = ev.departureTimeEstimated || planned;
    const estDate = new Date(est);
    const delay   = delayMins(planned, est);
    const rt      = _evIsRealtime(ev);
    const cd      = countdown(est);

    // Day separator when the soonest departure rolls into a new day
    const d = daysAhead(estDate);
    if (d !== lastDay) {
      const lbl = dayLabel(estDate);
      if (lbl) html += `<div class="dep-day-sep"><span>${lbl}</span></div>`;
      lastDay = d;
    }

    const plat = platLabel(ev.location?.name || '', ev.location?.disassembledName || '', ev.location, mot);
    const rowCls = cd.cls === 'gone' ? 'gone-row' : (delay > 0 ? 'late' : (cd.cls === 'due' ? 'due' : ''));

    // Follow-up departures of the same line
    const gkey = nm + '|' + dest + '|' + mot;
    const rest = g.slice(1);
    const open = depState.expanded.has(gkey);

    let moreHtml = '';
    if (rest.length) {
      const preview = rest.slice(0, 4).map(e => fmt(e.departureTimeEstimated || e.departureTimePlanned)).join(' · ');
      const hiddenMore = rest.length > 4;
      const btn = `<button class="dep-more-btn" data-gkey="${escAttr(gkey)}" data-rest="${rest.length}">${
        open ? t('dep_less') + ' ⌃' : '+' + rest.length + ' ' + t('dep_more') + ' ⌄'}</button>`;
      moreHtml = `<div class="dep-more">
        <span class="dep-more-preview">${t('dep_then')} ${preview}${hiddenMore ? ' …' : ''}</span>${btn}</div>`;
    }

    // Expanded detail: every follow-up with its own live time, countdown, platform & delay
    let subHtml = '';
    if (rest.length) {
      subHtml = `<div class="dep-sub-list">` + rest.map(e => {
        const ep = e.departureTimePlanned, ee = e.departureTimeEstimated || ep;
        const ecd = countdown(ee), ed = delayMins(ep, ee);
        const ert = _evIsRealtime(e);
        const epl = platLabel(e.location?.name || '', e.location?.disassembledName || '', e.location, mot);
        return `<div class="dep-sub" data-est="${ee}">
          <span class="dep-sub-time">${fmt(ee)}</span>
          <span class="dep-sub-rel ${ecd.cls}">${ecd.big}${ecd.sub ? ' ' + ecd.sub : ''}</span>
          ${epl ? `<span class="dep-sub-plat">${epl}</span>` : ''}
          ${delayBadge(ed)}
          ${ert ? `<span class="dep-rt-dot" title="Real-time"></span>` : ''}
        </div>`;
      }).join('') + `</div>`;
    }

    // vpMode: GTFS-RT feed slug(s) for this MOT class (comma-joined if more than one)
    const vpMode = _vpModesFor(mot).join(',');
    html += `<div class="dep-row ${rowCls}${open ? ' open' : ''}"
      style="--line-accent:${bg};animation-delay:${Math.min(i, 8) * 0.04}s"
      data-vp-mot="${vpMode}" data-vp-route="${escAttr(nm)}" data-est="${est}" data-delay="${delay}">
      <div class="dep-row-top">
        <div class="dep-line-wrap">
          <span class="dep-line" style="background:${bg};color:${fg}">${nm || icon}</span>
        </div>
        <div class="dep-mid">
          <div class="dep-dest"><span class="dep-to">→</span>${dest || stopName}</div>
          <div class="dep-meta">
            ${plat ? `<span class="dep-plat">${plat}</span>` : ''}
            <span>${fmt(est)}</span>
            ${delayBadge(delay)}
            ${rt ? `<span class="dep-rt-dot" title="Real-time"></span>` : ''}
            <span class="vp-spot"></span>
          </div>
        </div>
        <div class="dep-right">
          <div class="dep-count ${cd.cls}">${cd.big}</div>
          ${cd.sub ? `<div class="dep-clock">${cd.sub}</div>` : ''}
        </div>
      </div>
      ${moreHtml}
      ${subHtml}
    </div>`;
  });

  resEl.innerHTML = html;
  resEl.classList.remove('dep-stale');
  updateDepStar();
  // Fetch vehicle positions in background and inject GPS badges (non-blocking)
  applyVehiclePositions();

  // Live "updated Xs ago" ticker
  _startDepCountTicker(resEl);   // keep countdowns live between 30 s feed polls

  clearInterval(depState.updTimer);
  depState.updTimer = setInterval(() => {
    const el = byId('dep-updated');
    if (!el || !depState.lastFetch) return;
    const secs = Math.round((Date.now() - depState.lastFetch) / 1000);
    el.textContent = secs < 10 ? t('updated_now')
                   : secs < 60 ? t('updated_secs').replace('{n}', secs)
                   : t('updated_mins').replace('{n}', Math.round(secs / 60));
  }, 10000);

  if (scroll) setTimeout(() => {
    const first = resEl.querySelector('.dep-row');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 120);
}

// ════════════════════════════════════════════════════════════════════════════
// NEARBY STOPS  (geolocation → /coord)
// context: 'from' | 'to' | 'dep'
// ════════════════════════════════════════════════════════════════════════════

export function setLocating(context, on) {
  if (context === 'dep') byId('dep-gps')?.classList.toggle('locating', on);
  else byId('from-loc-chip')?.classList.toggle('locating', on);
}

export function openNearby() {
  byId('near-overlay').classList.add('show');
  byId('near-sheet').style.display = 'block';
  _ovOpen('near', _closeNearbyDom);
}
export function closeNearby() {
  if (_ovDismiss('near')) return;
  _closeNearbyDom();
}
export function _closeNearbyDom() {
  byId('near-overlay').classList.remove('show');
  byId('near-sheet').style.display = 'none';
}

export function findNearby(context) {
  nearbyState.ctx = context;
  openNearby();
  const content = byId('near-content');

  // Geolocation needs a secure context (https). On file:// or http:// the browser
  // reports "denied" even when device location is on — explain that specifically.
  if (!('geolocation' in navigator)) {
    content.innerHTML = `<div class="near-msg"><span class="near-msg-ic">📍</span>${t('near_unavail')}</div>`;
    return;
  }
  if (!window.isSecureContext) {
    content.innerHTML = `<div class="near-msg"><span class="near-msg-ic">🔒</span>${t('near_insecure')}</div>`;
    return;
  }

  setLocating(context, true);
  content.innerHTML = `<div class="near-loading"><div class="spin"></div>${t('near_locating')}</div>`;

  let _gotFix = false;   // guard: the multi-attempt chain must only handle one fix
  const onOk = async pos => {
    if (_gotFix) return;
    _gotFix = true;
    setLocating(context, false);
    // Got the device location fine — from here any failure is the SERVER (/coord on
    // Render), so show a server-specific message, not "couldn't get your location".
    content.innerHTML = `<div class="near-loading"><div class="spin"></div>${t('near_searching')}</div>`;
    try {
      const { latitude: lat, longitude: lng } = pos.coords;
      if (!serverReady) await warmServer().catch(() => {});
      const r = await timedFetch(PROXY + '/coord?' + new URLSearchParams({ lat, lng }), 35000);
      if (!r.ok) throw new Error('coord ' + r.status);
      const d = await r.json();
      renderNearby(d?.locations || []);
    } catch (e) {
      console.warn('[nearby] /coord failed:', e);
      content.innerHTML = `<div class="near-msg"><span class="near-msg-ic">📡</span>${t('near_server')}
        <br><button class="retry-btn" style="margin-top:12px" onclick="findNearby('${context}')">${t('err_retry')}</button></div>`;
    }
  };
  const onFail = async err => {
    setLocating(context, false);
    console.warn('[nearby] geolocation failed:', err && err.code, err && err.message);
    // Cross-check the actual permission state — some browsers return code 1 on a
    // timeout, which previously showed a false "enable location" message even when
    // the user had granted it. Only show the enable message if it's truly denied.
    let denied = err && err.code === 1;
    try {
      if (navigator.permissions?.query) {
        const st = await navigator.permissions.query({ name: 'geolocation' });
        denied = st.state === 'denied';
      }
    } catch {}
    if (denied) {
      content.innerHTML = `<div class="near-msg"><span class="near-msg-ic">📍</span>${t('near_denied')}</div>`;
    } else {
      // Timeout / position unavailable / granted-but-failed — offer a retry, not "enable"
      content.innerHTML = `<div class="near-msg"><span class="near-msg-ic">📡</span>${t('near_unavail')}
        <br><button class="retry-btn" style="margin-top:12px" onclick="findNearby('${context}')">${t('err_retry')}</button></div>`;
    }
  };

  // Try a fast high-accuracy fix; if it times out / is unavailable (NOT denied),
  // fall back to a low-accuracy fix with a much longer timeout and a generous
  // maximumAge so a recent cached fix is accepted instead of timing out again.
  // This resolves most code-3 ("timed out") cases — no GPS lock, indoors, desktop
  // on Wi-Fi/IP geolocation, which is slow and benefits from the longer window.
  // 1) High-accuracy fix (10 s) → 2) low-accuracy long fallback (30 s, accepts a
  //    fix up to 10 min old). Only "permission denied" (code 1) skips straight to
  //    the failure message; timeouts fall through to the next attempt.
  const highThenLow = () => navigator.geolocation.getCurrentPosition(onOk, err1 => {
    if (err1 && err1.code === 1) { onFail(err1); return; }
    navigator.geolocation.getCurrentPosition(onOk, onFail,
      { enableHighAccuracy: false, timeout: 30000, maximumAge: 600000 });
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });

  // 0) Instant: if the browser already holds a recent fix, use it with no wait.
  //    (Big win on desktop / repeat use, where acquiring fresh often times out.)
  navigator.geolocation.getCurrentPosition(onOk, () => highThenLow(),
    { enableHighAccuracy: false, timeout: 8000, maximumAge: Infinity });
}

export function renderNearby(locations) {
  // Keep real stops, nearest first
  const stops = locations
    .filter(l => l.type === 'stop' || l.type === 'platform' || l.properties?.stopId)
    .sort((a, b) => (a.properties?.distance || 1e9) - (b.properties?.distance || 1e9))
    .slice(0, 10);

  if (!stops.length) {
    byId('near-content').innerHTML =
      `<div class="near-msg"><span class="near-msg-ic">🤷</span>${t('near_none')}</div>`;
    return;
  }

  nearbyState.data = stops;
  const fmtDist = m => m == null ? '' : (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

  byId('near-content').innerHTML = stops.map((s, i) => {
    const icons = [...new Set((s.productClasses || []).map(c => MOT_ICONS[+c] || '').filter(Boolean))].join('') || '🚉';
    const dist  = fmtDist(s.properties?.distance);
    const esc   = (s.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="near-item" data-nidx="${i}">
      <span class="near-ic">${icons}</span>
      <div class="near-body">
        <div class="near-name">${esc}</div>
        ${dist ? `<div class="near-sub"><span class="near-dist">${dist}</span></div>` : ''}
      </div>
      <span class="near-go">›</span>
    </div>`;
  }).join('');
}

// Event delegation for nearby picks
document.addEventListener('click', e => {
  const item = e.target.closest('.near-item[data-nidx]');
  if (!item) return;
  const s = nearbyState.data[parseInt(item.dataset.nidx, 10)];
  if (!s) return;
  const id = s.properties?.stopId || s.id;
  selectStop(nearbyState.ctx, s.name, id);   // for 'dep' this also loads the board
  closeNearby();
});

