#!/usr/bin/env node
/* Pure-logic regression tests for app.js — zero dependencies.
 *
 * app.js is a browser script (no exports), so we load it into a vm context with
 * minimal DOM/timer/fetch shims. Function declarations are hoisted, so every
 * top-level `function foo(){}` is available on the context EVEN IF the bottom
 * init throws against the stub DOM (we catch that). We then exercise the pure
 * helpers that the render layer depends on — the net that guards refactors.
 *
 * Run:  node tests/test_app_logic.js   (exit 0 = pass, 1 = fail)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Minimal browser shims (enough for app.js to define its functions) ────────
const noop = () => {};
const stubEl = () => new Proxy({
  style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  children: [], value: '', textContent: '', innerHTML: '',
  addEventListener: noop, removeEventListener: noop, appendChild: noop, removeChild: noop,
  setAttribute: noop, removeAttribute: noop, getAttribute: () => null, remove: noop,
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  scrollIntoView: noop, scrollBy: noop, focus: noop, blur: noop, click: noop,
  insertAdjacentHTML: noop, cloneNode() { return stubEl(); },
}, { get(t, k) { return k in t ? t[k] : (typeof k === 'string' ? noop : undefined); } });

const store = new Map();
const ctx = {
  console, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp,
  Map, Set, Promise, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  URLSearchParams, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  requestAnimationFrame: () => 0, cancelAnimationFrame: noop, fetch: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  location: { hostname: 'localhost', host: 'localhost:10000', protocol: 'http:', href: 'http://localhost/' },
  // Leaflet sniffs navigator.platform.indexOf('Mac') at module scope — undefined
  // there throws before any app code runs.
  navigator: { onLine: true, language: 'en', userAgent: 'node', platform: 'node', maxTouchPoints: 0, serviceWorker: { register: () => Promise.resolve() } },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop }),
  // Vite's modulepreload polyfill runs at the top of the bundle and uses
  // MutationObserver — without this stub it throws before app code executes.
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  // Same problem, different global: the motion library builds its frame scheduler
  // at module scope with `queueMicrotask`. The context is a whitelist, so it isn't
  // inherited from Node — without it the bundle throws before the test bridges run
  // and EVERY test reports "not found on context". Stubbed like setTimeout: the
  // pure-logic tests never need the callback to actually fire.
  queueMicrotask: noop,
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  addEventListener: noop, removeEventListener: noop,
  history: { pushState: noop, go: noop, back: noop }, performance: { now: () => 0 },
  // Leaflet's retina check reads screen.deviceXDPI at module scope.
  screen: { deviceXDPI: 96, logicalXDPI: 96, width: 1024, height: 768 },
  devicePixelRatio: 1,
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
// Persist one element per id so a captured container (journey-results) keeps the
// innerHTML that render code assigns — lets us assert on rendered output.
const _els = new Map();
const elFor = id => { if (!_els.has(id)) _els.set(id, stubEl()); return _els.get(id); };
ctx.document = {
  getElementById: elFor, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => stubEl(), body: stubEl(), documentElement: stubEl(),
  addEventListener: noop, removeEventListener: noop, hidden: false, cookie: '',
};
ctx.__elFor = elFor;

vm.createContext(ctx);
// Load the BUILT bundle (dist/app.js) so tests are decoupled from source file
// layout — this lets app.js be split into ES modules without touching the harness.
// The bundle exposes its test surface via the Object.assign(globalThis, …) bridges
// at the end of the entry. Falls back to raw source if dist isn't built yet.
const _dist = path.join(__dirname, '..', 'dist', 'app.js');
const _src  = path.join(__dirname, '..', 'app.js');
const _target = fs.existsSync(_dist) ? _dist : _src;
try {
  vm.runInContext(fs.readFileSync(_target, 'utf8'), ctx, { filename: path.basename(_target) });
} catch (e) {
  // Bottom-of-file init runs against stubs and may throw — functions are already
  // hoisted onto the context, so pure-logic tests below still work.
  if (process.env.DEBUG) console.error('init (expected against stubs):', e.message);
}

// ── Tiny assert harness ──────────────────────────────────────────────────────
let fails = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w; fails += !ok;
  console.log(`  ${ok ? 'OK ' : 'XXX'}  ${name}${ok ? '' : `  got ${g} want ${w}`}`);
};
const truthy = (name, got) => { const ok = !!got; fails += !ok; console.log(`  ${ok ? 'OK ' : 'XXX'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)}`}`); };
const need = n => { if (typeof ctx[n] !== 'function') { console.log(`  XXX  ${n} not found on context`); fails++; return false; } return true; };

// ── Tests: pure helpers the render layer depends on ──────────────────────────
if (need('delayMins')) {
  eq('delayMins on-time', ctx.delayMins('2026-06-18T03:00:00Z', '2026-06-18T03:00:00Z'), 0);
  eq('delayMins +3', ctx.delayMins('2026-06-18T03:00:00Z', '2026-06-18T03:03:00Z'), 3);
  eq('delayMins early -2', ctx.delayMins('2026-06-18T03:05:00Z', '2026-06-18T03:03:00Z'), -2);
}
if (need('isWalkLeg')) {
  eq('isWalkLeg walk cls100', ctx.isWalkLeg({ transportation: { product: { class: 100 } } }), true);
  eq('isWalkLeg transit', ctx.isWalkLeg({ transportation: { product: { class: 1 } } }), false);
}
if (need('_evIsRealtime')) {
  eq('_evIsRealtime estimated', ctx._evIsRealtime({ departureTimeEstimated: 'x' }), true);
  eq('_evIsRealtime controlled', ctx._evIsRealtime({ isRealtimeControlled: true }), true);
  eq('_evIsRealtime none', ctx._evIsRealtime({}), false);
}
if (need('vpMatchesRoute')) {
  eq('vpMatchesRoute bus token', ctx.vpMatchesRoute('2508_144', '144'), true);
  eq('vpMatchesRoute ferry', ctx.vpMatchesRoute('9-F3-sj2-1', 'F3'), true);
  eq('vpMatchesRoute no F1!=F10', ctx.vpMatchesRoute('9-F10-x', 'F1'), false);
}
if (need('_indexByRoute') && need('_vpByRouteName')) {
  // index + lookup agree with vpMatchesRoute
  const veh = [{ route_id: '2508_144', ts: 1 }, { route_id: '9-F3-sj2-1', ts: 2 }];
  const idx = ctx._indexByRoute(veh);
  truthy('_indexByRoute finds 144', idx.get('144') && idx.get('144').route_id === '2508_144');
  truthy('_indexByRoute finds F3', idx.get('F3') && idx.get('F3').route_id === '9-F3-sj2-1');
  truthy('_indexByRoute miss', idx.get('999') === undefined);
}
if (need('stableUid')) {
  const a = ctx.stableUid('2026-06-18T03:00:00Z', '2026-06-18T03:40:00Z');
  const b = ctx.stableUid('2026-06-18T03:00:00Z', '2026-06-18T03:40:00Z');
  eq('stableUid deterministic', a, b);
  truthy('stableUid distinct', a !== ctx.stableUid('2026-06-18T04:00:00Z', '2026-06-18T04:40:00Z'));
}
if (need('countdown')) {
  const soon = ctx.countdown(new Date(Date.now() + 2 * 60000).toISOString());
  truthy('countdown soon cls', soon.cls === 'soon' || soon.cls === '');
  const gone = ctx.countdown(new Date(Date.now() - 5 * 60000).toISOString());
  eq('countdown gone cls', gone.cls, 'gone');
}
if (need('estDep') && need('estArr')) {
  const leg = { origin: { departureTimeEstimated: 'E', departureTimePlanned: 'P' },
                destination: { arrivalTimeEstimated: 'AE', arrivalTimePlanned: 'AP' } };
  eq('estDep prefers estimated', ctx.estDep(leg), 'E');
  eq('estArr prefers estimated', ctx.estArr(leg), 'AE');
}

// ── Render-flow smoke test (exercises the journey-card + global-state path) ──
// Drives renderJourneys with one upcoming journey and asserts a card is produced
// into #journey-results. This is the net that covers the render/global refactor.
if (need('renderJourneys')) {
  const soon  = new Date(Date.now() + 10 * 60000).toISOString();
  const soon2 = new Date(Date.now() + 15 * 60000).toISOString();
  const leg = {
    transportation: { product: { class: 1 }, disassembledName: 'T1', number: 'T1',
                      destination: { name: 'Berowra' }, properties: {} },
    origin:      { name: 'Central', disassembledName: 'Central',
                   departureTimePlanned: soon, departureTimeEstimated: soon },
    destination: { name: 'Town Hall', disassembledName: 'Town Hall',
                   arrivalTimePlanned: soon2, arrivalTimeEstimated: soon2 },
    stopSequence: [],
  };
  try {
    ctx.currentJourneyData = { journeys: [leg && { legs: [leg] }] };
    ctx.renderJourneys(ctx.currentJourneyData, null, false);
    const html = ctx.__elFor('journey-results').innerHTML || '';
    truthy('renderJourneys emits a jcard', html.includes('jcard'));
    truthy('renderJourneys shows route badge T1', html.includes('T1'));
  } catch (e) {
    console.log('  XXX  renderJourneys threw: ' + e.message); fails++;
  }
}

// ── Departures render smoke test (covers the dep{} state cluster) ────────────
if (need('renderDepartures')) {
  const soon = new Date(Date.now() + 5 * 60000).toISOString();
  const ev = {
    departureTimePlanned: soon, departureTimeEstimated: soon, isRealtimeControlled: true,
    transportation: { product: { class: 1 }, disassembledName: 'T1', number: 'T1', destination: { name: 'Berowra' } },
    location: { name: 'Central', disassembledName: 'Central', properties: {} },
  };
  try {
    ctx.renderDepartures({ stopEvents: [ev] }, false);
    const html = ctx.__elFor('depart-results').innerHTML || '';
    truthy('renderDepartures emits a dep-row', html.includes('dep-row'));
    truthy('renderDepartures shows line T1', html.includes('T1'));
  } catch (e) {
    console.log('  XXX  renderDepartures threw: ' + e.message); fails++;
  }
}

// ── Home render runs cleanly (covers the homeState{} cluster) ────────────────
for (const fn of ['renderHome', 'renderFavsPage', 'startHomeTimer', 'stopHomeTimer']) {
  if (need(fn)) {
    try { ctx[fn](); truthy(fn + ' runs', true); }
    catch (e) { console.log('  XXX  ' + fn + ' threw: ' + e.message); fails++; }
  }
}

// ── Prefs apply functions run cleanly (covers the pref{} cluster) ────────────
for (const fn of ['applyTheme', 'applyAccent', 'applyFont']) {
  if (need(fn)) {
    try { ctx[fn](); truthy(fn + ' runs', true); }
    catch (e) { console.log('  XXX  ' + fn + ' threw: ' + e.message); fails++; }
  }
}

// ── Stops-overlay open/refresh/close runs (covers the svState{} cluster) ─────
if (need('openStopsView') && need('closeStopsView') && need('refreshStopsView')) {
  try {
    const s1 = new Date(Date.now() + 10 * 60000).toISOString();
    const s2 = new Date(Date.now() + 15 * 60000).toISOString();
    const leg = {
      transportation: { product: { class: 1 }, disassembledName: 'T1', number: 'T1', destination: { name: 'B' }, properties: {} },
      origin:      { name: 'Central', disassembledName: 'Central', departureTimePlanned: s1, departureTimeEstimated: s1 },
      destination: { name: 'Town Hall', disassembledName: 'Town Hall', arrivalTimePlanned: s2, arrivalTimeEstimated: s2 },
      stopSequence: [],
    };
    ctx.renderJourneys({ journeys: [{ legs: [leg] }] }, null, false);  // populates stops-data map
    const uid = ctx.stableUid(s1, s2);
    ctx.refreshStopsView();   // no-op while closed
    ctx.openStopsView(uid);   // open against stub DOM
    ctx.refreshStopsView();   // open → rebuild legs
    ctx.closeStopsView();     // teardown
    truthy('stops view open/refresh/close runs', true);
  } catch (e) { console.log('  XXX  stops view threw: ' + e.message); fails++; }
}

console.log(`\n${fails ? 'FAIL' : 'PASS'} — ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
