import * as vscode from 'vscode';
import { Signature } from '@incident-investigator/core';
import { SignatureService } from '../services/signature-service';

export class ManualSignatureBuilderPanel {
  static show(context: vscode.ExtensionContext, sigService: SignatureService, existing?: Signature) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.manualSignatureBuilder',
      existing ? `Edit: ${existing.name}` : 'New Signature',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = buildHtml(existing);

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
          vscode.window.showInformationMessage(`Signature "${sig.name}" saved (v${sig.version}).`);
          panel.dispose();
        }
      }
      if (msg.type === 'cancel') {
        panel.dispose();
      }
    });
  }
}

function bumpVersionStr(v: string): string {
  const parts = (v || '1.0').split('.');
  const major = parseInt(parts[0], 10) || 1;
  const minor = parseInt(parts[1] ?? '0', 10);
  return `${major}.${minor + 1}`;
}

function buildHtml(existing?: Signature): string {
  const isEdit = !!existing;
  const initialJson = existing ? JSON.stringify(existing) : 'null';
  const newVersion = existing ? bumpVersionStr(existing.version || '1.0') : '1.0';
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
<h1>${isEdit ? 'Edit Signature' : 'New Signature'}</h1>
${isEdit ? '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:14px;padding:5px 8px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:3px">Editing existing signature — ID is locked. Version will be auto-incremented to <strong>' + newVersion + '</strong> on save.</div>' : ''}

<h2>Identity</h2>
<div class="two-col">
  <div class="field-row">
    <label for="sig-id">ID (kebab-case)${isEdit ? ' — locked' : ''}</label>
    <input id="sig-id" placeholder="e.g. high-blocked-thread-ratio" oninput="onInput()" ${isEdit ? 'readonly style="opacity:.55;cursor:not-allowed"' : ''}>
  </div>
  <div class="field-row">
    <label for="sig-version">Version${isEdit ? ' — auto-incremented' : ''}</label>
    <input id="sig-version" value="${newVersion}" oninput="onInput()" ${isEdit ? 'readonly style="opacity:.55;cursor:not-allowed"' : ''}>
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
<button class="add-btn" id="add-cond-btn">+ Add Condition</button>

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
  <button class="btn primary" id="save-btn">${isEdit ? 'Save Changes' : 'Save to Signature Library'}</button>
  <button class="btn" id="cancel-btn">Cancel</button>
</div>

<script>
window.onerror = function(msg, src, line) {
  var b = document.createElement('div');
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f14c4c;color:#fff;padding:6px 10px;font-size:11px;z-index:9999;font-family:monospace';
  b.textContent = 'JS Error (line ' + line + '): ' + msg;
  document.body.prepend(b);
};
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
  var list = document.getElementById('cond-list');
  list.innerHTML = '';
  for (var ci = 0; ci < conditions.length; ci++) {
    var c = conditions[ci];
    var fieldType = getFieldType(c.field);
    var operators = getOperatorsForType(fieldType);

    var fieldOpts = '';
    for (var gi = 0; gi < FIELDS.length; gi++) {
      var g = FIELDS[gi];
      fieldOpts += '<optgroup label="' + esc(g.group) + '">';
      for (var fi = 0; fi < g.fields.length; fi++) {
        var f = g.fields[fi];
        var selF = f.value === c.field ? ' selected' : '';
        fieldOpts += '<option value="' + f.value + '"' + selF + '>' + esc(f.label) + ' (' + f.type.toUpperCase() + ')</option>';
      }
      fieldOpts += '</optgroup>';
    }

    var opOpts = '';
    for (var oi = 0; oi < operators.length; oi++) {
      var op = operators[oi];
      var selO = op.value === c.operator ? ' selected' : '';
      opOpts += '<option value="' + op.value + '"' + selO + '>' + esc(op.label) + '</option>';
    }

    var valueInput;
    if (fieldType === 'flag') {
      var v0sel = String(c.value) === '0' ? ' selected' : '';
      var v1sel = String(c.value) === '1' ? ' selected' : '';
      valueInput = '<select data-field="value"><option value="1"' + v1sel + '>1 (detected)</option><option value="0"' + v0sel + '>0 (not detected)</option></select>';
    } else if (fieldType === 'string') {
      valueInput = '<input type="text" placeholder="value" value="' + esc(String(c.value ?? '')) + '" data-field="value">';
    } else {
      valueInput = '<input type="number" placeholder="0" value="' + esc(String(c.value ?? '')) + '" data-field="value">';
    }

    var block = document.createElement('div');
    block.className = 'cond-block';
    block.dataset.condId = String(c.id);
    block.innerHTML =
      '<button class="remove-btn" data-remove="true" title="Remove condition">&times;</button>' +
      '<div class="cond-grid">' +
        '<div><label>Field</label><select data-field="field">' + fieldOpts + '</select></div>' +
        '<div><label>Operator</label><select data-field="operator">' + opOpts + '</select></div>' +
        '<div><label>Value</label>' + valueInput + '</div>' +
      '</div>' +
      '<div class="cond-desc-row"><label>Description (plain English)</label>' +
        '<input type="text" placeholder="e.g. More than 50 threads are blocked on a lock" value="' + esc(c.description) + '" data-field="description">' +
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

// ── Event delegation for dynamically-created condition blocks ────────────────
document.getElementById('cond-list').addEventListener('click', function(e) {
  var btn = e.target.closest('[data-remove]');
  if (!btn) return;
  var block = btn.closest('[data-cond-id]');
  if (block) removeCondition(Number(block.dataset.condId));
});

// change fires for select elements (field, operator, flag value)
document.getElementById('cond-list').addEventListener('change', function(e) {
  var el = e.target;
  if (!el.dataset || !el.dataset.field) return;
  var block = el.closest('[data-cond-id]');
  if (!block) return;
  setCondField(Number(block.dataset.condId), el.dataset.field, el.value);
  onInput();
});

// input fires for text/number inputs (string value, description)
document.getElementById('cond-list').addEventListener('input', function(e) {
  var el = e.target;
  if (!el.dataset || !el.dataset.field) return;
  var field = el.dataset.field;
  if (field === 'field' || field === 'operator') return; // handled by change
  var block = el.closest('[data-cond-id]');
  if (!block) return;
  setCondField(Number(block.dataset.condId), field, el.value);
  onInput();
});

// ── Static button wiring ───────────────────────────────────────────────────
document.getElementById('add-cond-btn').addEventListener('click', function() { addCondition(); });
document.getElementById('save-btn').addEventListener('click', function() { save(); });
document.getElementById('cancel-btn').addEventListener('click', function() { cancel(); });

// ── Initialise ─────────────────────────────────────────────────────────────
var INITIAL_DATA = ${initialJson};
if (INITIAL_DATA) {
  document.getElementById('sig-id').value = INITIAL_DATA.id || '';
  document.getElementById('sig-name').value = INITIAL_DATA.name || '';
  document.getElementById('sig-desc').value = INITIAL_DATA.description || '';
  document.getElementById('next-steps').value = (INITIAL_DATA.nextSteps || []).join('\\n');
  document.getElementById('related').value = (INITIAL_DATA.relatedSignatures || []).join(', ');
  // Load conditions from existing signature
  conditions = [];
  nextId = 0;
  var ecs = INITIAL_DATA.conditions || [];
  for (var ei = 0; ei < ecs.length; ei++) {
    var ec = ecs[ei];
    conditions.push({ id: nextId++, field: ec.field || 'blockedThreadCount', operator: ec.operator || 'gte', value: ec.value !== undefined ? ec.value : '', description: ec.description || '' });
  }
  if (conditions.length === 0) addCondition();
  else renderConditions();
} else {
  addCondition();
}
onInput();
</script>
</body>
</html>`;
}
