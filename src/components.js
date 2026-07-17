// Reusable UI component library — vanilla, accessible, factory→HTML-string.
// Exports: button, iconButton, badge, spinner, skeleton, toast, bindActions,
// stopTimeline (feature-complete transit timeline ← 21st Timeline Rail),
// serviceCard (← 21st Flight Status Card), icon. Wired in app: toast, fav button,
// leg stop-list.
// ─────────────────────────────────────────────────────────────────────────────
//
// ARCHITECTURE
//   The app renders via innerHTML template strings, so each component is a pure
//   factory that RETURNS an HTML string (no framework, no DOM nodes to graft in).
//   Interactivity uses ONE delegated listener per container (bindActions) keyed by
//   `data-action`, instead of inline onclick — fewer listeners, no window-bridge
//   pollution, and it survives innerHTML re-renders.
//
//   All user/feed text is passed through esc() to prevent XSS (see core.js).
//
// ACCESSIBILITY (baked in, not optional)
//   • Real <button>/<a> elements → keyboard + screen-reader for free.
//   • Icon-only controls REQUIRE an ariaLabel (throws in dev if missing).
//   • 44×44px minimum touch targets (WCAG 2.5.5 / Apple HIG).
//   • aria-busy + disabled during loading; visible :focus-visible ring.
//   • Toasts use role="status" aria-live="polite"; errors assertive.
//   • Respects prefers-reduced-motion (see components.css).
// ─────────────────────────────────────────────────────────────────────────────
import { esc } from './core.js';
import './components.css';

// ── Inline SVG icons (24×24, currentColor) — SVG not emoji for UI chrome ───────
const ICONS = {
  spinner: '<svg class="c-spin" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="14"/></svg>',
  star:    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 17.3l-6.2 3.7 1.6-7L2 9.2l7.1-.6L12 2l2.9 6.6 7.1.6-5.4 4.8 1.6 7z"/></svg>',
  close:   '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>',
  check:   '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M4 12.5l5 5 11-11"/></svg>',
  search:  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10.5 3a7.5 7.5 0 105.3 12.8l4.7 4.7M10.5 3a7.5 7.5 0 015.3 12.8"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>',
  alert:   '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.3 3.9a2 2 0 00-3.4 0z"/></svg>',
  inbox:   '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13a2 2 0 011.8 1.1L22 12v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6L3.7 6.1A2 2 0 015.5 5z"/></svg>',
};
export function icon(name) { return ICONS[name] || ''; }

// ── Spinner ────────────────────────────────────────────────────────────────
// Accessible loading indicator. Standalone spinners get role="status" + label.
export function spinner({ label = 'Loading', standalone = false } = {}) {
  const svg = ICONS.spinner;
  return standalone
    ? `<span class="c-spinner" role="status" aria-live="polite">${svg}<span class="c-visually-hidden">${esc(label)}</span></span>`
    : svg;
}

// ── Badge ──────────────────────────────────────────────────────────────────
// Small status/label pill. `variant` styles it, OR pass explicit bg/fg (e.g. from
// getLineColors) for brand line colours. Non-interactive.
export function badge({ text, variant = 'neutral', bg, fg, title } = {}) {
  const style = bg ? ` style="background:${esc(bg)};color:${esc(fg || '#fff')}"` : '';
  const t = title ? ` title="${esc(title)}"` : '';
  return `<span class="c-badge c-badge--${esc(variant)}"${style}${t}>${esc(text)}</span>`;
}

