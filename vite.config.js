import { defineConfig } from 'vite';

// Vanilla PWA build. Keep output filenames STABLE and flat at the dist root so the
// service worker's precache SHELL (['./', './styles.css', './app.js', './manifest.json'])
// keeps resolving — no content hashing (the SW's CACHE version handles cache-busting).
// public/ holds runtime assets Vite must copy verbatim: sw.js, manifest.json, icons.
export default defineConfig({
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    assetsDir: '.',            // emit assets at dist root, not dist/assets/
    cssCodeSplit: false,       // one styles.css, not per-entry chunks
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',   // styles.css stays styles.css
      },
    },
  },
});
