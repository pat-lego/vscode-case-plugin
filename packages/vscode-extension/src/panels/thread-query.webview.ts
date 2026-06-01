import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseThreadDumpThreads, executeQuery, Thread } from '@incident-investigator/core';

interface SourceFile { name: string; fsPath: string; threadCount: number; error?: string }

export class ThreadQueryPanel {
  static show(context: vscode.ExtensionContext, uris: vscode.Uri[]) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.threadQuery',
      'Thread Dump Query',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    let allThreads: Thread[] = [];
    let sources: SourceFile[] = [];
    let threadSource = new WeakMap<Thread, string>();
    let lastQuery: string | null = null;
    let pendingRescan: ReturnType<typeof setTimeout> | undefined;

    const loadFromUris = (fileUris: vscode.Uri[]) => {
      allThreads = [];
      sources = [];
      threadSource = new WeakMap<Thread, string>();
      for (const uri of fileUris) {
        const name = path.basename(uri.fsPath);
        try {
          const raw = fs.readFileSync(uri.fsPath, 'utf-8');
          const threads = parseThreadDumpThreads(raw);
          for (const t of threads) threadSource.set(t, uri.fsPath);
          allThreads.push(...threads);
          sources.push({ name, fsPath: uri.fsPath, threadCount: threads.length });
        } catch (e) {
          sources.push({ name, fsPath: uri.fsPath, threadCount: 0, error: String(e) });
        }
      }
    };

    const sendQueryResult = (query: string) => {
      const result = executeQuery(allThreads, query);
      panel.webview.postMessage({
        type: 'queryResult',
        query,
        rows: result.rows,
        totalMatched: result.totalMatched,
        error: result.error,
        frames: result.threads?.map(t => t.frames),
        monitorLines: result.threads?.map(t => t.monitorLines),
        threadSources: result.threads?.map(t => threadSource.get(t) ?? ''),
      });
    };

    const scheduleRescan = () => {
      if (pendingRescan) { clearTimeout(pendingRescan); }
      pendingRescan = setTimeout(async () => {
        const found = await vscode.workspace.findFiles('**/*.dump', '**/node_modules/**');
        loadFromUris(found);
        panel.webview.postMessage({ type: 'init', sources, totalThreads: allThreads.length });
        if (lastQuery !== null) { sendQueryResult(lastQuery!); }
      }, 500);
    };

    // Initial load from the uris passed in (already scanned by the command)
    loadFromUris(uris);

    // Watch for workspace changes to any matching file
    const panelDisposables: vscode.Disposable[] = [];
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.dump');
    panelDisposables.push(
      watcher,
      watcher.onDidCreate(() => scheduleRescan()),
      watcher.onDidDelete(() => scheduleRescan()),
      watcher.onDidChange(() => scheduleRescan()),
    );

    panel.webview.html = buildHtml(context, panel.webview);

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'ready') {
        panel.webview.postMessage({ type: 'init', sources, totalThreads: allThreads.length });
      }

      if (msg.type === 'openFile') {
        const doc = await vscode.workspace.openTextDocument(msg.fsPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }

      if (msg.type === 'runQuery') {
        const q: string = msg.query ?? '';
        lastQuery = q;
        sendQueryResult(q);
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      panelDisposables.forEach(d => d.dispose());
      if (pendingRescan) { clearTimeout(pendingRescan); }
    }, undefined, context.subscriptions);
  }
}

