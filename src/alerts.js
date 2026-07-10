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

// Returns true if an alert potentially affects the given route names/stop IDs
function _alertMatchesJourney(alert, routeNames, stopIds) {
  if (!routeNames.length && !stopIds.length) return false;
  for (const r of (alert.routes || [])) {
    for (const nm of routeNames) {
      if (r.toUpperCase().includes(nm.toUpperCase()) || nm.toUpperCase().includes(r.split('_').pop()?.toUpperCase())) return true;
    }
  }
  for (const s of (alert.stops || [])) {
    if (stopIds.includes(s)) return true;
  }
  return false;
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

  // Find the most severe alert to show in the strip
  // Hide non-informative effect labels (GTFS-RT code 8 = unspecified) so alerts
  // don't read "Unknown: …". Same idea as the cause filter below.
  const _effHide = e => !e || /^(unknown|other|no effect)$/i.test(e);
  const top = alerts[0];
  const effectShort = _effHide(top.effect) ? '' : (_EFFECT_SHORT[top.effect] || top.effect);
  const stripText = `${effectShort ? effectShort + ': ' : ''}${top.title || t('alert_disruption')}`;
  byId('alert-txt').textContent = stripText;
  byId('alert-badge').textContent =
    alerts.length + ' ' + (alerts.length > 1 ? t('alerts_pl') : t('alert_one'));
  strip.className = `alert-strip show alert-strip-${top.severity || 'warning'}`;

  const { routeNames, stopIds } = _currentJourneyContext();

  // Rank alerts that affect the user's current journey to the top (the proxy has
  // already sorted by severity, and this sort is stable, so severity order holds
  // within the matched / non-matched groups).
  const ranked = alerts
    .map(al => ({ al, match: _alertMatchesJourney(al, routeNames, stopIds) }))
    .sort((a, b) => (b.match ? 1 : 0) - (a.match ? 1 : 0));

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
    const modeBadges = (al.modes || []).slice(0, 3).map(m =>
      `<span class="alert-mode-badge">${esc(m)}</span>`).join('');

    const chips = [
      eff   ? `<span class="aeff ${_effClass(eff)}">${esc(eff)}</span>` : '',
      cause ? `<span class="acause">${esc(cause)}</span>` : '',
      routeBadges, modeBadges,
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
