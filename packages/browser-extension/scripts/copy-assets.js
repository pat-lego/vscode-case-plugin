// Copies static assets into dist/ after tsc compiles TypeScript
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Copy popup HTML and compiled popup JS
const popupDist = path.join(root, 'popup');
const popupHtmlSrc = path.join(root, 'popup', 'popup.html');
const popupJsSrc = path.join(root, 'dist', 'popup', 'popup.js');

if (!fs.existsSync(popupDist)) fs.mkdirSync(popupDist, { recursive: true });

// popup.html is already in popup/ — just ensure popup.js is alongside it
if (fs.existsSync(popupJsSrc)) {
  fs.copyFileSync(popupJsSrc, path.join(root, 'popup', 'popup.js'));
}

// Copy manifest
fs.copyFileSync(
  path.join(root, 'manifest.json'),
  path.join(root, 'dist', 'manifest.json')
);

console.log('Assets copied.');
