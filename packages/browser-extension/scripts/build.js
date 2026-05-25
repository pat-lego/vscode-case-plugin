const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

fs.mkdirSync(path.join(root, 'dist/background'), { recursive: true });
fs.mkdirSync(path.join(root, 'dist/content'), { recursive: true });

// Background service worker — single IIFE, no ES module imports at runtime
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/background/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(root, 'dist/background/index.js'),
});

// Content script — single IIFE, injected as classic script
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/content/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(root, 'dist/content/index.js'),
});

// Popup script — single IIFE, written directly alongside popup.html
esbuild.buildSync({
  entryPoints: [path.join(root, 'src/popup/popup.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(root, 'popup/popup.js'),
});

console.log('Browser extension built.');
