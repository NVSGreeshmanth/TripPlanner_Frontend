// ─────────────────────────────────────────────────────────────────────────────
// Motion — animation / gesture / scroll layer (vanilla, via `motion` = Motion One,
// the framework-free sibling of Framer Motion by the same author).
//
// The app renders lists by replacing innerHTML, so instead of hooking every render
// site we watch the result containers with a MutationObserver and enhance any newly
// inserted cards/rows once:
//   • REVEAL   — fade + slide-up as each element scrolls into view (scroll animation)
//   • PRESS    — spring scale-down on tap for buttons/chips (gesture)
//   • HOVER    — subtle lift spring on pointer devices (gesture)
//
// Accessibility: honours the OS/phone "reduce motion" setting (prefers-reduced-motion,
// WCAG 2.3.3) — when on, reveals/gestures are skipped and content shows instantly.
// Read live (not cached) so toggling the setting takes effect without a reload.
// Inline transforms written by `animate` are cleared on finish so CSS :hover still
// owns the resting interaction.
// ─────────────────────────────────────────────────────────────────────────────
import { animate, inView, press, hover } from 'motion';

const _rm = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => _rm.matches;   // respect the user's phone/OS preference

const EASE = [0.22, 1, 0.36, 1];               // easeOutExpo-ish
const SPRING = { type: 'spring', stiffness: 520, damping: 30, mass: 0.6 };

// ── Scroll reveal ────────────────────────────────────────────────────────────
// Stagger by DOM order (capped) so a fresh list cascades in; runs once per element.
function reveal(root, selector, { y = 18, dur = 0.42, stepMs = 45 } = {}) {
  const els = root.querySelectorAll(selector);
  els.forEach((el, i) => {
    if (el.__revealed) return;
    el.__revealed = true;
    if (reduced()) return;
    el.style.opacity = '0';
    inView(el, (info) => {
      const t = info.target;
      animate(t,
        { opacity: [0, 1], transform: [`translateY(${y}px)`, 'translateY(0px)'] },
        { duration: dur, delay: Math.min(i, 7) * (stepMs / 1000), ease: EASE }
      ).finished.then(() => {
        // hand the resting transform back to CSS (:hover lift, etc.)
        t.style.transform = '';
        t.style.opacity = '';
      }).catch(() => {});
      return () => {};        // no leave animation
    }, { amount: 0.12 });
  });
}

// ── Press gesture (spring scale) ─────────────────────────────────────────────
function pressable(root, selector) {
  root.querySelectorAll(selector).forEach((el) => {
    if (el.__press) return;
    el.__press = true;
    press(el, (target) => {
      if (reduced()) return () => {};
      animate(target, { scale: 0.96 }, { duration: 0.12, ease: 'easeOut' });
      return () => animate(target, { scale: 1 }, SPRING);
    });
  });
}

// ── Hover gesture (spring lift) — pointer devices only ───────────────────────
function hoverable(root, selector, lift = -3) {
  if (!matchMedia('(hover: hover)').matches) return;
  root.querySelectorAll(selector).forEach((el) => {
    if (el.__hover) return;
    el.__hover = true;
    hover(el, (target) => {
      if (reduced()) return () => {};
      animate(target, { y: lift }, SPRING);
      return () => animate(target, { y: 0 }, SPRING);
    });
  });
}

// ── Enhance a subtree (idempotent — guards on element flags) ─────────────────
function enhance(root) {
  if (!root || !root.querySelectorAll) return;
  reveal(root, '.jcard');
  reveal(root, '.dep-row', { y: 14, stepMs: 35 });
  reveal(root, '.sv-stop, .fstop-row, .fstop-item, .c-tl__item', { y: 10, stepMs: 20, dur: 0.32 });
  reveal(root, '.sv-legc, .sv-position-pre, .sv-vehicle-marker', { y: 12, stepMs: 40 });
  reveal(root, '.route-veh', { y: 12, stepMs: 30 });
  pressable(root, '.jexpand-btn, .home-cta, .btn, .fav-search-btn, .loc-chip, .mb, .dat-pill, .sv-legc-cta, .sv-legc, .sv-more, .sv-car-seg, .fstop-chip, .dep-more-btn, .dep-seg-btn, #route-check-btn, #fav-banner-btn');
  hoverable(root, '.loc-chip, .fav-card', -2);
}

// ── Wire up: observe the dynamic result containers ───────────────────────────
function start() {
  const roots = ['journey-results', 'depart-results']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  // Also watch the app shell for overlay screens (stops view, sheets) inserted later.
  const shell = document.querySelector('.app') || document.body;

  const run = (node) => { try { enhance(node); } catch { /* never break render */ } };

  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.addedNodes.length) run(r.target);
    }
  });
  [...roots, shell].forEach((n) => obs.observe(n, { childList: true, subtree: true }));

  // Initial pass for anything already on screen.
  run(shell);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
