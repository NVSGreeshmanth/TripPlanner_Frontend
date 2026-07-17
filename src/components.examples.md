# Component Library — Usage

All components live in [`src/components.js`](./components.js); styles in
[`src/components.css`](./components.css) (imported automatically). Two shapes:

- **String factories** — return an HTML string. Drop into any `innerHTML` render.
  All user text is `esc()`-escaped inside; pass pre-built HTML only via documented
  raw slots (`body`, `footer`, `media`).
- **Imperative controllers** — `toast`, `modal`, `loadingOverlay`, `autocomplete`.
  Return a handle (`close` / `hide` / `destroy`) for teardown.

Wire clicks with **one** `bindActions(container, handlers)` per container — never
inline `onclick`. Handlers receive `(element, event)`.

## Architecture

```
core.js  ──esc()──▶  components.js  ──▶  components.css
                          │
                   app.js / features  ──renders strings──▶  innerHTML
                          │
                   bindActions(root, { … })  ◀── one delegated listener
```

Props follow one convention: a single options object with safe defaults, so every
call site is self-documenting and forward-compatible.

## Core primitives

```js
import { button, iconButton, badge, spinner, skeleton, card } from './components.js';

button({ label: 'Plan trip', variant: 'primary', action: 'plan' });
button({ label: 'Saving…', loading: true });              // disabled + aria-busy + spinner
iconButton({ iconName: 'star', ariaLabel: 'Save', pressed: true });   // ariaLabel required
badge({ text: 'On time', variant: 'success' });
badge({ text: 'T1', bg: '#F99D1C', fg: '#fff' });          // brand line colour
spinner({ standalone: true, label: 'Loading departures' });
skeleton({ lines: 3, avatar: true });                      // reserves layout space

card({
  title: 'Central', subtitle: 'Platform 18',
  text: 'Next service in 4 min',
  variant: 'elevated', action: 'openStop', dataset: { stop: '2000' },
});
```

## Forms

`field()` returns `{ html, id }` — use `id` to read the value after render.

```js
import { field, autocomplete } from './components.js';

const from = field({ label: 'From', iconName: 'search', placeholder: 'Station or stop',
                     autocomplete: 'off', required: true });
const when = field({ label: 'Depart', as: 'select', value: 'now',
                     options: [{ value: 'now', label: 'Leave now' },
                               { value: 'arr', label: 'Arrive by' }] });
container.innerHTML = from.html + when.html;
const fromValue = () => document.getElementById(from.id).value;

// Error state (aria-invalid + aria-describedby wired automatically):
field({ label: 'From', value: 'xyz', error: 'No matching stop found' });

// Combobox / async autocomplete (WAI-ARIA, keyboard + debounced):
const ac = autocomplete(document.getElementById('stop-search'), {
  label: 'Search stops',
  fetchItems: async (q) => (await fetch(`${PROXY}/stops?q=${q}`)).json(),
  onSelect: (item) => { state.from = { name: item.label, id: item.id }; },
});
// …later: ac.destroy();
```

## Data display

```js
import { serviceCard, stopTimeline, emptyState, errorState } from './components.js';

serviceCard({
  line: 'T1', lineBg: '#F99D1C',
  origin: { name: 'Central' }, destination: { name: 'Chatswood' },
  departTime: '14:32', arriveTime: '14:58',
  delay: 3, live: true, platform: 'Plat 18',
  badges: [{ text: 'Few seats', variant: 'warning' }],
  action: 'openJourney', dataset: { id: 'j1' },
});

stopTimeline({ stops, boardIdx: 2, alightIdx: 7, lineColor: '#F99D1C' });

// Edge cases — swap the whole slot:
list.innerHTML = results.length ? results.map(row).join('')
  : emptyState({ title: 'No services', message: 'Nothing scheduled in the next hour.',
                 action: { label: 'Show later', action: 'showLater' } });

list.innerHTML = errorState({ action: { label: 'Retry', action: 'retry' } });
bindActions(list, { retry: () => reload(), showLater: () => loadLater() });
```

## Feedback / overlay

```js
import { toast, modal, loadingOverlay } from './components.js';

toast('Trip saved', { type: 'success' });
toast('Network error', { type: 'error' });                 // assertive, longer

// Focus-trapped, ESC/backdrop close, restores focus to the invoker:
const dlg = modal({
  title: 'Delete favourite?',
  body: '<p>This removes it from all devices.</p>',
  actions: [
    { label: 'Cancel', variant: 'secondary', action: 'cancel' },
    { label: 'Delete', variant: 'danger', action: 'confirm' },
  ],
});
bindActions(dlg.el, { cancel: () => dlg.close(), confirm: () => { remove(); dlg.close(); } });

// Busy veil over a region (aria-busy set on the target):
const hide = loadingOverlay(document.getElementById('results'), { label: 'Refreshing' });
await refetch(); hide();
```

## Accessibility guarantees (baked in)

- Real `<button>`/`<a>`/`<label for>` — keyboard + screen-reader for free.
- Icon-only controls **require** `ariaLabel` (throws in dev).
- 44×44px min touch targets; ≥16px inputs (no iOS zoom).
- `:focus-visible` rings; `aria-busy`/`disabled` while loading.
- Modal: `role=dialog` + `aria-modal`, focus trap, scroll lock, focus restore.
- Combobox: `aria-expanded` / `-activedescendant` / `-controls`, `role=option`.
- Live regions: toasts/state blocks `role=status|alert` + `aria-live`.
- Honors `prefers-reduced-motion` and `prefers-color-scheme: dark`.
- All feed text `esc()`-escaped → XSS-safe.
