import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseThreadDump } from '@incident-investigator/core';
import { AnalysisService, extractTimestamp } from '../services/analysis-service';

export class StaticAnalysisPanel {
  static show(_context: vscode.ExtensionContext, analysisService: AnalysisService) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.staticAnalysis',
      'Static Analysis',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const nonce = crypto.randomBytes(16).toString('hex');
    panel.webview.html = buildHtml(nonce);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.type === 'browse') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: 'Add',
          title: String(msg.title ?? 'Select Files'),
          filters: {
            'Text & Dump Files': ['txt', 'log', 'dump', 'tdump', 'jfr', 'out', 'xml', 'json', 'csv'],
            'All Files': ['*']
          }
        });
        if (uris?.length) {
          panel.webview.postMessage({
            type: 'filesAdded',
            section: msg.section,
            files: uris.map(u => ({ path: u.fsPath, name: path.basename(u.fsPath) }))
          });
        }
      }

      if (msg.type === 'analyze') {
        const tdFiles = (msg.threadDumps as Array<{ path: string; name: string }>) ?? [];
        const logFiles = (msg.logs as Array<{ path: string; name: string }>) ?? [];
        const topFiles = (msg.topOutputs as Array<{ path: string; name: string }>) ?? [];

        const signals = [];
        const parseErrors: string[] = [];

        for (const f of tdFiles) {
          try {
            const content = fs.readFileSync(f.path, 'utf-8');
            signals.push(parseThreadDump(content, extractTimestamp(content)));
          } catch {
            parseErrors.push(f.name);
          }
        }

        const findings = signals.length > 0 ? analysisService.rerun(signals) : [];

        panel.webview.postMessage({
          type: 'results',
          findings,
          counts: {
            threadDumps: signals.length,
            logs: logFiles.length,
            topOutputs: topFiles.length,
            parseErrors: parseErrors.length
          },
          parseErrors
        });
      }
    });
  }
}

function buildHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Static Analysis</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:800px}
h1{font-size:14px;font-weight:700;margin-bottom:6px}
.subtitle{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:20px;line-height:1.6}
.section{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:14px;margin-bottom:12px;background:var(--vscode-sideBar-background)}
.section-hdr{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.section-badge{font-size:9px;font-weight:800;padding:2px 6px;border-radius:2px;flex-shrink:0;letter-spacing:.05em;margin-top:2px}
.td-badge{background:#cca70022;color:#cca700;border:1px solid #cca70044}
.log-badge{background:#75beff22;color:#75beff;border:1px solid #75beff44}
.top-badge{background:#4ec9b022;color:#4ec9b0;border:1px solid #4ec9b044}
.section-meta{flex:1}
.section-title{font-size:12px;font-weight:600;margin-bottom:2px}
.section-desc{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5}
.section-exts{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;font-family:var(--vscode-editor-font-family,monospace);letter-spacing:.03em}
.file-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.chip{display:flex;align-items:center;gap:4px;padding:2px 8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:10px;font-size:11px;max-width:280px}
.chip-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.chip-remove{background:none;border:none;color:inherit;cursor:pointer;opacity:.6;font-size:12px;padding:0;line-height:1;flex-shrink:0}
.chip-remove:hover{opacity:1}
.empty-hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px;font-style:italic}
.browse-btn{padding:4px 10px;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:2px;cursor:pointer}
.browse-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
.actions{margin-top:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.run-btn{padding:6px 18px;font-size:12px;font-weight:600;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px;cursor:pointer}
.run-btn:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.run-btn:disabled{opacity:.4;cursor:not-allowed}
.run-hint{font-size:11px;color:var(--vscode-descriptionForeground)}
.results{margin-top:24px;display:none}
.results-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);padding-bottom:8px;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:12px}
.summary-box{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:14px;padding:8px 12px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:3px;line-height:1.8}
.summary-row{display:flex;align-items:center;gap:6px}
.s-badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:2px;letter-spacing:.04em;flex-shrink:0}
.finding-card{border:1px solid var(--vscode-panel-border);border-radius:3px;margin-bottom:8px;overflow:hidden}
.finding-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;font-size:11px;user-select:none}
.finding-hdr:hover{background:var(--vscode-list-hoverBackground)}
.badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:2px;letter-spacing:.04em;flex-shrink:0}
.badge.high{background:#f14c4c22;color:#f14c4c}
.badge.medium{background:#cca70022;color:#cca700}
.badge.low{background:#75beff22;color:#75beff}
.finding-name{font-weight:500;flex:1}
.chevron{font-size:10px;color:var(--vscode-descriptionForeground);transition:transform .12s;line-height:1}
.finding-card.open .chevron{transform:rotate(90deg)}
.finding-body{padding:8px 12px;font-size:11px;border-top:1px solid var(--vscode-panel-border);display:none;color:var(--vscode-descriptionForeground);line-height:1.8}
.finding-card.open .finding-body{display:block}
.no-findings{font-size:11px;color:var(--vscode-descriptionForeground);padding:20px 16px;text-align:center;border:1px dashed var(--vscode-panel-border);border-radius:3px;line-height:1.7}
</style>
</head>
<body>
<h1>Static Analysis</h1>
<p class="subtitle">
  Select files for each category below, then click <strong>Run Analysis</strong>.<br>
  Thread dumps are matched against your signature library. Logs and top output are recorded as context.
</p>

<!-- Thread Dumps -->
<div class="section">
  <div class="section-hdr">
    <span class="section-badge td-badge">TD</span>
    <div class="section-meta">
      <div class="section-title">Thread Dumps</div>
      <div class="section-desc">Java thread dump files — parsed and matched against signatures.</div>
      <div class="section-exts">.txt &nbsp;&middot;&nbsp; .log &nbsp;&middot;&nbsp; .tdump &nbsp;&middot;&nbsp; .jfr &nbsp;&middot;&nbsp; .dump</div>
    </div>
  </div>
  <div class="file-chips" id="chips-threadDumps"></div>
  <div class="empty-hint" id="empty-threadDumps">No thread dump files selected yet</div>
  <button class="browse-btn" id="browse-threadDumps">+ Add Thread Dumps</button>
</div>

<!-- Logs -->
<div class="section">
  <div class="section-hdr">
    <span class="section-badge log-badge">LOG</span>
    <div class="section-meta">
      <div class="section-title">Log Files</div>
      <div class="section-desc">Application, server, or GC log files — recorded as investigation context.</div>
      <div class="section-exts">.txt &nbsp;&middot;&nbsp; .log &nbsp;&middot;&nbsp; .out &nbsp;&middot;&nbsp; .xml &nbsp;&middot;&nbsp; .json</div>
    </div>
  </div>
  <div class="file-chips" id="chips-logs"></div>
  <div class="empty-hint" id="empty-logs">No log files selected yet</div>
  <button class="browse-btn" id="browse-logs">+ Add Log Files</button>
</div>

<!-- Top Output -->
<div class="section">
  <div class="section-hdr">
    <span class="section-badge top-badge">TOP</span>
    <div class="section-meta">
      <div class="section-title">Top / vmstat / iostat Output</div>
      <div class="section-desc">System resource snapshots — recorded as investigation context.</div>
      <div class="section-exts">.txt &nbsp;&middot;&nbsp; .log &nbsp;&middot;&nbsp; .out</div>
    </div>
  </div>
  <div class="file-chips" id="chips-topOutputs"></div>
  <div class="empty-hint" id="empty-topOutputs">No top output files selected yet</div>
  <button class="browse-btn" id="browse-topOutputs">+ Add Top Output</button>
</div>

<div class="actions">
  <button class="run-btn" id="run-btn" disabled>Run Analysis</button>
  <span class="run-hint" id="run-hint">Add at least one thread dump to enable analysis.</span>
</div>

<!-- Results -->
<div class="results" id="results">
  <div class="results-title">Results</div>
  <div id="summary-box"></div>
  <div id="findings-list"></div>
</div>

<script nonce="${nonce}">
window.onerror = function(msg, src, line) {
  var b = document.createElement('div');
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f14c4c;color:#fff;padding:6px 10px;font-size:11px;z-index:9999;font-family:monospace';
  b.textContent = 'JS Error (line ' + line + '): ' + msg;
  document.body.prepend(b);
};

const vscode = acquireVsCodeApi();
var files = { threadDumps: [], logs: [], topOutputs: [] };

function renderChips(section) {
  var list = files[section] || [];
  var container = document.getElementById('chips-' + section);
  var empty = document.getElementById('empty-' + section);
  container.innerHTML = '';
  list.forEach(function(f, i) {
    var chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML =
      '<span class="chip-name" title="' + esc(f.path) + '">' + esc(f.name) + '</span>' +
      '<button class="chip-remove" data-section="' + section + '" data-idx="' + i + '" title="Remove">&times;</button>';
    container.appendChild(chip);
  });
  empty.style.display = list.length ? 'none' : '';
  updateRunBtn();
}

function updateRunBtn() {
  var hasTd = files.threadDumps.length > 0;
  var btn = document.getElementById('run-btn');
  var hint = document.getElementById('run-hint');
  btn.disabled = !hasTd;
  if (hasTd) {
    var parts = [files.threadDumps.length + ' thread dump(s)'];
    if (files.logs.length) parts.push(files.logs.length + ' log(s)');
    if (files.topOutputs.length) parts.push(files.topOutputs.length + ' top output(s)');
    hint.textContent = 'Ready: ' + parts.join(', ') + '.';
  } else {
    hint.textContent = 'Add at least one thread dump to enable analysis.';
  }
}

// Remove chip via event delegation
document.body.addEventListener('click', function(e) {
  var btn = e.target && e.target.closest && e.target.closest('.chip-remove');
  if (!btn) return;
  var section = btn.dataset.section;
  var idx = Number(btn.dataset.idx);
  if (files[section]) { files[section].splice(idx, 1); renderChips(section); }
});

// Wire browse buttons
var BROWSE_TITLES = {
  threadDumps: 'Select Thread Dump Files',
  logs: 'Select Log Files',
  topOutputs: 'Select Top / vmstat / iostat Output Files'
};
['threadDumps', 'logs', 'topOutputs'].forEach(function(section) {
  document.getElementById('browse-' + section).addEventListener('click', function() {
    vscode.postMessage({ type: 'browse', section: section, title: BROWSE_TITLES[section] });
  });
});

// Run button
document.getElementById('run-btn').addEventListener('click', function() {
  this.disabled = true;
  this.textContent = 'Analyzing…';
  vscode.postMessage({ type: 'analyze', threadDumps: files.threadDumps, logs: files.logs, topOutputs: files.topOutputs });
});

// Finding cards toggle via delegation
document.getElementById('findings-list').addEventListener('click', function(e) {
  var hdr = e.target && e.target.closest && e.target.closest('.finding-hdr');
  if (hdr) hdr.closest('.finding-card').classList.toggle('open');
});

// Messages from extension
window.addEventListener('message', function(e) {
  var m = e.data;
  if (m.type === 'filesAdded') {
    var existing = new Set((files[m.section] || []).map(function(f) { return f.path; }));
    (m.files || []).forEach(function(f) { if (!existing.has(f.path)) { files[m.section] = files[m.section] || []; files[m.section].push(f); } });
    renderChips(m.section);
  }
  if (m.type === 'results') {
    renderResults(m);
  }
});

function renderResults(m) {
  var runBtn = document.getElementById('run-btn');
  runBtn.disabled = false;
  runBtn.textContent = 'Run Analysis';

  var resultsEl = document.getElementById('results');
  resultsEl.style.display = 'block';

  var counts = m.counts || {};
  var summaryEl = document.getElementById('summary-box');
  var rows = [];
  if (counts.threadDumps > 0) rows.push('<div class="summary-row"><span class="s-badge td-badge">TD</span>' + counts.threadDumps + ' thread dump(s) parsed &amp; analyzed</div>');
  if (counts.logs > 0) rows.push('<div class="summary-row"><span class="s-badge log-badge">LOG</span>' + counts.logs + ' log file(s) recorded</div>');
  if (counts.topOutputs > 0) rows.push('<div class="summary-row"><span class="s-badge top-badge">TOP</span>' + counts.topOutputs + ' top output file(s) recorded</div>');
  if (counts.parseErrors > 0) rows.push('<div class="summary-row" style="color:var(--vscode-errorForeground)">' + counts.parseErrors + ' file(s) could not be parsed</div>');
  var matchSummary = (m.findings && m.findings.length)
    ? '<strong>' + m.findings.length + ' signature match(es) found.</strong>'
    : 'No signature matches found.';
  summaryEl.innerHTML = '<div class="summary-box">' + rows.join('') + '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--vscode-panel-border)">' + matchSummary + '</div></div>';

  var listEl = document.getElementById('findings-list');
  listEl.innerHTML = '';
  if (!m.findings || !m.findings.length) {
    listEl.innerHTML = '<div class="no-findings">No signature matches found in the provided thread dumps.<br>Consider adding more thread dumps or reviewing the signature library.</div>';
    return;
  }
  m.findings.forEach(function(f) {
    var card = document.createElement('div');
    card.className = 'finding-card';
    var evLines = (f.evidence || []).map(function(ev) { return '<div>' + esc(ev) + '</div>'; }).join('');
    card.innerHTML =
      '<div class="finding-hdr">' +
        '<span class="badge ' + esc(f.confidence) + '">' + esc(f.confidence.toUpperCase()) + '</span>' +
        '<span class="finding-name">' + esc(f.signatureName) + '</span>' +
        '<span class="chevron">&#x203A;</span>' +
      '</div>' +
      '<div class="finding-body">' + (evLines || '<em>No supporting evidence details.</em>') + '</div>';
    listEl.appendChild(card);
  });

  resultsEl.scrollIntoView({ behavior: 'smooth' });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;
}
