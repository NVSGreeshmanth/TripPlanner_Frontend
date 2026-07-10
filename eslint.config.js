import globals from 'globals';

// Minimal lint config with ONE purpose: catch forgotten imports during the
// app.js → ES-module split. `no-undef` flags any identifier used but neither
// defined in-file, imported, nor a known browser/ES global — i.e. exactly the
// "module uses byId without importing it" mistake that would otherwise only
// surface as a browser ReferenceError. Everything else is off to stay quiet.
export default [
  {
    files: ['app.js', 'src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
