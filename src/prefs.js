// UI preferences: accent colour + font style. Reads/writes pref (core) and repaints
// visible surfaces via app.js entry fns (rerenderJourneys/renderHome — runtime only).
import { byId, pref, _lsSet } from './core.js';
import { rerenderJourneys } from '../app.js';
import { renderHome } from './tracking.js';

// ── Accent colour ────────────────────────────────────────────────────────────
// Default = TfNSW brand blue. "Ocean" = cyan palette (WCAG AA safe). Stored
// separately from light/dark so the two combine freely.
if (!['default', 'ocean'].includes(pref.accent)) pref.accent = 'default';
export function applyAccent() {
  const root = byId('html-root');
  if (pref.accent === 'default') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', pref.accent);
  syncAccentToggle();
}
export function setAccent(p) {
  pref.accent = (p === 'ocean') ? 'ocean' : 'default';
  _lsSet('nsw_accent', pref.accent);
  applyAccent();
  // Re-render visible surfaces so inline line/brand colours pick up the change
  rerenderJourneys();
  renderHome();
}
function syncAccentToggle() {
  ['default', 'ocean'].forEach(p =>
    byId('accent-' + p)?.classList.toggle('active', pref.accent === p));
}

// ── Font style ───────────────────────────────────────────────────────────────
// Default = Inter. "Elegant" = Cinzel display + Josefin Sans body, loaded lazily
// only when picked so default users pay nothing.
if (!['default', 'elegant'].includes(pref.font)) pref.font = 'default';
function _loadElegantFonts() {
  if (pref.elegantLoaded) return;
  pref.elegantLoaded = true;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Josefin+Sans:wght@300;400;500;600;700&display=swap';
  document.head.appendChild(l);
}
export function applyFont() {
  const root = byId('html-root');
  if (pref.font === 'elegant') { _loadElegantFonts(); root.setAttribute('data-font', 'elegant'); }
  else root.removeAttribute('data-font');
  syncFontToggle();
}
export function setFont(p) { pref.font = (p === 'elegant') ? 'elegant' : 'default'; _lsSet('nsw_font', pref.font); applyFont(); }
function syncFontToggle() {
  ['default', 'elegant'].forEach(p =>
    byId('font-' + p)?.classList.toggle('active', pref.font === p));
}
