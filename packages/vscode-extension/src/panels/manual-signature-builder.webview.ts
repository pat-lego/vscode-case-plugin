import * as vscode from 'vscode';
import { Signature } from '@incident-investigator/core';
import { SignatureService } from '../services/signature-service';

export class ManualSignatureBuilderPanel {
  static show(context: vscode.ExtensionContext, sigService: SignatureService) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.manualSignatureBuilder',
      'New Signature',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = buildHtml();

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'save') {
        const sig: Signature = {
          id: msg.id,
          name: msg.name,
          description: msg.description,
          version: msg.version || '1.0',
          conditions: msg.conditions,
          indicators: [],
          nextSteps: msg.nextSteps,
          relatedSignatures: msg.relatedSignatures,
        };
        const saved = sigService.saveSignature(sig);
        if (saved) {
          vscode.window.showInformationMessage(`Signature "${sig.name}" saved.`);
          panel.dispose();
        }
      }
      if (msg.type === 'cancel') {
        panel.dispose();
      }
    });
  }
}

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New Signature</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size);
  color:var(--vscode-foreground);
  background:var(--vscode-editor-background);
  padding:20px;
  max-width:760px;
}
h1{font-size:14px;font-weight:700;margin-bottom:18px}
h2{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:10px;margin-top:20px}
.section{margin-bottom:0}
.field-row{margin-bottom:10px}
label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
input,textarea,select{
  width:100%;padding:4px 8px;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border));
  border-radius:2px;font-family:inherit;font-size:12px;
}
textarea{resize:vertical;min-height:60px}
input:focus,textarea:focus,select:focus{
  outline:1px solid var(--vscode-focusBorder);
  border-color:var(--vscode-focusBorder);
}
select option{background:var(--vscode-dropdown-background,var(--vscode-editor-background))}
.cond-block{
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;
  padding:10px 12px;
  margin-bottom:8px;
  background:var(--vscode-sideBar-background);
  position:relative;
}
.cond-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.cond-desc-row{margin-bottom:4px}
.remove-btn{
  position:absolute;top:8px;right:8px;
  background:transparent;border:none;color:var(--vscode-descriptionForeground);
  cursor:pointer;font-size:14px;line-height:1;padding:2px 6px;border-radius:2px;
}
.remove-btn:hover{color:var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground)}
.add-btn{
  padding:4px 10px;font-size:11px;
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
  border:1px solid var(--vscode-panel-border);
  border-radius:2px;cursor:pointer;margin-top:4px;
}
.add-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
.actions{display:flex;gap:8px;margin-top:20px}
.btn{
  padding:5px 14px;font-size:12px;
  border:1px solid var(--vscode-button-border,var(--vscode-panel-border));
  background:var(--vscode-button-secondaryBackground);
  color:var(--vscode-button-secondaryForeground);
  border-radius:2px;cursor:pointer;
}
.btn.primary{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border-color:transparent;
}
.btn.primary:hover{background:var(--vscode-button-hoverBackground)}
.error{color:var(--vscode-errorForeground);font-size:11px;margin-top:4px}
.yaml-section{margin-top:20px}
pre{
  padding:12px;font-family:var(--vscode-editor-font-family,monospace);
  font-size:11px;line-height:1.5;overflow-x:auto;
  background:var(--vscode-sideBar-background);
  color:var(--vscode-foreground);
  border:1px solid var(--vscode-panel-border);
  border-radius:4px;white-space:pre-wrap;word-break:break-all;
}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
</style>
</head>
<body>
<h1>New Signature</h1>

<h2>Identity</h2>
<div class="two-col">
  <div class="field-row">
    <label for="sig-id">ID (kebab-case)</label>
    <input id="sig-id" placeholder="e.g. high-blocked-thread-ratio" oninput="onInput()">
  </div>
  <div class="field-row">
    <label for="sig-version">Version</label>
    <input id="sig-version" value="1.0" oninput="onInput()">
  </div>
</div>
<div class="field-row">
  <label for="sig-name">Name</label>
  <input id="sig-name" placeholder="Human-readable name" oninput="onInput()">
</div>
<div class="field-row">
  <label for="sig-desc">Description</label>
  <textarea id="sig-desc" rows="2" placeholder="What does this signature detect?" oninput="onInput()"></textarea>
</div>

<h2>Conditions</h2>
<div id="cond-list"></div>
<button class="add-btn" onclick="addCondition()">+ Add Condition</button>

<h2>Next Steps</h2>
<div class="field-row">
  <label for="next-steps">One per line</label>
  <textarea id="next-steps" rows="3" oninput="onInput()"></textarea>
</div>

<h2>Related Signatures</h2>
<div class="field-row">
  <label for="related">Comma-separated IDs</label>
  <input id="related" placeholder="e.g. high-blocked-ratio, db-pool-exhaustion" oninput="onInput()">
</div>

<div class="yaml-section">
  <h2>Live YAML Preview</h2>
  <pre id="yaml-preview"></pre>
