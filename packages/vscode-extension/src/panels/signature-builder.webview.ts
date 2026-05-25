import * as vscode from 'vscode';
import { Finding, Signature } from '@incident-investigator/core';
import { CaseManager } from '../services/case-manager';
import { SignatureService } from '../services/signature-service';

export class SignatureBuilderPanel {
  static show(
    context: vscode.ExtensionContext,
    caseId: string,
    finding: unknown,
    caseManager: CaseManager,
    sigService: SignatureService
  ) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.signatureBuilder',
      'New Signature',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const f = finding as Finding | undefined;
    const session = caseManager.getSession(caseId);
    const suggestedId = f
      ? f.signatureId + '-variant-' + Date.now().toString().slice(-4)
      : 'new-signature';

    panel.webview.html = buildHtml(f, suggestedId);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'save') {
        const sig: Signature = {
          id: msg.id,
          name: msg.name,
          description: msg.description,
          version: '1.0',
          conditions: msg.conditions,
          indicators: msg.indicators,
          nextSteps: msg.nextSteps,
          relatedSignatures: msg.relatedSignatures
        };
        const saved = sigService.saveSignature(sig);
        if (saved) {
          vscode.window.showInformationMessage(`Signature "${sig.name}" saved.`);
          panel.dispose();
        }
      }
      if (msg.type === 'cancel') panel.dispose();
    });
  }
}

function buildHtml(finding: Finding | undefined, suggestedId: string): string {
  const conditions = finding?.matchedConditions.map(c => ({
    field: c.field,
    operator: 'gte',
    value: c.observedValue,
    description: c.description,
    checked: true
  })) ?? [];

  const conditionsJson = JSON.stringify(conditions);
  const nextSteps = finding?.nextSteps ?? [];
  const related = finding?.relatedSignatures ?? [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Signature Builder</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}
h2{font-size:13px;font-weight:600;margin-bottom:14px}
.section{margin-bottom:14px}
label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
input,textarea{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:inherit;font-size:12px}
textarea{resize:vertical;min-height:52px}
input:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder);border-color:var(--vscode-focusBorder)}
.cond-list{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.cond-row{display:flex;align-items:center;gap:6px;padding:4px 7px;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);border-radius:2px;font-size:11px}
.cond-row input[type=checkbox]{width:auto;flex-shrink:0}
.cond-desc{flex:1;color:var(--vscode-descriptionForeground)}
.cond-val{color:var(--vscode-foreground);font-weight:500}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px}
.actions{display:flex;gap:8px;margin-top:16px}
.btn{padding:4px 12px;font-size:12px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
</style>
</head>
<body>
<h2>Signature Builder</h2>

<div class="section">
  <label>ID (kebab-case, unique)</label>
  <input id="sig-id" value="${suggestedId}">
</div>
<div class="section">
  <label>Name</label>
  <input id="sig-name" value="${finding?.signatureName ?? ''}">
</div>
<div class="section">
  <label>Description</label>
  <textarea id="sig-desc" rows="2"></textarea>
</div>

<div class="section">
  <label>Conditions from evidence — uncheck any that are coincidental</label>
  <div class="cond-list" id="cond-list"></div>
  <div class="hint">Only checked conditions will be saved to the signature.</div>
</div>

<div class="section">
  <label>Next Steps (one per line)</label>
  <textarea id="next-steps" rows="4">${nextSteps.join('\n')}</textarea>
</div>

<div class="section">
  <label>Related Signatures (comma-separated IDs)</label>
  <input id="related" value="${related.join(', ')}">
</div>

<div class="actions">
  <button class="btn primary" onclick="save()">Save to Signature Library</button>
  <button class="btn" onclick="cancel()">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();
const conditions = ${conditionsJson};

const list = document.getElementById('cond-list');
conditions.forEach((c, i) => {
  const row = document.createElement('div');
  row.className = 'cond-row';
  row.innerHTML =
    '<input type="checkbox" id="c'+i+'" '+(c.checked?'checked':'')+'>'+
    '<span class="cond-desc"><label for="c'+i+'">'+esc(c.description)+'</label></span>'+
    '<span class="cond-val">'+esc(String(c.value))+'</span>';
  list.appendChild(row);
});

function save() {
  const checked = conditions.filter((_, i) =>
    document.getElementById('c'+i).checked
  );
  vscode.postMessage({
    type: 'save',
    id: document.getElementById('sig-id').value.trim(),
    name: document.getElementById('sig-name').value.trim(),
    description: document.getElementById('sig-desc').value.trim(),
    conditions: checked,
    indicators: [],
    nextSteps: document.getElementById('next-steps').value.split('\\n').map(s=>s.trim()).filter(Boolean),
    relatedSignatures: document.getElementById('related').value.split(',').map(s=>s.trim()).filter(Boolean)
  });
}

function cancel() { vscode.postMessage({type:'cancel'}); }
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
</script>
</body>
</html>`;
}
