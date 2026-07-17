// ─────────────────────────────────────────────────────────────────────────────
// Route live map — shows ONE selected service on a Leaflet map: its full stop
// path (stops already passed vs. stops still to come) plus its live position.
// Used by the Departures ▸ Route tab. One map instance is kept alive across the
// 30s auto-refresh so tiles aren't reloaded each poll — we only move the marker
// and recolour the passed/upcoming split.
//
// Data: the vehicle's live lat/lng + its trip's stop list from /gtfstrip
// (returns name + lat/lon per stop). "Passed vs upcoming" is decided by the stop
// nearest the live position, not GTFS stop_sequence (which /gtfstrip re-indexes).
//
// Tiles: CartoDB Positron (light) / Dark Matter (dark). Cross-origin → host is
// whitelisted in the CSP (img-src) and passed straight through by the SW.
// ─────────────────────────────────────────────────────────────────────────────
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { esc } from './core.js';

const SYD = [-33.8688, 151.2093];
const LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const ATTR  = '© OpenStreetMap © CARTO';
const PAST  = '#9aa3b2';   // stops already passed (grey)

let _map = null, _tiles = null;
let _pathLayer = null, _vehLayer = null;

function _isDark() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

function _vehIcon(v, bg, fg) {
  const moving = v.status === 'in_transit';
  const inner = (moving && v.bearing != null)
    ? `<span class="rm-arrow" style="transform:rotate(${Math.round(v.bearing)}deg)">▲</span>`
    : `<span class="rm-dot"></span>`;
  return L.divIcon({
    className: 'rm-marker',
    html: `<span class="rm-pin ${moving ? 'is-moving' : ''}" style="background:${bg};color:${fg};border-color:${fg}">${inner}</span>`,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
}

function _ensureMap(el) {
  if (_map && _map._container === el) return;
  if (_map) { try { _map.remove(); } catch { /* noop */ } _map = null; }
  _map = L.map(el, {
    zoomControl: true, attributionControl: true,
    scrollWheelZoom: false, tap: true, center: SYD, zoom: 12,
  });
  _tiles = L.tileLayer(_isDark() ? DARK : LIGHT, { attribution: ATTR, maxZoom: 18, detectRetina: true }).addTo(_map);
  _pathLayer = L.layerGroup().addTo(_map);
  _vehLayer  = L.layerGroup().addTo(_map);
}

// nearest stop index to the live vehicle position (squared planar dist is fine at
// city scale) — everything before it is "passed", from it on is "upcoming".
function _nearestIdx(stops, lat, lng) {
  let best = 0, bd = Infinity;
  stops.forEach((s, i) => {
    const d = (s.lat - lat) ** 2 + (s.lon - lng) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// Draw the selected service. `stops` may be null (not loaded yet) → we still plot
// the live marker so the map isn't blank while /gtfstrip is in flight.
export function showService(id, veh, stops, colors, opts) {
  const el = document.getElementById(id);
  if (!el || !L || !veh) return;
  const { bg = '#4F46E5', fg = '#ffffff' } = colors || {};
  const fresh = !!(opts && opts.fresh);
  _ensureMap(el);

  const wantUrl = _isDark() ? DARK : LIGHT;
  if (_tiles && _tiles._url !== wantUrl) _tiles.setUrl(wantUrl);

  _pathLayer.clearLayers();
  _vehLayer.clearLayers();

  const valid = (stops || []).filter(s => s.lat && s.lon);
  const hasVeh = veh.lat != null && veh.lng != null;
  let focus = [];   // points to frame the view around the service

  if (valid.length && hasVeh) {
    const cut = _nearestIdx(valid, veh.lat, veh.lng);
    const line = valid.map(s => [s.lat, s.lon]);
    // passed segment (grey) then upcoming segment (line colour); share the cut node
    if (cut > 0) L.polyline(line.slice(0, cut + 1), { color: PAST, weight: 4, opacity: 0.7 }).addTo(_pathLayer);
    L.polyline(line.slice(cut), { color: bg, weight: 5, opacity: 0.95 }).addTo(_pathLayer);

    // Frame a window around the vehicle so nearby stop names are legible, rather
    // than fitting the whole (often very long) route and zooming right out.
    const lo = Math.max(0, cut - 2), hi = Math.min(valid.length - 1, cut + 8);

    valid.forEach((s, i) => {
      const passed = i < cut;
      const isEnd = i === 0 || i === valid.length - 1;
      const r = isEnd ? 6 : 4;
      const col = passed ? PAST : bg;
      const cm = L.circleMarker([s.lat, s.lon], {
        radius: r, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1,
      }).addTo(_pathLayer);
      // Always-on name label only for the approaching (next) stop + the two
      // terminals — keeps labels from colliding. Hover/tap reveals the rest.
      const nm = esc(s.name || '');
      const perm = isEnd || i === cut;
      cm.bindTooltip(nm, {
        permanent: perm, direction: i === 0 ? 'right' : (i === valid.length - 1 ? 'left' : 'top'),
        offset: i === cut ? [0, -6] : [0, 0], opacity: 0.95,
        className: `rm-tip${passed ? ' rm-tip-past' : ''}${perm ? ' rm-tip-key' : ''}`,
      });
      if (i >= lo && i <= hi) focus.push([s.lat, s.lon]);
    });
  }

  if (hasVeh) {
    const moving = veh.status === 'in_transit';
    L.marker([veh.lat, veh.lng], { icon: _vehIcon(veh, bg, fg), keyboard: false, zIndexOffset: 1000 })
      .bindPopup(`<div class="rm-pop"><strong>${moving ? 'Moving' : 'Stopped'}</strong>`
        + (veh.model ? `<span class="rm-pop-sub">${esc(String(veh.model).replace(/~/g, ' '))}</span>` : '')
        + `</div>`)
      .addTo(_vehLayer);
    focus.push([veh.lat, veh.lng]);
  }

  if (focus.length && fresh) {
    if (focus.length === 1) _map.setView(focus[0], 15);
    else _map.fitBounds(focus, { padding: [34, 34], maxZoom: 16 });
  }
  setTimeout(() => { try { _map && _map.invalidateSize(); } catch { /* noop */ } }, 60);
}

export function destroyRouteMap() {
  if (_map) { try { _map.remove(); } catch { /* noop */ } }
  _map = _tiles = _pathLayer = _vehLayer = null;
}