</div>

<div class="actions">
  <button class="btn primary" onclick="save()">Save to Signature Library</button>
  <button class="btn" onclick="cancel()">Cancel</button>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── Field definitions ─────────────────────────────────────────────────────────
const FIELDS = [
  { group: 'Thread Count', fields: [
    { value: 'totalThreadCount',   label: 'Total Thread Count',            type: 'numeric' },
    { value: 'avgThreadCount',     label: 'Average Thread Count',          type: 'numeric' },
    { value: 'blockedThreadCount', label: 'Blocked Thread Count',          type: 'numeric' },
    { value: 'waitingThreadCount', label: 'Waiting Thread Count',          type: 'numeric' },
    { value: 'ioThreadCount',      label: 'IO Thread Count',               type: 'numeric' },
    { value: 'gcThreadCount',      label: 'GC Thread Count',               type: 'numeric' },
  ]},
  { group: 'Stack Analysis', fields: [
    { value: 'dominantFingerprintCount', label: 'Dominant Fingerprint Count',  type: 'numeric' },
    { value: 'dominantFingerprintRatio', label: 'Dominant Fingerprint Ratio',  type: 'numeric' },
  ]},
  { group: 'Lock & Monitor', fields: [
    { value: 'persistentBlockedMonitors',  label: 'Persistent Blocked Monitors',   type: 'numeric' },
    { value: 'maxBlockedOnSingleMonitor',  label: 'Max Blocked on Single Monitor', type: 'numeric' },
    { value: 'topBlockedMonitorClass',     label: 'Top Blocked Monitor Class',     type: 'string'  },
    { value: 'blockedMonitorCount',        label: 'Blocked Monitor Count',         type: 'numeric' },
  ]},
  { group: 'Anomaly Flags', fields: [
    { value: 'threadCountAnomaly',   label: 'Thread Count Anomaly',  type: 'flag' },
    { value: 'ioSaturationDetected', label: 'IO Saturation Detected',type: 'flag' },
  ]},
];

const FIELD_MAP = {};
for (const g of FIELDS) for (const f of g.fields) FIELD_MAP[f.value] = f;

const OPERATORS_NUMERIC = [
  { value: 'gte', label: 'is at least (>=)' },
  { value: 'gt',  label: 'is greater than (>)' },
  { value: 'lte', label: 'is at most (<=)' },
  { value: 'lt',  label: 'is less than (<)' },
  { value: 'eq',  label: 'equals (=)' },
];
const OPERATORS_STRING = [
  { value: 'eq',       label: 'equals' },
  { value: 'contains', label: 'contains' },
  { value: 'matches',  label: 'matches regex' },
];
const OPERATORS_FLAG = [{ value: 'eq', label: 'equals' }];

// ── Condition state ────────────────────────────────────────────────────────────
let conditions = [];
let nextId = 0;

function addCondition() {
  const id = nextId++;
  conditions.push({ id, field: 'blockedThreadCount', operator: 'gte', value: '', description: '' });
  renderConditions();
  onInput();
}

function removeCondition(id) {
  conditions = conditions.filter(c => c.id !== id);
  renderConditions();
  onInput();
}

function getFieldType(fieldValue) {
  return FIELD_MAP[fieldValue]?.type ?? 'numeric';
}

function getOperatorsForType(type) {
  if (type === 'string') return OPERATORS_STRING;
  if (type === 'flag') return OPERATORS_FLAG;
  return OPERATORS_NUMERIC;
}

function renderConditions() {
  const list = document.getElementById('cond-list');
  list.innerHTML = '';
  for (const c of conditions) {
    const fieldType = getFieldType(c.field);
    const operators = getOperatorsForType(fieldType);

    // Build field select
    let fieldOpts = '';
    for (const g of FIELDS) {
      fieldOpts += '<optgroup label="' + esc(g.group) + '">';
      for (const f of g.fields) {
        const sel = f.value === c.field ? ' selected' : '';
        fieldOpts += '<option value="' + f.value + '"' + sel + '>' + esc(f.label) + ' (' + f.type.toUpperCase() + ')</option>';
      }
      fieldOpts += '</optgroup>';
    }

    // Build operator select
    let opOpts = '';
    for (const op of operators) {
      const sel = op.value === c.operator ? ' selected' : '';
      opOpts += '<option value="' + op.value + '"' + sel + '>' + esc(op.label) + '</option>';
    }

    // Build value input
    let valueInput;
    if (fieldType === 'flag') {
      const v0sel = String(c.value) === '0' ? ' selected' : '';
      const v1sel = String(c.value) === '1' ? ' selected' : '';
      valueInput = '<select onchange="setCondField(' + c.id + ', \'value\', this.value); onInput()"><option value="1"' + v1sel + '>1 (detected)</option><option value="0"' + v0sel + '>0 (not detected)</option></select>';
    } else if (fieldType === 'string') {
      valueInput = '<input type="text" placeholder="value" value="' + esc(String(c.value ?? '')) + '" oninput="setCondField(' + c.id + ', \'value\', this.value); onInput()">';
    } else {
      valueInput = '<input type="number" placeholder="0" value="' + esc(String(c.value ?? '')) + '" oninput="setCondField(' + c.id + ', \'value\', this.value); onInput()">';
    }

    const block = document.createElement('div');
    block.className = 'cond-block';
    block.innerHTML =
      '<button class="remove-btn" onclick="removeCondition(' + c.id + ')" title="Remove condition">&times;</button>' +
      '<div class="cond-grid">' +
        '<div><label>Field</label><select onchange="setCondField(' + c.id + ', \'field\', this.value); onInput()">' + fieldOpts + '</select></div>' +
        '<div><label>Operator</label><select onchange="setCondField(' + c.id + ', \'operator\', this.value); onInput()">' + opOpts + '</select></div>' +
        '<div><label>Value</label>' + valueInput + '</div>' +
      '</div>' +
      '<div class="cond-desc-row"><label>Description (plain English)</label>' +
        '<input type="text" placeholder="e.g. More than 50 threads are blocked on a lock" value="' + esc(c.description) + '" oninput="setCondField(' + c.id + ', \'description\', this.value); onInput()">' +
      '</div>';
    list.appendChild(block);
  }
}

