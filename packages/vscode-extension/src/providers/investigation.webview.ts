import * as vscode from 'vscode';
import * as path from 'path';

export class InvestigationWebview {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  openCase(caseId: string) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.panel.title = caseId;
      this.panel.webview.postMessage({ type: 'loadCase', caseId });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'investigator.case',
      caseId,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel.webview.html = this.getHtml(caseId);

    this.panel.onDidDispose(() => { this.panel = undefined; });

    this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
  }

  postMessage(msg: unknown) {
    this.panel?.webview.postMessage(msg);
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case 'ready':
        break;
    }
  }

  private getHtml(caseId: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${caseId}</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; }
    .header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
    .header h2 { margin: 0; font-size: 13px; font-weight: 600; }
    .bridge-status { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
    .dot.connected { background: #4ec9b0; }
    .workspace { display: flex; flex: 1; overflow: hidden; }
    .panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--vscode-panel-border); }
    .panel:last-child { border-right: none; }
    .panel-header { padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
    .panel-body { flex: 1; overflow-y: auto; padding: 8px; }
    .drop-zone { border: 1px dashed var(--vscode-panel-border); border-radius: 4px; padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 8px; cursor: pointer; }
    .drop-zone:hover { border-color: var(--vscode-focusBorder); }
    .evidence-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 3px; font-size: 12px; margin-bottom: 2px; }
    .evidence-item:hover { background: var(--vscode-list-hoverBackground); }
    .evidence-icon { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .finding { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; overflow: hidden; }
    .finding-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
    .finding-header:hover { background: var(--vscode-list-hoverBackground); }
    .badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 2px; }
    .badge.high { background: #f14c4c22; color: #f14c4c; }
    .badge.medium { background: #cca70022; color: #cca700; }
    .badge.low { background: #75beff22; color: #75beff; }
    .finding-body { padding: 8px 12px; font-size: 12px; border-top: 1px solid var(--vscode-panel-border); display: none; }
    .finding-body.open { display: block; }
    .finding-evidence { color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
    .finding-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .btn { padding: 3px 8px; font-size: 11px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 3px; cursor: pointer; }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .timeline { padding: 8px 16px; border-top: 1px solid var(--vscode-panel-border); height: 60px; background: var(--vscode-sideBar-background); display: flex; flex-direction: column; justify-content: center; }
    .timeline-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .timeline-bar { height: 20px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 2px; position: relative; }
    .empty-findings { text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; padding: 24px; }
    .full-review-btn { width: 100%; margin-top: 8px; padding: 6px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h2 id="case-title">${caseId}</h2>
    <div style="display:flex;gap:8px;align-items:center">
      <div class="bridge-status">
        <div class="dot" id="bridge-dot"></div>
        <span id="bridge-label">Bridge disconnected</span>
      </div>
      <button class="btn primary" onclick="exportCase()">Export to Obsidian</button>
    </div>
  </div>

  <div class="workspace">
    <div class="panel" style="max-width:300px">
      <div class="panel-header">Evidence</div>
      <div class="panel-body">
        <div class="drop-zone" id="drop-zone" ondragover="event.preventDefault()" ondrop="handleDrop(event)">
          Drop thread dumps, logs, or top output here
        </div>
        <div id="evidence-list"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">Findings</div>
      <div class="panel-body" id="findings-panel">
        <div class="empty-findings" id="empty-findings">
          Add evidence to begin analysis
        </div>
        <div id="findings-list"></div>
        <button class="btn full-review-btn" id="full-review-btn" style="display:none" onclick="requestFullReview()">
          Request Full Case Review (Claude)
        </button>
      </div>
    </div>
  </div>

  <div class="timeline">
    <div class="timeline-label">Timeline</div>
    <div class="timeline-bar" id="timeline-bar"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = { evidence: [], findings: [] };

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'findings') renderFindings(msg.findings);
      if (msg.type === 'evidence') addEvidence(msg.item);
      if (msg.type === 'bridgeStatus') updateBridgeStatus(msg.connected);
    });

    function handleDrop(e) {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      files.forEach(f => vscode.postMessage({ type: 'addEvidence', path: f.path, name: f.name }));
    }

    function addEvidence(item) {
      state.evidence.push(item);
      const list = document.getElementById('evidence-list');
      const el = document.createElement('div');
      el.className = 'evidence-item';
      el.innerHTML = '<span class="evidence-icon">◆</span><span>' + item.name + '</span>';
      list.appendChild(el);
    }

    function renderFindings(findings) {
      const list = document.getElementById('findings-list');
      const empty = document.getElementById('empty-findings');
      const reviewBtn = document.getElementById('full-review-btn');

      if (!findings || findings.length === 0) {
        empty.style.display = 'block';
        list.innerHTML = '';
        reviewBtn.style.display = 'none';
        return;
      }

      empty.style.display = 'none';
      reviewBtn.style.display = 'block';
      list.innerHTML = findings.map(f => renderFinding(f)).join('');
    }

    function renderFinding(f) {
      return '<div class="finding">' +
        '<div class="finding-header" onclick="toggleFinding(this)">' +
          '<span class="badge ' + f.confidence + '">' + f.confidence.toUpperCase() + '</span>' +
          '<span>' + f.signatureName + '</span>' +
        '</div>' +
        '<div class="finding-body">' +
          '<div class="finding-evidence">' + f.evidence.join('<br>') + '</div>' +
          '<div class="finding-actions">' +
            f.nextSteps.map(s => '<button class="btn">' + s + '</button>').join('') +
            '<button class="btn" onclick="askClaude(\'' + f.signatureId + '\')">Ask Claude</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function toggleFinding(header) {
      const body = header.nextElementSibling;
      body.classList.toggle('open');
    }

    function updateBridgeStatus(connected) {
      document.getElementById('bridge-dot').className = 'dot' + (connected ? ' connected' : '');
      document.getElementById('bridge-label').textContent = connected ? 'Bridge connected' : 'Bridge disconnected';
    }

    function requestFullReview() {
      vscode.postMessage({ type: 'fullReview' });
    }

    function exportCase() {
      vscode.postMessage({ type: 'exportCase' });
    }

    function askClaude(signatureId) {
      vscode.postMessage({ type: 'askClaude', signatureId });
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