// ── Button ─────────────────────────────────────────────────────────────────
// variant: primary | secondary | ghost | danger
// size: sm | md (default) | lg
// Pass `action` → emits data-action for bindActions(). Pass `href` → renders <a>.
// `loading` disables + shows spinner + aria-busy. `iconName`/`iconSvg` optional.
export function button({
  label, variant = 'primary', size = 'md', action, href, onclick, id,
  loading = false, disabled = false, iconName, iconSvg, pressed,
  fullWidth = false, ariaLabel, type = 'button', dataset = {},
} = {}) {
  const isLink = !!href;
  const glyph = loading ? ICONS.spinner : (iconSvg || (iconName ? ICONS[iconName] : ''));
  const cls = [
    'c-btn', `c-btn--${esc(variant)}`, `c-btn--${esc(size)}`,
    fullWidth ? 'c-btn--block' : '', loading ? 'is-loading' : '',
  ].filter(Boolean).join(' ');
  const data = Object.entries(dataset).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  // `action` → data-action (delegation). `onclick` → inline handler (compat with
  // apps on the window-bridge pattern). Prefer action; onclick is the escape hatch.
  const common =
    `class="${cls}"` +
    (id ? ` id="${esc(id)}"` : '') +
    (action ? ` data-action="${esc(action)}"` : '') +
    (onclick ? ` onclick="${esc(onclick)}"` : '') +
    ((pressed === true || pressed === false) ? ` aria-pressed="${pressed}"` : '') +
    (ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : '') +
    (loading ? ' aria-busy="true"' : '') + data;
  const inner = `${glyph ? `<span class="c-btn__ic">${glyph}</span>` : ''}${label ? `<span class="c-btn__lbl">${esc(label)}</span>` : ''}`;
  if (isLink) {
    const dis = (disabled || loading) ? ' aria-disabled="true" tabindex="-1"' : '';
    return `<a href="${esc(href)}" ${common}${dis}>${inner}</a>`;
  }
  const dis = (disabled || loading) ? ' disabled' : '';
  return `<button type="${esc(type)}" ${common}${dis}>${inner}</button>`;
}

// ── Icon button ────────────────────────────────────────────────────────────
// Icon-only control. ariaLabel is REQUIRED (throws in dev) — never ship an
// unlabelled icon button. `pressed` sets aria-pressed for toggle buttons.
export function iconButton({ iconName, iconSvg, ariaLabel, action, variant = 'ghost', pressed, dataset = {} } = {}) {
  if (!ariaLabel) throw new Error('iconButton requires ariaLabel (accessibility)');
  const glyph = iconSvg || (iconName ? ICONS[iconName] : '');
  const data = Object.entries(dataset).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  const press = (pressed === true || pressed === false) ? ` aria-pressed="${pressed}"` : '';
  return `<button type="button" class="c-iconbtn c-iconbtn--${esc(variant)}" aria-label="${esc(ariaLabel)}"` +
    (action ? ` data-action="${esc(action)}"` : '') + press + data + `>${glyph}</button>`;
}

// ── Skeleton ───────────────────────────────────────────────────────────────
// Loading placeholder that reserves layout space (prevents content jumping).
// `lines` = number of shimmer bars; widths cycle for a natural look.
export function skeleton({ lines = 3, avatar = false, className = '' } = {}) {
  const widths = ['92%', '70%', '84%', '55%'];
  const bars = Array.from({ length: lines }, (_, i) =>
    `<span class="c-skel-bar" style="width:${widths[i % widths.length]}"></span>`).join('');
  return `<div class="c-skel ${esc(className)}" aria-hidden="true">` +
    (avatar ? '<span class="c-skel-avatar"></span>' : '') +
    `<div class="c-skel-lines">${bars}</div></div>`;
}

