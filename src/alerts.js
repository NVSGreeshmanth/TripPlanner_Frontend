// Alerts (GTFS-RT v2) — strip + expandable panel. Imports core/i18n primitives
// plus three runtime-only helpers from the app entry (timedFetch, _ovOpen,
// _ovDismiss). Those create a circular import with app.js, which is safe because
// they're only CALLED at runtime (fetch / click), never during module evaluation.
import { byId, esc, safeUrl, PROXY } from './core.js';
import { t } from './i18n.js';
import { timedFetch } from '../app.js';
import { _ovOpen, _ovDismiss } from './stops.js';

let alerts = []; let alertOpen = false;

const _ALERT_SEV_ICON = { severe: '🚨', warning: '⚠️', info: 'ℹ️' };
const _ALERT_SEV_CLS  = { severe: 'alert-sev-severe', warning: 'alert-sev-warning', info: 'alert-sev-info' };
const _EFFECT_SHORT = {
  'No service': 'No service', 'Reduced service': 'Reduced service',
  'Significant delays': 'Delays', 'Detour': 'Detour',
  'Modified service': 'Modified', 'Additional service': 'Extra services',
  'Accessibility issue': 'Accessibility',
};

export async function loadAlerts() {
  try {
    const r = await timedFetch(PROXY + '/alerts'); if (!r.ok) return;
    const d = await r.json();
    alerts = Array.isArray(d?.alerts) ? d.alerts : [];
    renderAlerts();
  } catch {}
}

// Effect ranking. The feed's `severity` is useless (all 240 live alerts are
// "info"), so rank on what it actually varies: effect. Lower = worse.
const _EFFECT_RANK = {
  'No service': 0, 'Significant delays': 1, 'Reduced service': 2, 'Detour': 3,
  'Modified service': 4, 'Accessibility issue': 5, 'Stop moved': 5,
  'Additional service': 6, 'Other effect': 7, 'Unknown': 9,
};
const _EFF_MEANINGFUL = 5;      // above this = no stated effect → not strip-worthy
function _effRank(al) { const r = _EFFECT_RANK[al?.effect]; return r == null ? 8 : r; }
// Strip colour follows the effect, for the same reason.
function _effStripCls(al) { return _effRank(al) <= 1 ? 'severe' : _effRank(al) <= 4 ? 'warning' : 'info'; }

