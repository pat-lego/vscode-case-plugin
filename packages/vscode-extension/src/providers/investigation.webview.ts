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
          findings: session.findings
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
.col.evidence{width:260px;min-width:180px;border-right:1px solid var(--vscode-panel-border)}
.col.findings{flex:1}
.col-header{padding:5px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.col-body{flex:1;overflow-y:auto;padding:8px}
.add-btn{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;border:1px dashed var(--vscode-panel-border);border-radius:3px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;background:none;width:100%;margin-bottom:6px}
.add-btn:hover{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
.ev-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;font-size:11px}
.ev-item:hover{background:var(--vscode-list-hoverBackground)}
.ev-type{font-size:9px;font-weight:700;padding:1px 4px;border-radius:2px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);flex-shrink:0}
.ev-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ev-time{font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0}
.empty{text-align:center;padding:24px 12px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6}
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
.full-review{width:100%;margin-top:8px;padding:5px}
.related{margin-top:6px;font-size:10px;color:var(--vscode-descriptionForeground)}
.timeline{height:50px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:5px 12px;flex-shrink:0}
.tl-label{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
.tl-bar{height:16px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:2px;position:relative;overflow:hidden}
.tl-mark{position:absolute;width:2px;height:100%;background:var(--vscode-focusBorder);opacity:.7;cursor:pointer}
.tl-mark:hover{opacity:1}
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

<div class="workspace">
  <div class="col evidence">
    <div class="col-header">Evidence</div>
    <div class="col-body">
      <button class="add-btn" onclick="send('addEvidence')">＋ Add evidence files</button>
      <div id="ev-list"></div>
    </div>
  </div>
  <div class="col findings">
    <div class="col-header">Findings</div>
    <div class="col-body">
      <div class="empty" id="empty-msg">Add thread dumps or log files to begin analysis</div>
      <div id="findings-list"></div>
      <button class="btn full-review" id="review-btn" style="display:none" onclick="send('fullReview')">Request Full Case Review (Claude)</button>
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

function send(type, extra) { vscode.postMessage(Object.assign({type}, extra||{})); }

window.addEventListener('message', ({data:m}) => {
  if (m.type === 'initialState') { m.evidence.forEach(addEvidence); renderFindings(m.findings); }
  else if (m.type === 'evidenceAdded') addEvidence(m.item);
  else if (m.type === 'findings') renderFindings(m.findings);
  else if (m.type === 'bridgeStatus') setBridge(m.connected);
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
  row.innerHTML =
    '<span class="ev-type">'+(TYPE_SHORT[item.type]||'FILE')+'</span>'+
    '<span class="ev-name">'+esc(item.name)+'</span>'+
    '<span class="ev-time">'+fmt(t)+'</span>';
  document.getElementById('ev-list').appendChild(row);
  updateTimeline();
}

function renderFindings(findings) {
  const list = document.getElementById('findings-list');
  const empty = document.getElementById('empty-msg');
  const btn = document.getElementById('review-btn');
  if (!findings||!findings.length) {
    list.innerHTML='';
    if(!items.length) empty.style.display='block';
    btn.style.display='none';
    return;
  }
  empty.style.display='none';
  btn.style.display='block';
  list.innerHTML = findings.map(cardHtml).join('');
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
        '<button class="btn accent" onclick=\'send("openSignatureBuilder",{finding:'+JSON.stringify(f)+'})\'>Save as Signature</button>'+
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
