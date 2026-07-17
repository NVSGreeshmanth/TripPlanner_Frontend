// Weather (Open-Meteo, no API key, Sydney coords). Self-contained: imports only
// core primitives. The "repaint home after a fetch" side effect is injected via
// setWeatherRepaint so this module never imports back from the app entry.
import { byId, wxState } from './core.js';

// Day icons (weathercode → [emoji, label])
const WX_DAY = {
  0:['☀️','Sunny'], 1:['🌤','Mostly sunny'], 2:['⛅','Partly cloudy'], 3:['☁️','Overcast'],
  45:['🌫','Foggy'], 48:['🌫','Foggy'],
  51:['🌦','Drizzle'], 53:['🌦','Drizzle'], 55:['🌦','Drizzle'],
  61:['🌧','Rain'], 63:['🌧','Rain'], 65:['🌧','Heavy rain'],
  71:['❄️','Snow'], 73:['❄️','Snow'], 75:['❄️','Heavy snow'], 77:['🌨','Snow'],
  80:['🌦','Showers'], 81:['🌦','Showers'], 82:['⛈','Heavy showers'],
  95:['⛈','Thunderstorm'], 96:['⛈','Thunderstorm'], 99:['⛈','Thunderstorm'],
};
// Night overrides — only for clear/mostly-clear codes; the rest are the same
const WX_NIGHT = { 0:['🌙','Clear night'], 1:['🌙','Mostly clear'], 2:['☁️','Partly cloudy'] };

export function wxInfo(code) {
  const isNight = wxState.data && wxState.data.isDay === 0;
  const night = isNight ? (WX_NIGHT[code] || null) : null;
  return night || WX_DAY[code] || WX_DAY[Math.floor(code / 10) * 10] || ['🌡','—'];
}
export function weatherPillHtml() {
  if (!wxState.data) return '';
  const [ico, lbl] = wxInfo(wxState.data.code);
  return `<span class="weather-pill" title="Sydney weather · ${lbl}">${ico} ${wxState.data.temp}°C</span>`;
}
export function weatherHomeHtml() {
  if (!wxState.data) return '';
  const [ico, lbl] = wxInfo(wxState.data.code);
  return `<div class="home-weather">
    <span class="home-weather-ico">${ico}</span>
    <span class="home-weather-temp">${wxState.data.temp}°C</span>
    <span class="home-weather-dot">·</span>
    <span>${lbl}</span>
    <span class="home-weather-dot">·</span>
    <span style="font-size:11px;opacity:0.7">Sydney</span>
  </div>`;
}

// Repaint hook — app.js injects a callback that repaints Home when a fetch lands.
let _repaint = null;
export function setWeatherRepaint(fn) { _repaint = fn; }

export async function fetchWeather() {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-33.87&longitude=151.21&current=weathercode,temperature_2m,is_day&timezone=Australia%2FSydney&forecast_days=1');
    if (!r.ok) return;
    const d = await r.json();
    wxState.data = {
      code:  d.current.weathercode,
      temp:  Math.round(d.current.temperature_2m),
      isDay: d.current.is_day,   // 1 = daytime, 0 = night
    };
    // First fetch usually resolves after the initial home paint — repaint so the
    // weather strip appears without the user having to switch tabs.
    if (byId('page-home')?.style.display !== 'none') _repaint?.();
  } catch {}
}

// Refresh weather when the app is foregrounded (visible/focus). Throttled to once
// per 60 s so quick tab-switching doesn't hammer Open-Meteo.
export function _maybeRefreshWeather() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - wxState.lastFetch < 60 * 1000) return;
  wxState.lastFetch = Date.now();
  fetchWeather();
}