// Returns true if an alert potentially affects the given route names/stop IDs.
//
// Two rules, because TfNSW encodes the answer two different ways (measured against
// the live feed, 2026-07-17):
//  1. routes[] holds OPERATOR-CODED ids — "2447_S859", "WST_2c", "1001_L2". Only
//     light rail / metro appear as line names. Match the id's TAIL EXACTLY: the old
//     substring test made "859" match Cessnock's "2447_S859" and "T8" match bus
//     "2503_T80" — every single T1 "match" was a false positive.
//  2. Sydney Trains lines are NOT in routes[] in any form. The line name is in the
//     TITLE: "T1 Western Line: Buses replace trains…". So for line-code-shaped names
//     (T1, M1, L2, BMT) also look for the code as a WHOLE WORD in the text. Purely
//     numeric bus routes are excluded from that — \b859\b would hit any "859" in
//     prose, and their routes[] ids already carry them.
function _alertMatchesJourney(alert, routeNames, stopIds) {
  if (!routeNames.length && !stopIds.length) return false;
  const names = routeNames.map(n => String(n).toUpperCase());
  for (const r of (alert.routes || [])) {
    if (names.includes(String(r).split('_').pop().toUpperCase())) return true;
  }
  for (const s of (alert.stops || [])) {
    if (stopIds.includes(s)) return true;
  }
  const text = `${alert.title || ''} ${alert.description || ''}`.toUpperCase();
  return names.some(n => /^(?:[A-Z]{1,4}\d{0,2})$/.test(n) && !/^\d+$/.test(n)
    && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
}

function _currentJourneyContext() {
  // Collect route names and stop IDs from the active journey result
  const routeNames = [], stopIds = [];
  document.querySelectorAll('#journey-results .lbadge').forEach(el => {
    const tx = el.textContent.trim(); if (tx) routeNames.push(tx);
  });
  return { routeNames, stopIds };
}

export function renderAlerts() {
  const strip = byId('alert-strip');
  if (!alerts.length) {
    strip.classList.remove('show');
    byId('alert-panel').classList.remove('show');
    return;
  }

  const _effHide = e => !e || /^(unknown|other|no effect)$/i.test(e);
  const { routeNames, stopIds } = _currentJourneyContext();
  const hasCtx = !!(routeNames.length || stopIds.length);

  // Rank by EFFECT, not the feed's `severity`: every one of the 240 live alerts
  // reports severity "info", so sorting on it does nothing. `effect` is the real
  // signal — and 165 of 240 report effect "Unknown", which is the noise.
  const matched = alerts.filter(al => _alertMatchesJourney(al, routeNames, stopIds));

  // The strip answers "does anything hit MY trip". With a journey on screen, that
  // is the matched set and nothing else; the old code showed alerts[0] — literally
  // the first in the array — so a Regentville bus diversion led a Town Hall trip.
  // With no journey up (Home/Departures), fall back to network alerts that state a
  // real effect, so the strip is never a shrug.
  const pool = hasCtx ? matched : alerts.filter(al => _effRank(al) <= _EFF_MEANINGFUL);
  const ranked = pool.slice()
    .sort((a, b) => _effRank(a) - _effRank(b))
    .map(al => ({ al, match: hasCtx }));

  // Nothing relevant → say nothing. A count of every disruption in NSW is not news.
  if (!ranked.length) {
    strip.classList.remove('show');
    byId('alert-panel').classList.remove('show');
    return;
  }

  const top = ranked[0].al;
  const effectShort = _effHide(top.effect) ? '' : (_EFFECT_SHORT[top.effect] || top.effect);
  byId('alert-txt').textContent = `${effectShort ? effectShort + ': ' : ''}${top.title || t('alert_disruption')}`;
  byId('alert-badge').textContent = hasCtx
    ? `${ranked.length} ${t('alert_your_trip') || 'on your trip'}`
    : `${ranked.length} ${ranked.length > 1 ? t('alerts_pl') : t('alert_one')}`;
  strip.className = `alert-strip show alert-strip-${_effStripCls(top)}`;

  // Effect → coloured chip class (severe red / warning amber / neutral)
  const _effClass = e => {
    if (/no service/i.test(e)) return 'aeff-severe';
    if (/delay|detour|reduced|modified|replace|bus/i.test(e)) return 'aeff-warn';
    if (/extra|additional/i.test(e)) return 'aeff-ok';
    return 'aeff-info';
  };

  byId('alert-list').innerHTML = ranked.slice(0, 6).map(({ al, match }) => {
    const icon    = _ALERT_SEV_ICON[al.severity] || '⚠️';
    const sevCls  = _ALERT_SEV_CLS[al.severity]  || 'alert-sev-warning';
    const eff     = _effHide(al.effect) ? '' : (_EFFECT_SHORT[al.effect] || al.effect);
    const cause   = al.cause && al.cause !== 'Unknown' && al.cause !== 'Other' ? al.cause : '';

    // Route badges — show up to 6 route IDs (strip common prefixes)
    const routeBadges = (al.routes || []).slice(0, 6).map(r => {
      const short = String(r).replace(/^[A-Z]+_/i, '').replace(/_\d+[a-z]?$/i, '');
      return `<span class="aline">${esc(short)}</span>`;
    }).join('');
    // (No mode badge: TfNSW never sets route_type on an alert entity, so al.modes
    // is always empty — the proxy fix that stopped it lying "Light Rail" left it
    // correctly blank. Rendering it drew nothing. The route badges carry the who.)
    const chips = [
      eff   ? `<span class="aeff ${_effClass(eff)}">${esc(eff)}</span>` : '',
      cause ? `<span class="acause">${esc(cause)}</span>` : '',
      routeBadges,
    ].filter(Boolean).join('');

    return `<div class="alert-item ${sevCls}${match ? ' alert-item-match' : ''}">
      ${match ? `<div class="alert-match-row">★ ${t('alert_your_journey') || 'Affects your journey'}</div>` : ''}
      <div class="alert-item-hdr">
        <span class="alert-item-icon">${icon}</span>
        <div class="alert-item-title">${esc(al.title || t('alert_disruption'))}</div>
      </div>
      ${chips ? `<div class="alert-chips">${chips}</div>` : ''}
      ${al.description && al.description !== al.title
        ? `<div class="alert-desc">${esc(al.description.slice(0, 200))}${al.description.length > 200 ? '…' : ''}</div>` : ''}
      ${safeUrl(al.url) ? `<a class="alert-link" href="${esc(safeUrl(al.url))}" target="_blank" rel="noopener">${t('alert_more_info') || 'More info'} ↗</a>` : ''}
    </div>`;
  }).join('') + (ranked.length > 6
    ? `<div class="alert-more">+${ranked.length - 6} ${t('more')} alerts</div>` : '');
}

export function toggleAlerts() {
  if (alertOpen) { if (!_ovDismiss('alerts')) _setAlerts(false); }
  else { _setAlerts(true); _ovOpen('alerts', () => _setAlerts(false)); }
}
function _setAlerts(open) {
  alertOpen = open;
  byId('alert-panel').classList.toggle('show', open);
  byId('alert-chev').textContent = open ? '▲' : '▼';
  byId('alert-strip')?.setAttribute('aria-expanded', String(open));
}
