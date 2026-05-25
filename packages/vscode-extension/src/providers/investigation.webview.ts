import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CaseManager } from '../services/case-manager';
import { AnalysisService } from '../services/analysis-service';
import { ExportService } from '../services/export-service';
import { BridgeServer } from '../services/bridge-server';

export class InvestigationWebview {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private context: vscode.ExtensionContext,
    private caseManager: CaseManager,
    private analysisService: AnalysisService,
    private exportService: ExportService,
    private bridgeServer: BridgeServer
  ) {
    this.caseManager.onFindingsChange(({ caseId, findings }) => {
      this.panels.get(caseId)?.webview.postMessage({ type: 'findings', findings });
    });

    this.bridgeServer.onStatusChange(connected => {
      for (const panel of this.panels.values()) {
        panel.webview.postMessage({ type: 'bridgeStatus', connected });
      }
    });

    this.bridgeServer.onCapture(({ caseId, name }) => {
      const session = this.caseManager.getSession(caseId);
      const evArr = session?.meta.evidence ?? [];
      const ev = evArr[evArr.length - 1];
      if (ev) {
        this.panels.get(caseId)?.webview.postMessage({
          type: 'evidenceAdded',
          item: { id: ev.id, name, type: ev.type, timestamp: ev.capturedAt.toISOString() }
        });
      }
    });
  }

  openCase(caseId: string) {
    const existing = this.panels.get(caseId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.One);
      return;
    }

    const session = this.caseManager.getSession(caseId);
    if (!session) return;

    const panel = vscode.window.createWebviewPanel(
      'investigator.case',
      session.meta.id,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = this.buildHtml(session.meta.id, session.meta.title);
    this.panels.set(caseId, panel);
    this.caseManager.setActiveCase(caseId);

    panel.webview.onDidReceiveMessage(msg => this.handleMessage(caseId, msg));
    panel.onDidDispose(() => this.panels.delete(caseId));
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) this.caseManager.setActiveCase(caseId);
    });
  }

  private async handleMessage(caseId: string, msg: Record<string, unknown>) {
    const panel = this.panels.get(caseId);
    if (!panel) return;

    switch (String(msg.type)) {
      case 'ready': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        panel.webview.postMessage({ type: 'bridgeStatus', connected: this.bridgeServer.isConnected() });
        panel.webview.postMessage({
          type: 'initialState',
          evidence: session.meta.evidence.map(e => ({
            id: e.id,
            name: e.filePath ? path.basename(e.filePath) : e.id,
            type: e.type,
            timestamp: e.capturedAt.toISOString()
          })),
          findings: session.findings,
          notes: session.meta.notes ?? ''
        });
        break;
      }

      case 'addEvidence': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: true,
          openLabel: 'Add to Investigation',
          filters: {
            'Thread Dumps & Logs': ['txt', 'log', 'tdump'],
            'All Files': ['*']
          }
        });
        if (!uris?.length) return;
        for (const uri of uris) {
          const content = fs.readFileSync(uri.fsPath, 'utf-8');
          const name = path.basename(uri.fsPath);
          const { evidenceItem, findings } = this.analysisService.processEvidence(
            caseId, name, content, uri.fsPath
          );
          panel.webview.postMessage({
            type: 'evidenceAdded',
            item: {
              id: evidenceItem.id,
              name,
              type: evidenceItem.type,
              timestamp: evidenceItem.capturedAt.toISOString()
            }
          });
          if (findings.length > 0) {
            panel.webview.postMessage({ type: 'findings', findings });
          }
        }
        break;
      }

      case 'viewEvidence': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const ev = session.meta.evidence.find(e => e.id === String(msg.id));
        if (!ev) return;
        const pane = Number(msg.pane) || 0;
        const isImage = ev.type === 'screenshot' || /\.(png|jpg|jpeg|gif|webp)$/i.test(ev.filePath);
        const name = ev.filePath ? path.basename(ev.filePath) : ev.id;
        let content: string | null = null;
        let contentType = 'text';
        if (isImage) {
          if (ev.rawContent?.startsWith('data:')) {
            content = ev.rawContent;
            contentType = 'image';
          } else if (ev.filePath) {
            try {
              const data = fs.readFileSync(ev.filePath);
              const ext = path.extname(ev.filePath).slice(1).toLowerCase();
              const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : `image/${ext}`;
              content = `data:${mime};base64,${data.toString('base64')}`;
              contentType = 'image';
            } catch { content = null; }
          }
        } else {
          let text: string | undefined = ev.rawContent;
          if (!text && ev.filePath) {
            try { text = fs.readFileSync(ev.filePath, 'utf-8'); } catch { text = undefined; }
          }
          content = text ? text.slice(0, 200000) : null;
        }
        panel.webview.postMessage({ type: 'evidenceView', id: ev.id, name, pane, content, contentType });
        break;
      }

      case 'openEvidence': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const ev = session.meta.evidence.find(e => e.id === String(msg.id));
        if (!ev?.filePath) return;
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(ev.filePath));
        break;
      }

      case 'deleteEvidence': {
        const removed = this.caseManager.removeEvidence(caseId, String(msg.id));
        if (!removed) return;
        const session = this.caseManager.getSession(caseId);
        if (session) {
          const findings = this.analysisService.rerun([...session.threadDumpSignals.values()]);
          this.caseManager.updateFindings(caseId, findings);
        }
        panel.webview.postMessage({ type: 'evidenceRemoved', id: msg.id });
        break;
      }

      case 'saveNotes':
        this.caseManager.updateNotes(caseId, String(msg.notes ?? ''));
        break;

      case 'exportCase': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const mdPath = await this.exportService.exportCase(session);
        if (mdPath) vscode.window.showInformationMessage(`Exported to: ${mdPath}`);
        break;
      }

      case 'resolveCase':
        vscode.commands.executeCommand('investigator.resolveCase', caseId);
        break;

      case 'fullReview':
        vscode.commands.executeCommand('investigator.fullReview', caseId);
        break;

      case 'askClaude':
        vscode.commands.executeCommand('investigator.askClaude', caseId, msg.signatureId);
        break;

      case 'openSignatureBuilder':
        vscode.commands.executeCommand('investigator.buildSignature', caseId, msg.finding);
        break;
    }
  }

  private buildHtml(caseId: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${caseId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0;gap:8px}
.header h2{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.header-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.bridge{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--vscode-descriptionForeground)}
.dot{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0}
.dot.on{background:#4ec9b0}
.workspace{display:flex;flex:1;overflow:hidden}
.col{display:flex;flex-direction:column;overflow:hidden}
.col.evidence{width:240px;flex-shrink:0}
.col.notes{flex:2}
.col.viewer{flex:1;min-width:200px}
.resize-handle{width:4px;flex-shrink:0;cursor:col-resize;background:var(--vscode-panel-border);transition:background .12s;user-select:none}
.resize-handle:hover,.resize-handle.active{background:var(--vscode-focusBorder)}
.col-header{padding:5px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;display:flex;align-items:center;justify-content:space-between;cursor:grab;user-select:none}
.col-header:active{cursor:grabbing}
.col-header.drag-src{opacity:.45}
.col-header.drag-over{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.col-drag-hint{font-size:9px;opacity:.45;margin-left:4px;font-weight:400;text-transform:none;letter-spacing:0}
.col-body{flex:1;overflow-y:auto;padding:8px}
.notes-area{flex:1;width:100%;resize:none;background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family,var(--vscode-font-family));font-size:var(--vscode-editor-font-size,var(--vscode-font-size));border:none;outline:none;padding:8px;line-height:1.6;box-sizing:border-box}
.notes-area::placeholder{color:var(--vscode-input-placeholderForeground)}
.save-indicator{font-size:9px;color:var(--vscode-descriptionForeground);opacity:0;transition:opacity .3s;padding-right:4px;cursor:default;text-transform:none;letter-spacing:0;font-weight:400}
.save-indicator.show{opacity:1}
.add-btn{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;border:1px dashed var(--vscode-panel-border);border-radius:3px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;background:none;width:100%;margin-bottom:6px}
.add-btn:hover{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
.ev-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;font-size:11px;cursor:pointer}
.ev-item:hover{background:var(--vscode-list-hoverBackground)}
.ev-item.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.ev-type{font-size:9px;font-weight:700;padding:1px 4px;border-radius:2px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);flex-shrink:0}
.ev-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ev-time{font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0}
.ev-ext{opacity:0;pointer-events:none;background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:11px;line-height:1;flex-shrink:0}
.ev-ext:hover{color:var(--vscode-foreground)}
.ev-item:hover .ev-ext{opacity:.6;pointer-events:auto}
.ev-del{opacity:0;pointer-events:none;background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:14px;line-height:1;flex-shrink:0}
.ev-del:hover{color:var(--vscode-errorForeground)}
.ev-item:hover .ev-del{opacity:1;pointer-events:auto}
.empty{text-align:center;padding:24px 12px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6}
.analysis-section{border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:6px;display:none}
.analysis-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);padding:3px 4px;cursor:pointer;display:flex;align-items:center;gap:5px;user-select:none;border-radius:2px}
.analysis-hdr:hover{color:var(--vscode-foreground);background:var(--vscode-list-hoverBackground)}
.analysis-cnt{font-size:9px;padding:1px 5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px}
.analysis-body{margin-top:6px;display:none}
.card{border:1px solid var(--vscode-panel-border);border-radius:3px;margin-bottom:6px;overflow:hidden}
.card-header{display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;font-size:11px;user-select:none}
.card-header:hover{background:var(--vscode-list-hoverBackground)}
.badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:2px;letter-spacing:.04em;flex-shrink:0}
.badge.high{background:#f14c4c22;color:#f14c4c}
.badge.medium{background:#cca70022;color:#cca700}
.badge.low{background:#75beff22;color:#75beff}
.card-name{font-weight:500;flex:1}
.chevron{font-size:10px;color:var(--vscode-descriptionForeground);transition:transform .12s;line-height:1}
.card.open .chevron{transform:rotate(90deg)}
.card-body{padding:8px 10px;font-size:11px;border-top:1px solid var(--vscode-panel-border);display:none}
.card.open .card-body{display:block}
.ev-lines{color:var(--vscode-descriptionForeground);margin-bottom:7px;line-height:1.7}
.actions{display:flex;flex-wrap:wrap;gap:5px}
.btn{padding:2px 8px;font-size:11px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn.accent{background:#cca70011;color:#cca700;border-color:#cca70044}
.btn.accent:hover{background:#cca70022}
.related{margin-top:6px;font-size:10px;color:var(--vscode-descriptionForeground)}
.timeline{height:50px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:5px 12px;flex-shrink:0}
.tl-label{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
.tl-bar{height:16px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:2px;position:relative;overflow:hidden}
.tl-mark{position:absolute;width:2px;height:100%;background:var(--vscode-focusBorder);opacity:.7;cursor:pointer}
.tl-mark:hover{opacity:1}
.viewer-body{flex:1;display:flex;flex-direction:column;overflow:hidden}
.viewer-pane{display:flex;flex-direction:column;overflow:hidden;flex:1;min-height:60px}
.viewer-pane-hdr{display:flex;align-items:center;gap:5px;padding:3px 8px;font-size:10px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.viewer-pane.focused .viewer-pane-hdr{background:var(--vscode-list-hoverBackground)}
.viewer-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-style:italic;font-size:10px}
.viewer-lbl.loaded{color:var(--vscode-foreground);font-style:normal}
.viewer-content{flex:1;overflow:auto;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;padding:8px;line-height:1.5}
.viewer-content pre{white-space:pre-wrap;word-break:break-all;margin:0}
.viewer-content img{max-width:100%;height:auto;display:block;margin:0 auto}
.viewer-empty{text-align:center;padding:32px 12px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.8}
.viewer-split-hnd{height:4px;flex-shrink:0;cursor:row-resize;background:var(--vscode-panel-border);transition:background .12s;display:none}
.viewer-split-hnd:hover,.viewer-split-hnd.active{background:var(--vscode-focusBorder)}
</style>
</head>
<body>
<div class="header">
  <h2>${caseId} — ${title}</h2>
  <div class="header-right">
    <div class="bridge"><div class="dot" id="dot"></div><span id="bridge-lbl">Disconnected</span></div>
    <button class="btn" onclick="send('resolveCase')">Resolve</button>
    <button class="btn primary" onclick="send('exportCase')">Export</button>
  </div>
</div>

<div class="workspace" id="workspace">
  <div class="col evidence" id="col-evidence">
    <div class="col-header" draggable="true" data-col="evidence">
      <span>Evidence<span class="col-drag-hint">drag to reorder</span></span>
    </div>
    <div class="col-body">
      <button class="add-btn" onclick="send('addEvidence')">＋ Add evidence files</button>
      <div id="ev-list"></div>
      <div class="analysis-section" id="analysis-section">
        <div class="analysis-hdr" onclick="toggleAnalysis()">
          Analysis
          <span class="analysis-cnt" id="analysis-cnt">0</span>
          <span class="chevron" id="analysis-chevron" style="margin-left:auto">&#x203A;</span>
        </div>
        <div class="analysis-body" id="analysis-body"></div>
      </div>
    </div>
  </div>
  <div class="resize-handle" id="handle-0"></div>
  <div class="col notes" id="col-notes">
    <div class="col-header" draggable="true" data-col="notes">
      <span>Notes<span class="col-drag-hint">drag to reorder</span></span>
      <span class="save-indicator" id="save-indicator">Saved</span>
    </div>
    <textarea class="notes-area" id="notes-area" placeholder="Write your investigation notes here…&#10;&#10;What did you observe? What have you tried? What's the current hypothesis?"></textarea>
  </div>
  <div class="resize-handle" id="handle-1"></div>
  <div class="col viewer" id="col-viewer">
    <div class="col-header" draggable="true" data-col="viewer">
      <span>Viewer<span class="col-drag-hint">drag to reorder</span></span>
      <button class="btn" id="split-btn" onclick="toggleSplit()" style="font-size:10px;padding:1px 6px;text-transform:none;letter-spacing:0;font-weight:400">Split</button>
    </div>
    <div class="viewer-body" id="viewer-body">
      <div class="viewer-pane focused" id="viewer-pane-0" onclick="focusPane(0)">
        <div class="viewer-pane-hdr">
          <span class="viewer-lbl" id="viewer-lbl-0">Click evidence to view</span>
          <button class="btn" id="viewer-ext-0" style="display:none;font-size:10px;padding:1px 5px;text-transform:none;letter-spacing:0;font-weight:400" onclick="extOpen(event,0)" title="Open in editor">Open &#x2197;</button>
        </div>
        <div class="viewer-content" id="viewer-content-0"><div class="viewer-empty">Click an evidence item to view its content here</div></div>
      </div>
      <div class="viewer-split-hnd" id="viewer-split-hnd"></div>
      <div class="viewer-pane" id="viewer-pane-1" style="display:none" onclick="focusPane(1)">
        <div class="viewer-pane-hdr">
          <span class="viewer-lbl" id="viewer-lbl-1">Click evidence to view</span>
          <button class="btn" id="viewer-ext-1" style="display:none;font-size:10px;padding:1px 5px;text-transform:none;letter-spacing:0;font-weight:400" onclick="extOpen(event,1)" title="Open in editor">Open &#x2197;</button>
          <button class="btn" onclick="closeSplit(event)" style="font-size:10px;padding:1px 5px;text-transform:none;letter-spacing:0;font-weight:400" title="Close split">&#x2715;</button>
        </div>
        <div class="viewer-content" id="viewer-content-1"><div class="viewer-empty">Click an evidence item to view its content here</div></div>
      </div>
    </div>
  </div>
</div>

<div class="timeline">
  <div class="tl-label">Timeline</div>
  <div class="tl-bar" id="tl-bar"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let items = [];
let saveTimer = null;

// ── Layout ────────────────────────────────────────────────────
const MIN_W = {evidence: 110, notes: 140, viewer: 200};
let colOrder = ['evidence', 'notes', 'viewer'];
const handles = [document.getElementById('handle-0'), document.getElementById('handle-1')];

function getCol(id) { return document.getElementById('col-' + id); }

function applyOrder() {
  const ws = document.getElementById('workspace');
  colOrder.forEach(function(id, i) {
    ws.appendChild(getCol(id));
    if (i < colOrder.length - 1) ws.appendChild(handles[i]);
  });
}

function saveLayout() {
  const widths = {};
  colOrder.forEach(function(id) { widths[id] = getCol(id).getBoundingClientRect().width; });
  vscode.setState({ colOrder: colOrder, widths: widths });
}

function loadLayout() {
  const s = vscode.getState();
  if (!s) return;
  if (s.colOrder && s.colOrder.length === 3) {
    colOrder = s.colOrder.map(function(c) { return c === 'findings' ? 'viewer' : c; });
  }
  applyOrder();
  if (s.widths) {
    colOrder.forEach(function(id) {
      const el = getCol(id);
      const w = s.widths[id] || (id === 'viewer' ? s.widths['findings'] : undefined);
      if (w && w > 0) { el.style.flex = 'none'; el.style.width = w + 'px'; }
    });
  }
}

// ── Resize handles ────────────────────────────────────────────
handles.forEach(function(handle) {
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const ws = document.getElementById('workspace');
    const children = Array.from(ws.children);
    const hIdx = children.indexOf(handle);
    const leftEl = children[hIdx - 1];
    const rightEl = children[hIdx + 1];
    if (!leftEl || !rightEl) return;

    let lw = leftEl.getBoundingClientRect().width;
    let rw = rightEl.getBoundingClientRect().width;
    leftEl.style.flex = 'none'; leftEl.style.width = lw + 'px';
    rightEl.style.flex = 'none'; rightEl.style.width = rw + 'px';

    const startX = e.clientX;
    const lId = leftEl.id.replace('col-', '');
    const rId = rightEl.id.replace('col-', '');

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const newLw = Math.max(MIN_W[lId] || 100, lw + dx);
      const newRw = Math.max(MIN_W[rId] || 100, rw - dx);
      leftEl.style.width = newLw + 'px';
      rightEl.style.width = newRw + 'px';
    }

    function onUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

// ── Drag-to-reorder ───────────────────────────────────────────
var dragSrc = null;

document.querySelectorAll('.col-header[draggable]').forEach(function(header) {
  header.addEventListener('dragstart', function(e) {
    dragSrc = header.dataset.col;
    header.classList.add('drag-src');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrc);
  });
  header.addEventListener('dragend', function() {
    header.classList.remove('drag-src');
    dragSrc = null;
  });
  header.addEventListener('dragover', function(e) {
    e.preventDefault();
    if (dragSrc && dragSrc !== header.dataset.col) {
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drag-over');
    }
  });
  header.addEventListener('dragleave', function() {
    header.classList.remove('drag-over');
  });
  header.addEventListener('drop', function(e) {
    e.preventDefault();
    header.classList.remove('drag-over');
    if (!dragSrc || dragSrc === header.dataset.col) return;
    const srcIdx = colOrder.indexOf(dragSrc);
    const dstIdx = colOrder.indexOf(header.dataset.col);
    if (srcIdx < 0 || dstIdx < 0) return;
    colOrder.splice(srcIdx, 1);
    colOrder.splice(dstIdx, 0, dragSrc);
    applyOrder();
    saveLayout();
  });
});

loadLayout();

// ── Messaging ─────────────────────────────────────────────────
function send(type, extra) { vscode.postMessage(Object.assign({type}, extra||{})); }

window.addEventListener('message', ({data:m}) => {
  if (m.type === 'initialState') {
    m.evidence.forEach(addEvidence);
    renderFindings(m.findings);
    const ta = document.getElementById('notes-area');
    if (ta && m.notes) ta.value = m.notes;
  }
  else if (m.type === 'evidenceAdded') addEvidence(m.item);
  else if (m.type === 'evidenceRemoved') removeEvidence(m.id);
  else if (m.type === 'findings') renderFindings(m.findings);
  else if (m.type === 'bridgeStatus') setBridge(m.connected);
  else if (m.type === 'evidenceView') renderViewerContent(m.pane, m.id, m.name, m.content, m.contentType);
});

document.getElementById('notes-area').addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    send('saveNotes', { notes: document.getElementById('notes-area').value });
    const ind = document.getElementById('save-indicator');
    ind.classList.add('show');
    setTimeout(() => ind.classList.remove('show'), 1200);
  }, 500);
});

function setBridge(on) {
  document.getElementById('dot').className = 'dot'+(on?' on':'');
  document.getElementById('bridge-lbl').textContent = on ? 'Bridge connected' : 'Disconnected';
}

const TYPE_SHORT = {'thread-dump':'TD','log-export':'LOG','top-output':'TOP','screenshot':'IMG','generic':'FILE'};

function addEvidence(item) {
  items.push(item);
  const t = new Date(item.timestamp);
  const row = document.createElement('div');
  row.className = 'ev-item';
  row.title = item.name;
  row.dataset.evId = item.id;
  row.innerHTML =
    '<span class="ev-type">'+(TYPE_SHORT[item.type]||'FILE')+'</span>'+
    '<span class="ev-name">'+esc(item.name)+'</span>'+
    '<span class="ev-time">'+fmt(t)+'</span>'+
    '<button class="ev-ext" title="Open in editor" onclick="openInEditor(event,\''+esc(item.id)+'\')">&#x2197;</button>'+
    '<button class="ev-del" title="Remove" onclick="delEvidence(event,\''+esc(item.id)+'\')">&#x2715;</button>';

  row.onclick = function(e) {
    if (e.target.classList.contains('ev-del') || e.target.classList.contains('ev-ext')) return;
    loadInViewer(item.id, item.name, item.type);
  };

  const wrapper = document.createElement('div');
  wrapper.dataset.evId = item.id;
  wrapper.appendChild(row);
  document.getElementById('ev-list').appendChild(wrapper);
  updateTimeline();
}

// ── Viewer ────────────────────────────────────────────────────
let viewerIds = [null, null];
let activePane = 0;
let splitOpen = false;

function focusPane(idx) {
  activePane = idx;
  for (let i = 0; i < 2; i++) {
    document.getElementById('viewer-pane-'+i).classList.toggle('focused', i === idx);
  }
}

function toggleSplit() {
  if (splitOpen) { closeSplit(); return; }
  splitOpen = true;
  document.getElementById('viewer-pane-1').style.display = 'flex';
  document.getElementById('viewer-split-hnd').style.display = 'block';
  document.getElementById('split-btn').textContent = 'Unsplit';
  focusPane(1);
}

function closeSplit(e) {
  if (e) e.stopPropagation();
  splitOpen = false;
  document.getElementById('viewer-pane-1').style.display = 'none';
  document.getElementById('viewer-split-hnd').style.display = 'none';
  document.getElementById('split-btn').textContent = 'Split';
  viewerIds[1] = null;
  focusPane(0);
}

function loadInViewer(id, name, type) {
  const pane = splitOpen ? activePane : 0;
  send('viewEvidence', { id: id, pane: pane });
  const lbl = document.getElementById('viewer-lbl-'+pane);
  lbl.textContent = 'Loading…';
  lbl.className = 'viewer-lbl';
  document.getElementById('viewer-content-'+pane).innerHTML = '<div class="viewer-empty">Loading…</div>';
  document.querySelectorAll('.ev-item.active').forEach(function(el) { el.classList.remove('active'); });
  const row = document.querySelector('[data-ev-id="'+id+'"] .ev-item');
  if (row) row.classList.add('active');
}

function renderViewerContent(pane, id, name, content, contentType) {
  viewerIds[pane] = id;
  const lbl = document.getElementById('viewer-lbl-'+pane);
  lbl.textContent = name;
  lbl.className = 'viewer-lbl loaded';
  const extBtn = document.getElementById('viewer-ext-'+pane);
  if (extBtn) extBtn.style.display = '';
  const contentEl = document.getElementById('viewer-content-'+pane);
  if (!content) {
    contentEl.innerHTML = '<div class="viewer-empty">No content available for this file.</div>';
    return;
  }
  if (contentType === 'image') {
    contentEl.innerHTML = '<img src="'+content+'" alt="'+esc(name)+'">';
  } else {
    contentEl.innerHTML = '<pre>'+esc(content)+'</pre>';
  }
  if (pane === 0 && splitOpen) focusPane(1);
}

function extOpen(e, pane) {
  e.stopPropagation();
  if (viewerIds[pane]) send('openEvidence', { id: viewerIds[pane] });
}

// ── Viewer split handle drag ──────────────────────────────────
(function() {
  const hnd = document.getElementById('viewer-split-hnd');
  hnd.addEventListener('mousedown', function(e) {
    e.preventDefault();
    hnd.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const p0 = document.getElementById('viewer-pane-0');
    const p1 = document.getElementById('viewer-pane-1');
    let h0 = p0.getBoundingClientRect().height;
    let h1 = p1.getBoundingClientRect().height;
    p0.style.flex = 'none'; p0.style.height = h0 + 'px';
    p1.style.flex = 'none'; p1.style.height = h1 + 'px';
    const startY = e.clientY;
    function onMove(ev) {
      const dy = ev.clientY - startY;
      p0.style.height = Math.max(60, h0 + dy) + 'px';
      p1.style.height = Math.max(60, h1 - dy) + 'px';
    }
    function onUp() {
      hnd.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

function removeEvidence(id) {
  items = items.filter(function(i) { return i.id !== id; });
  const wrapper = document.querySelector('[data-ev-id="'+id+'"]');
  if (wrapper) wrapper.remove();
  for (let i = 0; i < 2; i++) {
    if (viewerIds[i] === id) {
      viewerIds[i] = null;
      const lbl = document.getElementById('viewer-lbl-'+i);
      lbl.textContent = 'Click evidence to view';
      lbl.className = 'viewer-lbl';
      const extBtn = document.getElementById('viewer-ext-'+i);
      if (extBtn) extBtn.style.display = 'none';
      document.getElementById('viewer-content-'+i).innerHTML = '<div class="viewer-empty">Click an evidence item to view its content here</div>';
    }
  }
  updateTimeline();
}

function delEvidence(e, id) {
  e.stopPropagation();
  send('deleteEvidence', { id: id });
}

function openInEditor(e, id) {
  e.stopPropagation();
  send('openEvidence', { id: id });
}

// ── Analysis section ──────────────────────────────────────────
let analysisOpen = false;

function toggleAnalysis() {
  analysisOpen = !analysisOpen;
  document.getElementById('analysis-body').style.display = analysisOpen ? 'block' : 'none';
  document.getElementById('analysis-chevron').style.transform = analysisOpen ? 'rotate(90deg)' : '';
}

function renderFindings(findings) {
  const section = document.getElementById('analysis-section');
  const body = document.getElementById('analysis-body');
  if (!findings || !findings.length) {
    section.style.display = 'none';
    body.innerHTML = '';
    document.getElementById('analysis-cnt').textContent = '0';
    return;
  }
  section.style.display = 'block';
  document.getElementById('analysis-cnt').textContent = String(findings.length);
  body.innerHTML = findings.map(cardHtml).join('');
}

function cardHtml(f) {
  const evHtml = f.evidence.map(e=>'<div>'+esc(e)+'</div>').join('');
  const stepsHtml = f.nextSteps.map(s=>'<button class="btn" onclick="noop()">'+esc(s)+'</button>').join('');
  const relHtml = f.relatedSignatures&&f.relatedSignatures.length
    ? '<div class="related">Related: '+f.relatedSignatures.map(esc).join(', ')+'</div>' : '';
  const fj = esc(JSON.stringify(f));
  return '<div class="card">'+
    '<div class="card-header" onclick="toggle(this.parentElement)">'+
      '<span class="badge '+f.confidence+'">'+f.confidence.toUpperCase()+'</span>'+
      '<span class="card-name">'+esc(f.signatureName)+'</span>'+
      '<span class="chevron">&#x203A;</span>'+
    '</div>'+
    '<div class="card-body">'+
      '<div class="ev-lines">'+evHtml+'</div>'+
      '<div class="actions">'+stepsHtml+
        '<button class="btn accent" onclick="send(\\u0027openSignatureBuilder\\u0027,{finding:'+fj+'})">Save as Signature</button>'+
        '<button class="btn" onclick=\'send("askClaude",{signatureId:"'+esc(f.signatureId)+'"})\'> Ask Claude</button>'+
      '</div>'+relHtml+
    '</div>'+
  '</div>';
}

function toggle(card) { card.classList.toggle('open'); }

function updateTimeline() {
  if(!items.length) return;
  const ts = items.map(e=>new Date(e.timestamp).getTime());
  const lo=Math.min(...ts), hi=Math.max(...ts), span=hi-lo||1;
  document.getElementById('tl-bar').innerHTML = items.map(e=>{
    const pct = ((new Date(e.timestamp).getTime()-lo)/span*92+4).toFixed(1);
    return '<div class="tl-mark" style="left:'+pct+'%" title="'+esc(e.name)+' '+fmt(new Date(e.timestamp))+'"></div>';
  }).join('');
}

function fmt(d){return String(d.getHours()).padStart(2,'0')+'h'+String(d.getMinutes()).padStart(2,'0');}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function noop(){}

send('ready');
</script>
</body>
</html>`;
  }
}
