// Bundles content/index.ts into a single IIFE so it can be injected
// programmatically via chrome.scripting.executeScript (which requires
// a classic script with no ES module imports).
const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/content/index.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: path.join(__dirname, '../dist/content/index.js'),
});

console.log('Content script bundled.');
