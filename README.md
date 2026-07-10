# TripPlanner Frontend

NSW Journey Planner PWA (vanilla JS, Vite). Deploys to Netlify.

## Dev
```
npm install
npm run dev       # vite dev server
npm run build     # -> dist/
npm run preview   # serve dist on :4173
npm test          # lint + build + logic harness
```

## Structure
- `app.js` — entry + journey orchestration + window bridge
- `src/` — ES modules (core, i18n, stops, vehicles, tracking, alerts, weather, prefs, line_colors)
- `public/` — sw.js, manifest, icons, `_headers` (Netlify security headers for drag-drop)

## Deploy (Netlify)
- Connect repo: Netlify reads `netlify.toml` (`npm run build` -> `dist/`).
- Or drag `dist/`: `public/_headers` ships inside it, so CSP/security headers apply.

Backend API proxy: separate repo (TripPlanner_Backend on Render).