function buildHtml(_context: vscode.ExtensionContext, _webview: vscode.Webview): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Thread Dump Query</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #444);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --tag-bg: var(--vscode-badge-background);
    --tag-fg: var(--vscode-badge-foreground);
    --table-header: var(--vscode-editorGroupHeader-tabsBackground);
    --row-hover: var(--vscode-list-hoverBackground);
    --error-fg: var(--vscode-errorForeground, #f48771);
    --muted: var(--vscode-descriptionForeground, #888);
    --font: var(--vscode-font-family, sans-serif);
    --mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 13px; padding: 16px; }

  /* Sources strip */
  #sources {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px;
    max-height: 70px; overflow-y: auto; padding-bottom: 2px;
    scrollbar-width: thin; scrollbar-color: var(--border) transparent;
  }
  #sources::-webkit-scrollbar { width: 6px; }
  #sources::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  .source-tag {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--tag-bg); color: var(--tag-fg);
    border-radius: 10px; padding: 2px 9px; font-size: 11px;
    cursor: context-menu;
  }
  .source-tag.error { background: var(--error-fg); color: #fff; }
  .source-count { opacity: 0.75; }

  /* Context menu */
  #ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, #ccc);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 4px 0; min-width: 180px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    display: none; user-select: none;
  }
  #ctx-menu.open { display: block; }
  .ctx-item {
    padding: 5px 14px; font-size: 12px; cursor: pointer;
  }
  .ctx-item:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }

  /* Query bar */
  #query-bar { display: flex; gap: 8px; margin-bottom: 10px; }
  #query-wrap { position: relative; flex: 1; }
  #query-highlight {
    position: absolute; inset: 0; padding: 6px 10px;
    background: var(--input-bg);
    border: 1px solid transparent; border-radius: 4px;
    font-family: var(--mono); font-size: 13px; line-height: 1.4;
    white-space: pre; overflow: hidden; pointer-events: none;
  }
  #query-input {
    position: relative; display: block; width: 100%; padding: 6px 10px;
    background: transparent; color: transparent; caret-color: var(--fg);
    border: 1px solid var(--input-border); border-radius: 4px;
    font-family: var(--mono); font-size: 13px; line-height: 1.4;
  }
  #query-input:focus { outline: 1px solid var(--btn-bg); }
  #query-input::placeholder { color: var(--muted); opacity: 0.7; }
  /* syntax token colours */
  .hl-pipe  { color: var(--btn-bg); font-weight: 700; }
  .hl-cmd   { color: #9cdcfe; }
  .hl-kw    { color: #c586c0; }
  .hl-field { color: #4ec9b0; }
  .hl-op    { color: var(--fg); opacity: 0.55; }
  #run-btn {
    padding: 6px 14px;
    background: var(--btn-bg); color: var(--btn-fg);
    border: none; border-radius: 4px; cursor: pointer; font-size: 13px;
  }
  #run-btn:hover { background: var(--btn-hover); }

  /* Hints */
  #hint { font-size: 11px; color: var(--muted); margin-bottom: 14px; line-height: 1.6; }
  #hint code { font-family: var(--mono); background: var(--table-header); padding: 1px 4px; border-radius: 3px; }

  /* Summary bar */
  #summary { font-size: 12px; color: var(--muted); margin-bottom: 10px; min-height: 18px; }
  #summary .highlight { color: var(--fg); font-weight: 600; }
  #error-msg { color: var(--error-fg); font-size: 12px; margin-bottom: 8px; font-family: var(--mono); }

  /* Results table */
  #results-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left; padding: 6px 10px;
    background: var(--table-header);
    border-bottom: 1px solid var(--border);
    font-weight: 600; white-space: nowrap; cursor: pointer; user-select: none;
  }
  th:hover { opacity: 0.8; }
  th .sort-arrow { margin-left: 4px; opacity: 0.5; }
  td { padding: 5px 10px; border-bottom: 1px solid var(--border); font-family: var(--mono); word-break: break-all; }
  tr:hover td { background: var(--row-hover); }
  td.count-cell { font-weight: 600; text-align: right; font-family: var(--font); }
  .bar-wrap { display: flex; align-items: center; gap: 6px; }
  .bar { height: 8px; border-radius: 4px; background: var(--btn-bg); opacity: 0.7; min-width: 2px; }

  /* Stats table */
  .state-BLOCKED      { color: #f48771; }
  .state-WAITING      { color: #cca700; }
  .state-TIMED_WAITING{ color: #e8b64a; }
  .state-RUNNABLE     { color: #89d185; }
  .state-NEW, .state-TERMINATED { color: var(--muted); }

  /* Thread cards (non-stats) */
  .thread-card { border-bottom: 1px solid var(--border); }
  .thread-header {
    display: flex; align-items: baseline; gap: 8px;
    padding: 7px 4px; cursor: pointer; user-select: none;
  }
  .thread-header:hover { background: var(--row-hover); }
  .expand-icon { font-size: 10px; color: var(--muted); flex-shrink: 0; width: 12px; }
  .state-badge {
    flex-shrink: 0; font-size: 10px; font-weight: 700; font-family: var(--font);
    padding: 1px 6px; border-radius: 3px; letter-spacing: 0.03em;
  }
  .badge-BLOCKED       { background: #5c2322; color: #f48771; }
  .badge-WAITING       { background: #3d3000; color: #cca700; }
  .badge-TIMED_WAITING { background: #3d2e00; color: #e8b64a; }
  .badge-RUNNABLE      { background: #1e3a1e; color: #89d185; }
  .badge-NEW, .badge-TERMINATED { background: transparent; color: var(--muted); }
  .thread-name {
    flex: 1; font-family: var(--mono); font-size: 12px; word-break: break-all;
    user-select: text; cursor: text;
  }
  .thread-meta { flex-shrink: 0; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .copy-btn {
    flex-shrink: 0; opacity: 0; font-size: 11px; padding: 1px 5px;
    background: var(--table-header); color: var(--muted);
    border: 1px solid var(--border); border-radius: 3px;
    cursor: pointer; user-select: none; white-space: nowrap;
    transition: opacity 0.1s;
  }
  .thread-header:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { color: var(--fg); }
  .copy-btn.copied { color: #89d185; border-color: #89d185; }
  .thread-stack {
    display: none; padding: 6px 4px 10px 28px;
    max-height: 400px; overflow-y: auto;
  }
  .thread-stack.open { display: block; }
  .stack-frame {
    font-family: var(--mono); font-size: 11px; color: var(--muted);
    line-height: 1.7; white-space: pre;
  }
  .stack-frame.app { color: var(--fg); }
  .stack-frame.monitor-line { color: #cca700; opacity: 0.85; }

  #no-results { color: var(--muted); padding: 16px 0; font-style: italic; }
</style>
</head>
<body>

<div id="sources"></div>
<div id="ctx-menu"><div class="ctx-item" id="ctx-open">Open file in workspace</div></div>

<div id="query-bar">
  <div id="query-wrap">
    <div id="query-highlight" aria-hidden="true"></div>
    <input id="query-input" type="text" placeholder="state=BLOCKED | stats count by keyframe" spellcheck="false" autocomplete="off" />
  </div>
  <button id="run-btn">Run</button>
</div>

<div id="hint">
  <strong>Filter:</strong>
  <code>state=BLOCKED</code> &nbsp;
  <code>state!=RUNNABLE</code> &nbsp;
  <code>state IN (BLOCKED,WAITING)</code> &nbsp;
  <code>thread=*http-nio*</code> &nbsp;
  <code>frame=*HikariPool*</code> &nbsp;
  <code>stackdepth&gt;=10</code> &nbsp;
  <code>elapsed&gt;=60</code> &nbsp;
  <code>nid=0x3a8e</code>
  <br>
  <strong>Stats:</strong>
  <code>| stats count by state</code> &nbsp;
  <code>| stats count by keyframe</code> &nbsp;
  <code>| stats count by class</code> &nbsp;
  <code>| stats count</code> &nbsp;
  <code>| top 10</code>
  &nbsp;&nbsp;<strong>Fields:</strong> state &bull; thread &bull; frame &bull; keyframe &bull; class &bull; method &bull; stackdepth &bull; elapsed &bull; nid
</div>

<div id="error-msg" style="display:none"></div>
<div id="summary"></div>
<div id="no-results" style="display:none">No threads matched.</div>
<div id="results-wrap"></div>

<script>
const vscode = acquireVsCodeApi();
let lastRows          = [];
let lastFrames        = null;   // string[][] | null -- parallel to lastRows, only for non-stats
let lastMonitorLines  = null;   // string[][] | null -- monitor annotation lines per row
let lastThreadSources = null;   // string[] | null  -- fsPath per row, only for non-stats
let sortCol         = null;
let sortDir         = 1; // 1 = desc, -1 = asc

const qInput     = document.getElementById('query-input');
const qHighlight = document.getElementById('query-highlight');

// Tokenise query string and return highlighted HTML
function highlightQuery(raw) {
  const CMDS   = new Set(['STATS','COUNT','BY','TOP']);
  const KWS    = new Set(['AND','OR','WHERE','IN','NOT']);
  const FIELDS = new Set(['state','thread','frame','keyframe','topframe','class','package','method','stackdepth','elapsed','nid']);
  const out = [];
  let i = 0;
  while (i < raw.length) {
    // pipe
    if (raw[i] === '|') { out.push('<span class="hl-pipe">|</span>'); i++; continue; }
    // two-char operators
    const op2 = raw.slice(i, i + 2);
    if (op2 === '>=' || op2 === '<=' || op2 === '!=') {
      out.push('<span class="hl-op">' + op2 + '</span>'); i += 2; continue;
    }
    // single-char operators
    if (raw[i] === '=' || raw[i] === '>' || raw[i] === '<') {
      out.push('<span class="hl-op">' + raw[i] + '</span>'); i++; continue;
    }
    // word token
    const wm = raw.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.*/]*/);
    if (wm) {
      const w = wm[0]; const up = w.toUpperCase();
      let cls = null;
      if (CMDS.has(up)) cls = 'hl-cmd';
      else if (KWS.has(up)) cls = 'hl-kw';
      else if (FIELDS.has(w.toLowerCase())) cls = 'hl-field';
      out.push(cls ? '<span class="' + cls + '">' + escHtml(w) + '</span>' : escHtml(w));
      i += w.length; continue;
    }
    // everything else (spaces, parens, glob chars, values)
    out.push(escHtml(raw[i])); i++;
  }
  return out.join('');
}

function syncHighlight() {
  qHighlight.innerHTML = highlightQuery(qInput.value);
  qHighlight.scrollLeft = qInput.scrollLeft;
}

qInput.addEventListener('input',  syncHighlight);
qInput.addEventListener('scroll', () => { qHighlight.scrollLeft = qInput.scrollLeft; });

document.getElementById('run-btn').addEventListener('click', runQuery);
qInput.addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });

function runQuery() {
  vscode.postMessage({ type: 'runQuery', query: qInput.value.trim() });
}

window.addEventListener('message', e => {
  const msg = e.data;

  if (msg.type === 'init') {
    renderSources(msg.sources);
    document.getElementById('summary').innerHTML =
      'Loaded <span class="highlight">' + msg.totalThreads + '</span> threads across <span class="highlight">' + msg.sources.filter(s => !s.error).length + '</span> file(s). Enter a query above.';
  }

  if (msg.type === 'queryResult') {
    const errEl = document.getElementById('error-msg');
    if (msg.error) {
      errEl.textContent = 'Query error: ' + msg.error;
      errEl.style.display = '';
      document.getElementById('summary').textContent = '';
      document.getElementById('results-wrap').innerHTML = '';
      return;
    }
    errEl.style.display = 'none';
    lastRows          = msg.rows;
    lastFrames        = msg.frames ?? null;
    lastMonitorLines  = msg.monitorLines ?? null;
    lastThreadSources = msg.threadSources ?? null;
    sortCol           = null;
    renderResults(msg.rows, msg.totalMatched, lastFrames, lastMonitorLines, lastThreadSources);
  }
});

const ctxMenu  = document.getElementById('ctx-menu');
const ctxOpen  = document.getElementById('ctx-open');
let ctxFsPath  = '';

function showCtxMenu(x, y, fsPath) {
  ctxFsPath = fsPath;
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.add('open');
}
function hideCtxMenu() { ctxMenu.classList.remove('open'); }

ctxOpen.addEventListener('click', () => {
  if (ctxFsPath) vscode.postMessage({ type: 'openFile', fsPath: ctxFsPath });
  hideCtxMenu();
});
document.addEventListener('click',       hideCtxMenu);
document.addEventListener('contextmenu', hideCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });

function renderSources(sources) {
  const el = document.getElementById('sources');
  el.innerHTML = sources.map(s => {
    const fsAttr = escAttr(s.fsPath ?? '');
    if (s.error) return '<span class="source-tag error" title="' + escHtml(s.error) + '" data-fspath="' + fsAttr + '">' + escHtml(s.name) + ' &#x26A0;</span>';
    return '<span class="source-tag" data-fspath="' + fsAttr + '">' + escHtml(s.name) + ' <span class="source-count">(' + s.threadCount + ')</span></span>';
  }).join('');

  el.querySelectorAll('.source-tag').forEach(tag => {
    tag.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      showCtxMenu(e.clientX, e.clientY, tag.dataset.fspath);
    });
  });
}

// JVM frame prefixes -- dimmed in the stack view; app frames shown brighter
const JVM_PREFIXES = ['jdk.','java.','sun.','com.sun.','javax.','[Ljava.'];
function isAppFrame(f) { return !JVM_PREFIXES.some(p => f.startsWith(p)); }

function renderResults(rows, totalMatched, frames, monitorLines, threadSources) {
  const wrap    = document.getElementById('results-wrap');
  const noRes   = document.getElementById('no-results');
  const summary = document.getElementById('summary');

  if (!rows || rows.length === 0) {
    wrap.innerHTML = '';
    noRes.style.display = '';
    summary.innerHTML = 'Matched <span class="highlight">0</span> threads.';
    return;
  }
  noRes.style.display = 'none';

  const isStats = rows[0] && 'count' in rows[0];

  if (isStats) {
    summary.innerHTML = 'Matched <span class="highlight">' + totalMatched + '</span> threads &rarr; <span class="highlight">' + rows.length + '</span> groups.';
    renderStatsTable(wrap, rows, totalMatched);
  } else {
    summary.innerHTML = 'Matched <span class="highlight">' + totalMatched + '</span> threads.';
    renderThreadCards(wrap, rows, frames, monitorLines, threadSources);
  }
}

function renderStatsTable(wrap, rows, totalMatched) {
  const cols = Object.keys(rows[0]);
  const maxCount = Math.max(...rows.map(r => r.count || 0));

  let html = '<table><thead><tr>';
  cols.forEach(c => {
    const arrow = sortCol === c ? (sortDir > 0 ? '&#x2193;' : '&#x2191;') : '';
    html += '<th data-col="' + escAttr(c) + '">' + escHtml(c) + '<span class="sort-arrow">' + arrow + '</span></th>';
  });
  html += '</tr></thead><tbody>';

  rows.forEach(row => {
    html += '<tr>';
    cols.forEach(c => {
      const val = row[c];
      if (c === 'count') {
        const pct = maxCount > 0 ? Math.round((Number(val) / maxCount) * 100) : 0;
        html += '<td class="count-cell"><div class="bar-wrap"><div class="bar" style="width:' + pct + 'px"></div>' + escHtml(String(val)) + '</div></td>';
      } else if (c === 'state') {
        html += '<td class="state-' + escAttr(String(val)) + '">' + escHtml(String(val ?? '')) + '</td>';
      } else {
        html += '<td>' + escHtml(String(val ?? '')) + '</td>';
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) { sortDir = -sortDir; } else { sortCol = col; sortDir = col === 'count' ? 1 : -1; }
      const sorted = [...lastRows].sort((a, b) => {
        const av = a[col]; const bv = b[col];
        if (typeof av === 'number' && typeof bv === 'number') return (bv - av) * sortDir;
        return String(av ?? '').localeCompare(String(bv ?? '')) * sortDir;
      });
      renderResults(sorted, totalMatched, null, null, null);
    });
  });
}

function renderThreadCards(wrap, rows, frames, monitorLines, threadSources) {
  wrap.innerHTML = '';
  rows.forEach((row, i) => {
    const state    = String(row.state ?? '');
    const name     = String(row.thread ?? '');
    const depth    = row.stackdepth != null ? row.stackdepth + ' frames' : '';
    const elapsedVal = row.elapsed != null ? Math.round(Number(row.elapsed)) + 's' : '';
    const meta     = [depth, elapsedVal].filter(Boolean).join('  |  ');
    const fsPath   = threadSources ? (threadSources[i] ?? '') : '';

    const card   = document.createElement('div');
    card.className = 'thread-card';
    if (fsPath) {
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        showCtxMenu(e.clientX, e.clientY, fsPath);
      });
    }
    const threadFrames   = frames && frames[i] ? frames[i] : [];
    const threadMonitors = monitorLines && monitorLines[i] ? monitorLines[i] : [];

    const header = document.createElement('div');
    header.className = 'thread-header';
    header.innerHTML =
      '<span class="expand-icon">&#x25b6;</span>' +
      '<span class="state-badge badge-' + escAttr(state) + '">' + escHtml(state) + '</span>' +
      '<span class="thread-name">' + escHtml(name) + '</span>' +
      (meta ? '<span class="thread-meta">' + escHtml(meta) + '</span>' : '') +
      '<button class="copy-btn" title="Copy thread name">Copy</button>';

    const stackEl = document.createElement('div');
    stackEl.className = 'thread-stack';

    if (threadFrames.length > 0) {
      threadFrames.forEach(f => {
        const line = document.createElement('div');
        line.className = 'stack-frame' + (isAppFrame(f) ? ' app' : '');
        line.textContent = f;
        stackEl.appendChild(line);
      });
      threadMonitors.forEach(m => {
        const line = document.createElement('div');
        line.className = 'stack-frame monitor-line';
        line.textContent = m;
        stackEl.appendChild(line);
      });
    } else {
      const empty = document.createElement('div');
      empty.className = 'stack-frame';
      empty.textContent = '(no frames)';
      stackEl.appendChild(empty);
    }

    const copyBtn = header.querySelector('.copy-btn');
    copyBtn.addEventListener('click', e => {
      e.stopPropagation(); // don't toggle expand
      const ta = document.createElement('textarea');
      ta.value = name;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      document.execCommand('copy');
      document.body.removeChild(ta);
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1500);
    });

    header.addEventListener('click', () => {
      const open = stackEl.classList.toggle('open');
      header.querySelector('.expand-icon').innerHTML = open ? '&#x25bc;' : '&#x25b6;';
    });

    card.appendChild(header);
    card.appendChild(stackEl);
    wrap.appendChild(card);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }

// Tell the extension we're ready
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
