import * as vscode from 'vscode';
import { Signature, SignatureCondition } from '@incident-investigator/core';

// ── Field metadata ────────────────────────────────────────────────────────────

const FIELD_META: Record<string, { label: string; type: 'NUMERIC' | 'STRING' | 'FLAG' }> = {
  totalThreadCount:            { label: 'Total Thread Count',           type: 'NUMERIC' },
  avgThreadCount:              { label: 'Average Thread Count',         type: 'NUMERIC' },
  blockedThreadCount:          { label: 'Blocked Thread Count',         type: 'NUMERIC' },
  waitingThreadCount:          { label: 'Waiting Thread Count',         type: 'NUMERIC' },
  ioThreadCount:               { label: 'IO Thread Count',              type: 'NUMERIC' },
  gcThreadCount:               { label: 'GC Thread Count',              type: 'NUMERIC' },
  dominantFingerprintCount:    { label: 'Dominant Fingerprint Count',   type: 'NUMERIC' },
  dominantFingerprintRatio:    { label: 'Dominant Fingerprint Ratio',   type: 'NUMERIC' },
  persistentBlockedMonitors:   { label: 'Persistent Blocked Monitors',  type: 'NUMERIC' },
  maxBlockedOnSingleMonitor:   { label: 'Max Blocked on Single Monitor',type: 'NUMERIC' },
  topBlockedMonitorClass:      { label: 'Top Blocked Monitor Class',    type: 'STRING'  },
  blockedMonitorCount:         { label: 'Blocked Monitor Count',        type: 'NUMERIC' },
  threadCountAnomaly:          { label: 'Thread Count Anomaly',         type: 'FLAG'    },
  ioSaturationDetected:        { label: 'IO Saturation Detected',       type: 'FLAG'    },
};

const OPERATOR_LABELS: Record<string, string> = {
  gt:       'is greater than',
  gte:      'is at least',
  lt:       'is less than',
  lte:      'is at most',
  eq:       'equals',
  contains: 'contains',
  matches:  'matches regex',
};

function fieldLabel(field: string): string {
  return FIELD_META[field]?.label ?? field;
}

function fieldType(field: string): string {
  return FIELD_META[field]?.type ?? 'NUMERIC';
}