// ── Toast ──────────────────────────────────────────────────────────────────
// Imperative, screen-reader announced. type: info | success | error.
// Auto-dismisses; errors are assertive + stay a bit longer. Returns a dismiss fn.
let _toastHost = null;
function toastHost() {
  if (_toastHost && document.body.contains(_toastHost)) return _toastHost;
  _toastHost = document.createElement('div');
  _toastHost.className = 'c-toast-host';
  _toastHost.setAttribute('role', 'region');
  _toastHost.setAttribute('aria-label', 'Notifications');
  document.body.appendChild(_toastHost);
  return _toastHost;
}
export function toast(message, { type = 'info', duration } = {}) {
  const host = toastHost();
  const el = document.createElement('div');
  el.className = `c-toast c-toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  el.innerHTML = `<span class="c-toast__ic">${type === 'success' ? ICONS.check : ''}</span><span class="c-toast__msg"></span>`;
  el.querySelector('.c-toast__msg').textContent = message;   // textContent = XSS-safe
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  const ms = duration ?? (type === 'error' ? 6000 : 3500);
  let done = false;
  const dismiss = () => {
    if (done) return; done = true;
    el.classList.remove('is-in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);   // fallback if no transition (reduced-motion)
  };
  const timer = setTimeout(dismiss, ms);
  el.addEventListener('click', () => { clearTimeout(timer); dismiss(); });
  return dismiss;
}

// ── serviceCard ────────────────────────────────────────────────────────────
// Compact transit service/departure summary. Adapted from 21st.dev "Flight Status
// Card" by ravikatiyar (id 7801) — airline→line badge, gate→platform, flight
// status→service status, boarding progress→journey progress bar. Ported to vanilla.
//   status.variant: ontime | delayed | live | cancelled
// Pass `action` to make the whole card activatable via bindActions (keyboard-safe).
// Feature-complete enough to replace a rich departure/journey row:
//   delay: minutes (+late/−early) → coloured status, overrides status.text if unset
//   live:  boolean → pulsing "live" dot (realtime data)
//   badges: [{ text, variant }] → occupancy / carriages / accessibility chips
//   platformChanged: boolean → platform rendered with a warning style
export function serviceCard({
  line, lineBg, lineFg, origin = {}, destination = {},
  departTime, arriveTime, status = {}, platform, platformChanged = false,
  progress, delay, live = false, badges = [], action, dataset = {},
} = {}) {
  const pct = progress == null ? null : Math.min(100, Math.max(0, progress));
  // Derive status from delay when an explicit status.text isn't supplied.
  let variant = status.variant, text = status.text;
  if (text == null && delay != null) {
    if (delay > 0)      { variant = 'delayed';   text = `${delay} min late`; }
    else if (delay < 0) { variant = 'ontime';    text = `${-delay} min early`; }
    else                { variant = 'ontime';    text = 'On time'; }
  }
  variant = variant || 'ontime';
  const data = Object.entries(dataset).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  const act = action ? ` data-action="${esc(action)}" role="button" tabindex="0"` : '';
  const liveDot = live ? '<span class="c-svc__live" aria-label="Live"></span>' : '';
  const chips = (badges || []).map(b =>
    `<span class="c-badge c-badge--${esc(b.variant || 'neutral')}">${esc(b.text)}</span>`).join('');
  return `<article class="c-svc"${act}${data} aria-label="${esc(line || 'Service')}: ${esc(origin.name || '')} to ${esc(destination.name || '')}">
    <header class="c-svc__hdr">
      <span class="c-badge" style="background:${esc(lineBg || '#666')};color:${esc(lineFg || '#fff')}">${esc(line || '')}</span>
      <span class="c-svc__hdr-right">${liveDot}${text ? `<span class="c-svc__status c-svc__status--${esc(variant)}">${esc(text)}</span>` : ''}</span>
    </header>
    <div class="c-svc__od">
      <div class="c-svc__end">
        <span class="c-svc__time">${esc(departTime || '')}</span>
        <span class="c-svc__place">${esc(origin.name || '')}</span>
        ${origin.code ? `<span class="c-svc__code">${esc(origin.code)}</span>` : ''}
      </div>
      <span class="c-svc__arrow" aria-hidden="true">→</span>
      <div class="c-svc__end c-svc__end--to">
        <span class="c-svc__time">${esc(arriveTime || '')}</span>
        <span class="c-svc__place">${esc(destination.name || '')}</span>
        ${destination.code ? `<span class="c-svc__code">${esc(destination.code)}</span>` : ''}
      </div>
    </div>
    ${pct != null ? `<div class="c-svc__prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="c-svc__prog-fill" style="width:${pct}%"></span></div>` : ''}
    ${(platform || chips) ? `<footer class="c-svc__ft">
      ${platform ? `<span class="c-svc__plat${platformChanged ? ' c-svc__plat--changed' : ''}">${esc(platform)}${platformChanged ? ' ⚠' : ''}</span>` : ''}
      ${chips ? `<span class="c-svc__chips">${chips}</span>` : ''}
    </footer>` : ''}
  </article>`;
}

// ── stopTimeline ───────────────────────────────────────────────────────────
// Vertical journey stop timeline: dots + connecting rail, with the ridden segment
// (board → alight) emphasized and stops outside it dimmed. Adapted from 21st.dev
// "Timeline Rail" by nayan_radadiya6 (id 6530) — ported React/Tailwind → vanilla,
// re-oriented vertical for the stops view.
//   stops: [{ name, time?, platform? }]   boardIdx / alightIdx: ridden segment.
// Accessible: ordered list, aria-current on the boarding stop, SR-only board/alight
// labels (state isn't conveyed by colour alone).
// Feature-complete — carries everything the rich transit stop list shows, so the
// component IS the full design (not a simpler stand-in). Per stop (in `stops[]`):
//   name, time, platform          basic
//   delay (min, +late/−early)      coloured delta   live (bool) realtime dot
//   occ ('many'|'few'|'standing'|'crowded'|'full')  occupancy dot
//   skipped (bool)                 "not stopping", no time
//   platformChanged (bool)         platform ⚠ warning
//   terminus (bool)                terminus dot
//   label (string)                 e.g. localised "Board"/"Alight" (else auto)
//   anchor (string)                value for data-stop-anchor (scroll targeting)
// Segment states are derived from boardIdx/alightIdx: before-board & after-alight
// are dimmed; the ridden segment is emphasised in `lineColor`.
const _OCC_DOT = { many: '🟢', few: '🟡', standing: '🟠', crowded: '🔴', full: '🔴' };
export function stopTimeline({ stops = [], boardIdx = 0, alightIdx = stops.length - 1, lineColor, size = 'md' } = {}) {
  if (!stops.length) return '';
  const accent = lineColor || 'var(--accent, #0072c9)';
  const items = stops.map((s, i) => {
    const isBoard = i === boardIdx, isAlight = i === alightIdx;
    const before = i < boardIdx, after = i > alightIdx;
    const state = s.skipped ? 'skipped'
                : isBoard ? 'board' : isAlight ? 'alight'
                : s.terminus ? 'terminus'
                : before ? 'past' : after ? 'after' : 'on';
    const current = isBoard ? ' aria-current="step"' : '';
    const anchor = s.anchor ? ` data-stop-anchor="${esc(s.anchor)}"` : '';
    // rail from this dot down to the next: dim before-board & after-alight
    const railOpacity = before ? 0.25 : after ? 0.35 : 0.55;
    const railColor = before ? 'var(--muted, #889)' : accent;
    const rail = i < stops.length - 1
      ? `<span class="c-tl__rail" style="background:${railColor};opacity:${railOpacity}"></span>` : '';
    const dotStyle = (state === 'on' || isBoard || isAlight || s.terminus)
      ? ` style="border-color:${accent}${(isBoard || isAlight) ? `;background:${accent}` : ''}"` : '';
    const live = s.live ? '<span class="c-tl__live" aria-label="Live" role="img"></span>' : '';
    const occ = s.occ && _OCC_DOT[s.occ] ? ` <span class="c-tl__occ" title="${esc(s.occ)}">${_OCC_DOT[s.occ]}</span>` : '';
    const delay = (!s.skipped && s.delay != null && s.delay !== 0)
      ? `<span class="c-tl__delay c-tl__delay--${s.delay > 0 ? 'late' : 'early'}">${s.delay > 0 ? '+' : ''}${s.delay}m</span>` : '';
    const timeCol = s.skipped
      ? '<span class="c-tl__skip">Not stopping</span>'
      : (s.time || delay || occ) ? `<span class="c-tl__time">${esc(s.time || '')}${delay}${occ}</span>` : '';
    const label = (s.label || (isBoard ? 'Board' : isAlight ? 'Alight' : ''));
    const labelHtml = label ? `<span class="c-tl__tag c-tl__tag--${isAlight ? 'alight' : 'board'}">${esc(label)}</span>` : '';
    // Optional "vehicle here / approaching" marker rendered just before this stop.
    const m = s.markerBefore;
    const marker = m ? `<li class="c-tl__marker" aria-label="${esc(m.text || 'Vehicle position')}">
      <span class="c-tl__marker-ico" aria-hidden="true">${m.icon || ''}</span>
      <span class="c-tl__marker-txt">${esc(m.text || '')}</span>
      ${m.live ? '<span class="c-tl__live" role="img" aria-label="Live"></span>' : ''}
    </li>` : '';
    const dimCls = s.dim ? ' c-tl__item--dim' : '';
    return `${marker}<li class="c-tl__item c-tl__item--${state}${dimCls}"${current}${anchor}>
      <span class="c-tl__gutter" aria-hidden="true"><span class="c-tl__dot"${dotStyle}></span>${rail}</span>
      <span class="c-tl__body">
        <span class="c-tl__row"><span class="c-tl__name">${esc(s.name)}</span>${labelHtml}${live}</span>
        ${s.platform ? `<span class="c-tl__plat${s.platformChanged ? ' c-tl__plat--changed' : ''}">${esc(s.platform)}${s.platformChanged ? ' ⚠' : ''}</span>` : ''}
      </span>
      ${timeCol}
    </li>`;
  }).join('');
  return `<ol class="c-tl c-tl--${esc(size)}">${items}</ol>`;
}

// ── uid ──────────────────────────────────────────────────────────────────────
// Stable-per-call unique id for wiring label↔input, aria-describedby, listbox ids.
let _uidN = 0;
export function uid(prefix = 'c') { return `${prefix}-${(++_uidN).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

// ── Card ─────────────────────────────────────────────────────────────────────
// Generic surface container. Presentational by default; pass `action` (+ optional
// `href`) to make the whole card an activatable button/link (keyboard-safe).
//   title/subtitle → header slot   media → raw HTML above header   footer → footer slot
//   body → raw HTML (already escaped by caller) OR pass `text` for auto-escaped text
// variant: default | outlined | elevated   padding: sm | md (default) | lg
export function card({
  title, subtitle, body, text, media, footer, action, href, id,
  variant = 'default', padding = 'md', ariaLabel, dataset = {},
} = {}) {
  const cls = ['c-card', `c-card--${esc(variant)}`, `c-card--pad-${esc(padding)}`,
    (action || href) ? 'c-card--interactive' : ''].filter(Boolean).join(' ');
  const data = Object.entries(dataset).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  const head = (title || subtitle) ? `<div class="c-card__hd">
      ${title ? `<h3 class="c-card__title">${esc(title)}</h3>` : ''}
      ${subtitle ? `<p class="c-card__sub">${esc(subtitle)}</p>` : ''}
    </div>` : '';
  const inner = `${media ? `<div class="c-card__media">${media}</div>` : ''}${head}` +
    `${(body != null || text != null) ? `<div class="c-card__body">${body != null ? body : esc(text)}</div>` : ''}` +
    `${footer ? `<div class="c-card__ft">${footer}</div>` : ''}`;
  const common = `class="${cls}"` + (id ? ` id="${esc(id)}"` : '') +
    (ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : '') +
    (action ? ` data-action="${esc(action)}"` : '') + data;
  if (href) return `<a href="${esc(href)}" ${common}>${inner}</a>`;
  if (action) return `<div ${common} role="button" tabindex="0">${inner}</div>`;
  return `<div ${common}>${inner}</div>`;
}

// ── Field / TextInput ─────────────────────────────────────────────────────────
// Labelled form control with hint + error wiring. Returns { html, id } so callers
// can target the input. Always has a real <label for>; error sets aria-invalid +
// aria-describedby; required marks aria-required. `as='select'` renders a native
// <select> from `options:[{value,label}]`; `as='textarea'` a <textarea>.
//   type, value, placeholder, autocomplete, inputmode, name, disabled, hint, error
export function field({
  label, id, name, type = 'text', value = '', placeholder = '', hint, error,
  required = false, disabled = false, autocomplete, inputmode, as = 'input',
  options = [], rows = 3, iconName, dataset = {},
} = {}) {
  const fid = id || uid('f');
  const hintId = hint ? `${fid}-hint` : '';
  const errId = error ? `${fid}-err` : '';
  const describedBy = [hintId, errId].filter(Boolean).join(' ');
  const data = Object.entries(dataset).map(([k, v]) => ` data-${esc(k)}="${esc(v)}"`).join('');
  const shared = `id="${fid}"` + (name ? ` name="${esc(name)}"` : '') +
    (describedBy ? ` aria-describedby="${describedBy}"` : '') +
    (error ? ' aria-invalid="true"' : '') +
    (required ? ' required aria-required="true"' : '') +
    (disabled ? ' disabled' : '') + data;
  let control;
  if (as === 'select') {
    const opts = options.map(o =>
      `<option value="${esc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    control = `<div class="c-field__wrap c-field__wrap--select">
      <select class="c-input c-input--select" ${shared}>${opts}</select>
      <span class="c-field__chev" aria-hidden="true">${ICONS.chevron}</span>
    </div>`;
  } else if (as === 'textarea') {
    control = `<textarea class="c-input c-input--area" rows="${rows}" placeholder="${esc(placeholder)}" ${shared}>${esc(value)}</textarea>`;
  } else {
    const ic = iconName && ICONS[iconName] ? `<span class="c-field__ic" aria-hidden="true">${ICONS[iconName]}</span>` : '';
    control = `<div class="c-field__wrap${ic ? ' c-field__wrap--icon' : ''}">
      ${ic}<input class="c-input" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}"${
        autocomplete ? ` autocomplete="${esc(autocomplete)}"` : ''}${
        inputmode ? ` inputmode="${esc(inputmode)}"` : ''} ${shared} />
    </div>`;
  }
  const html = `<div class="c-field${error ? ' c-field--error' : ''}${disabled ? ' c-field--disabled' : ''}">
    ${label ? `<label class="c-field__label" for="${fid}">${esc(label)}${required ? ' <span class="c-field__req" aria-hidden="true">*</span>' : ''}</label>` : ''}
    ${control}
    ${hint ? `<p class="c-field__hint" id="${hintId}">${esc(hint)}</p>` : ''}
    ${error ? `<p class="c-field__err" id="${errId}" role="alert">${esc(error)}</p>` : ''}
  </div>`;
  return { html, id: fid };
}

// ── emptyState / errorState ────────────────────────────────────────────────────
// Full-slot placeholders for the "no data" and "load failed" edge cases. Both take
// an optional `action:{label,action}` to render a retry/CTA button (via bindActions).
function _stateBlock(kind, { icon, title, message, action } = {}) {
  const btn = action ? button({ label: action.label, action: action.action, variant: kind === 'error' ? 'primary' : 'secondary', size: 'sm', dataset: action.dataset || {} }) : '';
  return `<div class="c-state c-state--${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
    <span class="c-state__ic" aria-hidden="true">${icon || (kind === 'error' ? ICONS.alert : ICONS.inbox)}</span>
    ${title ? `<p class="c-state__title">${esc(title)}</p>` : ''}
    ${message ? `<p class="c-state__msg">${esc(message)}</p>` : ''}
    ${btn ? `<div class="c-state__cta">${btn}</div>` : ''}
  </div>`;
}
export function emptyState(opts = {}) { return _stateBlock('empty', opts); }
export function errorState(opts = {}) {
  return _stateBlock('error', { title: 'Something went wrong', message: 'Please try again.', ...opts });
}

// ── Focus trap (shared by modal + overlay) ────────────────────────────────────
const _FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
function _trap(container) {
  const nodes = () => Array.from(container.querySelectorAll(_FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
  return (e) => {
    if (e.key !== 'Tab') return;
    const f = nodes(); if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
}

// ── Modal / Dialog ─────────────────────────────────────────────────────────────
// Imperative, accessible modal. Focus-trapped, ESC + backdrop close, restores focus
// to the invoker, role="dialog" aria-modal, labelled by its title. Body scroll locks
// while open. `body` is raw HTML (escape untrusted parts yourself); `actions` is an
// array of button() option objects rendered in the footer. Returns { close, el }.
//   dismissible=false → no ESC/backdrop close (use for required decisions)
export function modal({ title, body = '', actions = [], dismissible = true, onClose, size = 'md' } = {}) {
  const invoker = document.activeElement;
  const titleId = uid('m');
  const overlay = document.createElement('div');
  overlay.className = 'c-modal-overlay';
  const footer = actions.length
    ? `<footer class="c-modal__ft">${actions.map(a => button(a)).join('')}</footer>` : '';
  overlay.innerHTML = `<div class="c-modal c-modal--${esc(size)}" role="dialog" aria-modal="true"${title ? ` aria-labelledby="${titleId}"` : ''}>
    <header class="c-modal__hd">
      ${title ? `<h2 class="c-modal__title" id="${titleId}">${esc(title)}</h2>` : '<span></span>'}
      ${dismissible ? `<button type="button" class="c-iconbtn c-modal__x" aria-label="Close dialog" data-modal-close>${ICONS.close}</button>` : ''}
    </header>
    <div class="c-modal__body">${body}</div>
    ${footer}
  </div>`;
  const dialog = overlay.querySelector('.c-modal');
  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(); return; }
    trapHandler(e);
  };
  const trapHandler = _trap(dialog);
  function close() {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('is-in');
    const remove = () => { overlay.remove(); if (!document.querySelector('.c-modal-overlay')) document.body.classList.remove('c-modal-open'); };
    overlay.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 300);
    if (invoker && typeof invoker.focus === 'function') invoker.focus();
    if (typeof onClose === 'function') onClose();
  }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissible) close(); });
  overlay.addEventListener('click', (e) => { if (e.target.closest('[data-modal-close]')) close(); });
  document.body.appendChild(overlay);
  document.body.classList.add('c-modal-open');
  document.addEventListener('keydown', onKey, true);
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  // Focus the first control (or the dialog itself) for screen-reader context.
  const firstFocus = dialog.querySelector(_FOCUSABLE) || dialog;
  if (firstFocus === dialog) dialog.setAttribute('tabindex', '-1');
  firstFocus.focus();
  return { close, el: dialog };
}

// ── Loading overlay ────────────────────────────────────────────────────────────
// Non-modal busy veil over a target element (or the viewport when target omitted).
// Sets aria-busy on the target and shows a labelled spinner. Returns a hide fn.
// Use for async regions where a skeleton doesn't fit (e.g. re-fetching over content).
export function loadingOverlay(target, { label = 'Loading' } = {}) {
  const scoped = target instanceof HTMLElement;
  const host = scoped ? target : document.body;
  if (scoped && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.setAttribute('aria-busy', 'true');
  const el = document.createElement('div');
  el.className = `c-overlay${scoped ? '' : ' c-overlay--fixed'}`;
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<span class="c-spinner">${ICONS.spinner}<span class="c-visually-hidden">${esc(label)}</span></span>`;
  host.appendChild(el);
  return function hide() {
    host.removeAttribute('aria-busy');
    el.classList.add('is-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 250);
  };
}

// ── Autocomplete (combobox) ────────────────────────────────────────────────────
// WAI-ARIA combobox: text input + popup listbox. Keyboard: ↑/↓ move, Enter select,
// Esc close; aria-expanded/-activedescendant/-controls kept in sync; each option is
// role="option" with aria-selected. Debounced async source. Mount onto a container:
//   const ac = autocomplete(el, { fetchItems: async(q)=>[{id,label,sub?}], onSelect })
// Returns { destroy, input }. Presentational classes mirror the field/input styles.
export function autocomplete(container, {
  fetchItems, onSelect, placeholder = 'Search…', label, minChars = 2, debounce = 220,
  emptyText = 'No matches', autocompleteAttr = 'off', name,
} = {}) {
  const baseId = uid('ac');
  const listId = `${baseId}-list`;
  const lblId = label ? `${baseId}-lbl` : '';
  container.classList.add('c-ac');
  container.innerHTML = `
    ${label ? `<label class="c-field__label" id="${lblId}" for="${baseId}">${esc(label)}</label>` : ''}
    <div class="c-field__wrap c-field__wrap--icon">
      <span class="c-field__ic" aria-hidden="true">${ICONS.search}</span>
      <input id="${baseId}" class="c-input" type="text" role="combobox" autocomplete="${esc(autocompleteAttr)}"
        aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" placeholder="${esc(placeholder)}"
        ${name ? `name="${esc(name)}"` : ''} ${lblId ? `aria-labelledby="${lblId}"` : ''} />
    </div>
    <ul id="${listId}" class="c-ac__list" role="listbox" hidden ${lblId ? `aria-labelledby="${lblId}"` : ''}></ul>`;
  const input = container.querySelector('input');
  const list = container.querySelector('.c-ac__list');
  let items = [], active = -1, timer = null, reqSeq = 0;

  const closeList = () => {
    list.hidden = true; list.innerHTML = ''; items = []; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    list.innerHTML = items.length
      ? items.map((it, i) => `<li id="${baseId}-o${i}" class="c-ac__opt" role="option" aria-selected="${i === active}">
          <span class="c-ac__opt-main">${esc(it.label)}</span>${it.sub ? `<span class="c-ac__opt-sub">${esc(it.sub)}</span>` : ''}
        </li>`).join('')
      : `<li class="c-ac__opt c-ac__opt--empty" role="option" aria-disabled="true">${esc(emptyText)}</li>`;
    list.hidden = false; input.setAttribute('aria-expanded', 'true');
  };
  const setActive = (i) => {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    Array.from(list.children).forEach((li, idx) => li.setAttribute('aria-selected', String(idx === active)));
    const el = list.children[active];
    input.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => {
    const it = items[i]; if (!it) return;
    input.value = it.label; closeList();
    if (typeof onSelect === 'function') onSelect(it);
  };
  const search = async (q) => {
    const seq = ++reqSeq;
    try {
      const res = (await fetchItems(q)) || [];
      if (seq !== reqSeq) return;   // drop stale responses (out-of-order network)
      items = res; active = -1; render();
    } catch { if (seq === reqSeq) { items = []; render(); } }
  };
  const onInput = () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < minChars) { closeList(); return; }
    timer = setTimeout(() => search(q), debounce);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden && items.length) render(); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); } }
    else if (e.key === 'Escape') { closeList(); }
  };
  const onDocClick = (e) => { if (!container.contains(e.target)) closeList(); };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  list.addEventListener('mousedown', (e) => { const li = e.target.closest('.c-ac__opt'); if (li && li.id) { e.preventDefault(); choose(Array.from(list.children).indexOf(li)); } });
  document.addEventListener('click', onDocClick);
  return {
    input,
    destroy() {
      clearTimeout(timer);
      document.removeEventListener('click', onDocClick);
      container.classList.remove('c-ac'); container.innerHTML = '';
    },
  };
}

// ── bindActions ────────────────────────────────────────────────────────────
// One delegated click listener per container. Maps data-action="name" → handler.
// Handlers get (element, event). Survives innerHTML re-renders (listener is on the
// stable container, not the regenerated children). Idempotent per container.
const _bound = new WeakSet();
export function bindActions(container, handlers) {
  if (!container) return;
  container.__actions = { ...(container.__actions || {}), ...handlers };
  if (_bound.has(container)) return;
  _bound.add(container);
  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !container.contains(el)) return;
    const fn = container.__actions[el.dataset.action];
    if (fn) fn(el, e);
  });
}