function setCondField(id, field, value) {
  const c = conditions.find(c => c.id === id);
  if (!c) return;
  if (field === 'field') {
    // When the field changes, reset operator to first valid one and clear value
    const type = getFieldType(value);
    const ops = getOperatorsForType(type);
    c.operator = ops[0].value;
    c.value = type === 'flag' ? 1 : '';
    c[field] = value;
    renderConditions();
  } else {
    c[field] = value;
  }
}

// ── YAML generator (no external deps) ────────────────────────────────────────
function toYaml(sig) {
  const lines = [];
  lines.push('id: ' + sig.id);
  lines.push('name: ' + JSON.stringify(sig.name));
  lines.push('description: ' + JSON.stringify(sig.description));
  lines.push('version: ' + JSON.stringify(sig.version));
  lines.push('conditions:');
  for (const c of sig.conditions) {
    lines.push('  - field: ' + c.field);
    lines.push('    operator: ' + c.operator);
    const v = isNaN(Number(c.value)) ? JSON.stringify(c.value) : c.value;
    lines.push('    value: ' + v);
    lines.push('    description: ' + JSON.stringify(c.description));
  }
  const arr = (label, items) => {
    if (!items || items.length === 0) { lines.push(label + ': []'); return; }
    lines.push(label + ':');
    for (const it of items) lines.push('  - ' + JSON.stringify(it));
  };
  arr('indicators', []);
  arr('nextSteps', sig.nextSteps);
  arr('relatedSignatures', sig.relatedSignatures);
  return lines.join('\\n');
}

function getSig() {
  const id = document.getElementById('sig-id').value.trim();
  const name = document.getElementById('sig-name').value.trim();
  const description = document.getElementById('sig-desc').value.trim();
  const version = document.getElementById('sig-version').value.trim() || '1.0';
  const nextSteps = document.getElementById('next-steps').value.split('\\n').map(s => s.trim()).filter(Boolean);
  const relatedSignatures = document.getElementById('related').value.split(',').map(s => s.trim()).filter(Boolean);
  const condList = conditions.map(c => ({
    field: c.field,
    operator: c.operator,
    value: isNaN(Number(c.value)) || c.value === '' ? c.value : Number(c.value),
    description: c.description,
  }));
  return { id, name, description, version, conditions: condList, nextSteps, relatedSignatures };
}

function onInput() {
  const sig = getSig();
  document.getElementById('yaml-preview').textContent = toYaml(sig);
}

function validate() {
  const sig = getSig();
  const errors = [];
  if (!sig.id) errors.push('ID is required.');
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(sig.id)) errors.push('ID must be kebab-case (e.g. high-blocked-ratio).');
  if (!sig.name) errors.push('Name is required.');
  if (!sig.description) errors.push('Description is required.');
  if (sig.conditions.length === 0) errors.push('At least one condition is required.');
  for (let i = 0; i < sig.conditions.length; i++) {
    const c = sig.conditions[i];
    if (!c.description) errors.push('Condition ' + (i + 1) + ': description is required.');
    if (c.value === '' || c.value === null || c.value === undefined) errors.push('Condition ' + (i + 1) + ': value is required.');
  }
  return errors;
}

function save() {
  const errors = validate();
  if (errors.length > 0) {
    alert('Please fix the following:\\n' + errors.join('\\n'));
    return;
  }
  const sig = getSig();
  vscode.postMessage({ type: 'save', ...sig });
}

function cancel() { vscode.postMessage({ type: 'cancel' }); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Initialise with one empty condition and render
addCondition();
onInput();
</script>
</body>
</html>`;
}