function operatorLabel(op: string): string {
  return OPERATOR_LABELS[op] ?? op;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Confidence helpers ────────────────────────────────────────────────────────

function confidencePercent(matched: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((matched / total) * 100);
}

function confidenceLabel(pct: number): { label: string; cls: string } {
  if (pct >= 80) return { label: 'HIGH', cls: 'conf-high' };
  if (pct >= 50) return { label: 'MEDIUM', cls: 'conf-medium' };
  return { label: 'LOW', cls: 'conf-low' };
}

// ── YAML serialiser (no external deps) ───────────────────────────────────────

function toYaml(sig: Signature): string {
  const lines: string[] = [];
  lines.push(`id: ${sig.id}`);
  lines.push(`name: ${JSON.stringify(sig.name)}`);
  lines.push(`description: ${JSON.stringify(sig.description)}`);
  lines.push(`version: ${JSON.stringify(sig.version)}`);
  lines.push('conditions:');
  for (const c of sig.conditions) {
    lines.push(`  - field: ${c.field}`);
    lines.push(`    operator: ${c.operator}`);
    lines.push(`    value: ${JSON.stringify(c.value)}`);
    lines.push(`    description: ${JSON.stringify(c.description)}`);
  }
  const arr = (label: string, items: string[]) => {
    if (!items || items.length === 0) { lines.push(`${label}: []`); return; }
    lines.push(`${label}:`);
    for (const it of items) lines.push(`  - ${JSON.stringify(it)}`);
  };
  arr('indicators', sig.indicators);
  arr('nextSteps', sig.nextSteps);
  arr('relatedSignatures', sig.relatedSignatures);
  return lines.join('\n');
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(sig: Signature): string {
  const n = sig.conditions.length;
  const allPct = confidencePercent(n, n);
  const allConf = confidenceLabel(allPct);

  const conditionCards = sig.conditions.map(c => {
    const meta = FIELD_META[c.field];
    const typeTag = meta?.type ?? 'NUMERIC';
    return `
<div class="card cond-card">
  <div class="cond-header">
    <span class="check-icon">&#10003;</span>
    <span class="field-label">${esc(fieldLabel(c.field))}</span>
    <span class="type-tag type-${typeTag.toLowerCase()}">${typeTag}</span>
  </div>
  <div class="cond-body">
    <span class="op-label">${esc(operatorLabel(c.operator))}</span>
    <span class="value-badge">${esc(String(c.value))}</span>
  </div>
  <div class="cond-desc">${esc(c.description)}</div>
</div>`;
  }).join('\n');

  const indicatorsList = sig.indicators && sig.indicators.length > 0
    ? `<ul class="plain-list">${sig.indicators.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '<p class="muted">None</p>';

  const nextStepsList = sig.nextSteps && sig.nextSteps.length > 0
    ? `<ol class="plain-list">${sig.nextSteps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>`
    : '<p class="muted">None</p>';

  const relatedList = sig.relatedSignatures && sig.relatedSignatures.length > 0
    ? `<ul class="plain-list">${sig.relatedSignatures.map(r => `<li><code>${esc(r)}</code></li>`).join('')}</ul>`
    : '<p class="muted">None</p>';

  const yamlStr = esc(toYaml(sig));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(sig.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);
  background:var(--vscode-editor-background);
  padding:20px;
  max-width:780px;
}
h1{font-size:15px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
h2{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:10px;margin-top:18px}
.badge{
  display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
}
.badge-version{
  background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);
}
.description{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:6px;line-height:1.5}
.conf-legend{
  display:flex;gap:10px;font-size:10px;margin-bottom:16px;flex-wrap:wrap;
  padding:6px 10px;border:1px solid var(--vscode-panel-border);border-radius:4px;
  background:var(--vscode-sideBar-background);
}
.conf-item{display:flex;align-items:center;gap:4px}
.conf-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.conf-high{background:#4caf50}
.conf-medium{background:#ff9800}
.conf-low{background:#f44336}
.card{
  padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px;
  background:var(--vscode-sideBar-background);margin-bottom:8px;
}
.cond-card{}
.cond-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.check-icon{
  width:16px;height:16px;border-radius:50%;
  background:var(--vscode-button-background);color:var(--vscode-button-foreground);
  display:flex;align-items:center;justify-content:center;font-size:10px;flex-shrink:0;
}
.field-label{font-weight:600;font-size:12px;flex:1}
.type-tag{
  font-size:9px;font-weight:700;letter-spacing:.05em;
  padding:1px 5px;border-radius:3px;
}
.type-numeric{background:rgba(79,159,255,.15);color:#4f9fff}
.type-string{background:rgba(255,168,79,.15);color:#ffa84f}
.type-flag{background:rgba(168,79,255,.15);color:#a84fff}
.cond-body{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.op-label{font-size:11px;color:var(--vscode-descriptionForeground)}
.value-badge{
  font-size:11px;font-weight:600;font-family:var(--vscode-editor-font-family,monospace);
  background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
  padding:0 6px;border-radius:3px;
}
.cond-desc{font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.4}
.and-note{
  font-size:10px;color:var(--vscode-descriptionForeground);
  margin-bottom:10px;padding:4px 8px;
  border-left:2px solid var(--vscode-button-background);
  background:var(--vscode-sideBar-background);
}
.conf-bar{
  display:flex;align-items:center;gap:10px;margin-bottom:8px;
  padding:8px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px;
  background:var(--vscode-sideBar-background);
}
.conf-fraction{font-size:12px;font-weight:600}
.conf-label{
  font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;
}
.conf-label-high{background:rgba(76,175,80,.2);color:#4caf50}
.conf-label-medium{background:rgba(255,152,0,.2);color:#ff9800}
.conf-label-low{background:rgba(244,67,54,.2);color:#f44336}
.plain-list{padding-left:18px;font-size:12px;line-height:1.6;color:var(--vscode-foreground)}
.plain-list code{
  font-family:var(--vscode-editor-font-family,monospace);font-size:11px;
  background:var(--vscode-badge-background);padding:0 4px;border-radius:2px;
}
.muted{font-size:12px;color:var(--vscode-descriptionForeground)}
details{margin-top:14px;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden}
summary{
  cursor:pointer;padding:7px 12px;font-size:11px;font-weight:600;
  background:var(--vscode-sideBar-background);
  color:var(--vscode-descriptionForeground);
  user-select:none;
  list-style:none;
}
summary::before{content:"&#x25B6; "}
details[open] summary::before{content:"&#x25BC; "}
pre{
  padding:12px;font-family:var(--vscode-editor-font-family,monospace);
  font-size:12px;line-height:1.5;overflow-x:auto;
  background:var(--vscode-editor-background);color:var(--vscode-foreground);
  border-top:1px solid var(--vscode-panel-border);
}
</style>
</head>
<body>

<h1>
  ${esc(sig.name)}
  <span class="badge">${esc(sig.id)}</span>
  <span class="badge badge-version">v${esc(sig.version)}</span>
</h1>

<div class="conf-legend">
  <span style="font-size:10px;font-weight:600;margin-right:4px">Confidence:</span>
  <span class="conf-item"><span class="conf-dot conf-high"></span>&ge;80% &mdash; High</span>
  <span class="conf-item"><span class="conf-dot conf-medium"></span>&ge;50% &mdash; Medium</span>
  <span class="conf-item"><span class="conf-dot conf-low"></span>&lt;50% &mdash; Low</span>
</div>

<p class="description">${esc(sig.description)}</p>

<h2>Conditions</h2>
<p class="and-note">ALL conditions must match (AND logic)</p>
${conditionCards}

<div class="conf-bar">
  <span class="conf-fraction">${n} of ${n} conditions = ${allPct}%</span>
  <span class="conf-label conf-label-${allConf.cls.replace('conf-', '')}">${allConf.label}</span>
</div>

<h2>Indicators</h2>
${indicatorsList}

<h2>Next Steps</h2>
${nextStepsList}

<h2>Related Signatures</h2>
${relatedList}

<details>
<summary>YAML Preview</summary>
<pre>${yamlStr}</pre>
</details>

</body>
</html>`;
}

// ── Panel class ───────────────────────────────────────────────────────────────

export class SignatureViewerPanel {
  static show(context: vscode.ExtensionContext, signature: Signature) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.signatureViewer',
      `Signature: ${signature.name}`,
      vscode.ViewColumn.Beside,
      { enableScripts: false }
    );
    panel.webview.html = buildHtml(signature);
  }
}
