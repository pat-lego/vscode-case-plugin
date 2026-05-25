import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';
import { SignatureService } from '../services/signature-service';

export class CaseResolutionPanel {
  static show(
    context: vscode.ExtensionContext,
    caseId: string,
    caseManager: CaseManager,
    sigService: SignatureService
  ) {
    const session = caseManager.getSession(caseId);
    if (!session) return;

    const panel = vscode.window.createWebviewPanel(
      'investigator.resolve',
      `Resolve ${caseId}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const topFindings = session.findings.slice(0, 3);
    panel.webview.html = buildHtml(caseId, topFindings);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'resolve') {
        const config = vscode.workspace.getConfiguration('investigator');
        const initials = config.get<string>('engineerInitials') ?? 'unknown';
        caseManager.resolveCase(caseId, msg.resolution, initials);
        vscode.window.showInformationMessage(`Case ${caseId} resolved.`);

        if (msg.createSignature && msg.finding) {
          vscode.commands.executeCommand('investigator.buildSignature', caseId, msg.finding);
        }

        panel.dispose();
      }
      if (msg.type === 'cancel') panel.dispose();
    });
  }
}

function buildHtml(caseId: string, findings: { signatureName: string; confidence: string; signatureId: string }[]): string {
  const findingOptions = findings.map((f, i) =>
    `<option value="${i}">${f.signatureName} (${f.confidence})</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Resolve Case</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}
h2{font-size:13px;font-weight:600;margin-bottom:14px}
.section{margin-bottom:14px}
label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
input,textarea,select{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:inherit;font-size:12px}
textarea{resize:vertical;min-height:80px}
input:focus,textarea:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}
.sig-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.sig-row input[type=checkbox]{width:auto}
.actions{display:flex;gap:8px;margin-top:16px}
.btn{padding:4px 12px;font-size:12px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
</style>
</head>
<body>
<h2>Resolve ${caseId}</h2>

<div class="section">
  <label>Root cause / resolution summary</label>
  <textarea id="resolution" rows="4" placeholder="Describe what caused the incident and how it was resolved..."></textarea>
</div>

${findings.length > 0 ? `
<div class="section">
  <label>Create signature from this resolution?</label>
  <div class="sig-row">
    <input type="checkbox" id="create-sig">
    <label for="create-sig" style="color:var(--vscode-foreground)">Open Signature Builder after resolving</label>
  </div>
  ${findings.length > 1 ? `
  <div style="margin-top:8px">
    <label>Based on finding</label>
    <select id="finding-select">${findingOptions}</select>
  </div>` : ''}
</div>` : ''}

<div class="actions">
  <button class="btn primary" onclick="resolve()">Mark as Resolved</button>
  <button class="btn" onclick="cancel()">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const findings = ${JSON.stringify(findings)};

function resolve() {
  const resolution = document.getElementById('resolution').value.trim();
  if (!resolution) { alert('Please describe the resolution.'); return; }
  const createSig = document.getElementById('create-sig')?.checked ?? false;
  const idx = parseInt(document.getElementById('finding-select')?.value ?? '0');
  vscode.postMessage({
    type: 'resolve',
    resolution,
    createSignature: createSig,
    finding: findings[idx] ?? null
  });
}
function cancel() { vscode.postMessage({type:'cancel'}); }
</script>
</body>
</html>`;
}
