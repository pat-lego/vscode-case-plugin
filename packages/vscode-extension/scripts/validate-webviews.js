#!/usr/bin/env node
/**
 * Validates compiled webview HTML templates before packaging.
 *
 * Catches two classes of bug that are invisible at TypeScript compile time
 * but break VS Code's internal document.write() at runtime:
 *
 *   1. Non-ASCII characters in the HTML string (em dash, ellipsis, middle dot, etc.)
 *      VS Code 1.121+ throws SyntaxError when document.write() receives non-ASCII.
 *
 *   2. Unterminated string literals caused by \n / \t / \r written as escape
 *      sequences inside string literals that live inside a TypeScript template literal.
 *      The template literal engine evaluates \n to a real newline, splitting the JS
 *      string across lines — causing SyntaxError: Invalid or unexpected token.
 *
 * How it works:
 *   - Reads dist/extension.js after compilation.
 *   - Finds every template literal that contains <!DOCTYPE html>.
 *   - Strips ${...} interpolations (replacing with empty strings) so the static
 *     HTML shell can be evaluated without runtime values.
 *   - Evaluates with new Function() to get the same string the runtime would produce.
 *   - Checks for non-ASCII bytes in the evaluated HTML.
 *   - Runs vm.Script on every <script> block to catch JS syntax errors.
 *
 * Exit 0 = all templates pass.  Exit 1 = at least one error.
 */

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DIST_FILE = path.join(__dirname, '..', 'dist', 'extension.js');

if (!fs.existsSync(DIST_FILE)) {
  console.error('validate-webviews: dist/extension.js not found — run npm run build first');
  process.exit(1);
}

const code = fs.readFileSync(DIST_FILE, 'utf-8');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extracts the content of a backtick template literal starting at `startPos`
 * (the index of the opening backtick).  Correctly handles:
 *   - Escaped characters: \` \\ \n etc.
 *   - Nested ${...} interpolations (which may themselves contain nested templates)
 * Returns { content, end } where end is the index of the closing backtick,
 * or null if no closing backtick was found.
 */
function extractTemplateLiteral(src, startPos) {
  let i = startPos + 1; // skip opening `
  let depth = 0;        // ${ nesting depth

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      i += 2; // skip escape sequence
      continue;
    }

    if (depth === 0 && ch === '`') {
      return { content: src.slice(startPos + 1, i), end: i };
    }

    if (ch === '$' && src[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth--;
    }

    i++;
  }
  return null; // unterminated
}

/**
 * Replaces every ${...} interpolation (at the top level) with the string `""`.
 * This lets the remaining static HTML be evaluated without runtime values.
 */
function stripInterpolations(raw) {
  let result = '';
  let i = 0;
  let depth = 0;

  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\\') {
      if (depth === 0) result += ch + raw[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && raw[i + 1] === '{') {
      if (depth === 0) result += '""'; // placeholder for the interpolated value
      depth++;
      i += 2;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth--;
      i++;
      continue;
    }

    if (depth === 0) result += ch;
    i++;
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const errors = [];
let templateCount = 0;
let searchPos = 0;

while (true) {
  const doctypePos = code.indexOf('<!DOCTYPE html>', searchPos);
  if (doctypePos === -1) break;
  searchPos = doctypePos + 1;

  // Walk backward (up to 200 chars) to find the opening backtick.
  let openBacktick = -1;
  for (let i = doctypePos - 1; i >= Math.max(0, doctypePos - 200); i--) {
    if (code[i] === '`') { openBacktick = i; break; }
  }
  if (openBacktick === -1) continue;

  const extracted = extractTemplateLiteral(code, openBacktick);
  if (!extracted) continue;

  templateCount++;
  const label = `Template #${templateCount}`;
  const { content: rawContent } = extracted;

  // ── Evaluate the template literal with interpolations stripped ────────────
  const staticContent = stripInterpolations(rawContent);
  let html;
  try {
    // eslint-disable-next-line no-new-func
    html = new Function('return `' + staticContent + '`')();
  } catch (e) {
    errors.push(`${label}: Failed to evaluate static shell — ${e.message}`);
    continue;
  }

  // ── Check for non-ASCII characters ────────────────────────────────────────
  for (let i = 0; i < html.length; i++) {
    const cp = html.charCodeAt(i);
    if (cp > 127) {
      const ctx = html.slice(Math.max(0, i - 40), i + 40).replace(/\n/g, '\\n');
      errors.push(
        `${label}: Non-ASCII char U+${cp.toString(16).toUpperCase()} at position ${i}\n` +
        `    Context: ...${ctx}...`
      );
      break; // one report per template is enough
    }
  }

  // ── Validate every <script> block as JavaScript ───────────────────────────
  // [^]* matches any char including newlines (unlike .)
  const scriptRe = /<script(?:\s[^>]*)?>([^]*?)<\/script>/gi;
  let scriptMatch;
  let scriptIndex = 0;

  while ((scriptMatch = scriptRe.exec(html)) !== null) {
    scriptIndex++;
    const scriptContent = scriptMatch[1];
    if (!scriptContent.trim()) continue;

    try {
      new vm.Script(scriptContent);
    } catch (e) {
      const lines = scriptContent.split('\n');
      const lineNum = typeof e.lineNumber === 'number' ? e.lineNumber : null;
      const offendingLine = lineNum != null ? (lines[lineNum - 1] ?? '').trim() : '(unknown line)';

      errors.push(
        `${label} <script> block ${scriptIndex}: ${e.message}` +
        (lineNum != null ? `\n    Line ${lineNum}: ${offendingLine}` : '')
      );
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (templateCount === 0) {
  console.error('validate-webviews: No HTML templates found in dist/extension.js');
  process.exit(1);
}

if (errors.length > 0) {
  console.error(`\nWebview HTML validation FAILED (${templateCount} template(s) checked):\n`);
  for (const err of errors) {
    console.error('  ✗ ' + err.replace(/\n/g, '\n    '));
  }
  console.error('\nFix the issues above, then re-run: npm run build && node scripts/validate-webviews.js\n');
  process.exit(1);
}

console.log(`Webview HTML validation passed — ${templateCount} template(s) OK`);
