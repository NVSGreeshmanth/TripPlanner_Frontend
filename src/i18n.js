// i18n runtime: the translation lookup t() + current language. `lang` lives on a
// mutable object (not a reassigned `let`) so feature modules can import `i18n` and
// read/set the live value across module boundaries. The orchestration that reacts
// to a language change (re-rendering, DOM sync) stays in app.js (setLang/applyLang).
import { TM } from './i18n_data.js';
import { _lsGet } from './core.js';

export const i18n = { lang: _lsGet('nsw_lang', 'en') };

// Look up a key in the current language, falling back to English, then the key.
export function t(k) { return (TM[i18n.lang] || TM.en)[k] || TM.en[k] || k; }
