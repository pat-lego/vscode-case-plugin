import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CdnAnalysisReport, CdnAnalysisInput } from '@incident-investigator/core';
import { CdnAnalysisService } from '../services/cdn-service';
import { CaseManager } from '../services/case-manager';
import { IILogger, nullLogger } from '../logger';

/**
 * The "Analyze CDN Cache Misses" panel. Two data sources:
 *   - Query Splunk: collects service / tier / window / URLs and runs `sky splunk query`.
 *   - Paste or load a saved export: analyses captured `sky splunk query` output offline (no query).
 * Either way it renders the ranked cache-MISS hypotheses as findings.
 */
export class CdnAnalysisPanel {
  static show(_context: vscode.ExtensionContext, service: CdnAnalysisService, caseManager: CaseManager, log: IILogger = nullLogger) {
    const panel = vscode.window.createWebviewPanel(
      'investigator.cdnAnalysis',
      'CDN Cache Miss Analysis',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const cfg = service.getConfig();
    panel.webview.html = buildHtml({ index: cfg.index, sourcetype: cfg.sourcetype, baseline: cfg.baseline, tier: cfg.defaultTier });

    let lastReport: CdnAnalysisReport | null = null;

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.type === 'analyze') {
        const service_ = String(msg.service ?? '').trim();
        const from = String(msg.from ?? '').trim();
        const to = String(msg.to ?? '').trim();
        const tier: 'author' | 'publish' = String(msg.tier ?? 'publish') === 'author' ? 'author' : 'publish';
        const urls = String(msg.urls ?? '')
          .split('\n')
          .map(u => u.trim())
          .filter(Boolean);

        if (!service_ || !from || !to) {
          panel.webview.postMessage({ type: 'error', message: 'Service, From and To are all required.' });
          return;
        }

        try {
          const report = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Querying CDN logs for ${service_} (${tier})… (this can take a while)`,
              cancellable: false
            },
            () => service.analyze({ service: service_, from, to, urls, tier })
          );
          lastReport = report;
          panel.webview.postMessage({ type: 'results', report });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('cdn', 'analysis failed', { err: message });
          panel.webview.postMessage({ type: 'error', message });
        }
      }

      if (msg.type === 'analyzeSave') {
        const service_ = String(msg.service ?? '').trim();
        const from = String(msg.from ?? '').trim();
        const to = String(msg.to ?? '').trim();
        const tier: 'author' | 'publish' = String(msg.tier ?? 'publish') === 'author' ? 'author' : 'publish';
        const urls = String(msg.urls ?? '').split('\n').map(u => u.trim()).filter(Boolean);
        if (!service_ || !from || !to) {
          panel.webview.postMessage({ type: 'error', message: 'Service, From and To are all required.' });
          return;
        }
        const uri = await vscode.window.showSaveDialog({
          saveLabel: 'Run & save raw',
          filters: { 'CDN export': ['json', 'ndjson'] },
          defaultUri: vscode.Uri.file(`cdn-${service_}-${tier}.json`)
        });
        if (!uri) { panel.webview.postMessage({ type: 'idle' }); return; }
        try {
          const report = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Querying CDN logs for ${service_} (${tier}) and saving raw…`, cancellable: false },
            () => service.analyze({ service: service_, from, to, urls, tier }, uri.fsPath)
          );
          lastReport = report;
          panel.webview.postMessage({ type: 'results', report });
          vscode.window.showInformationMessage(`Saved raw CDN data to ${uri.fsPath} — replay it later via "Analyze a pasted / saved export".`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('cdn', 'analysis failed', { err: message });
          panel.webview.postMessage({ type: 'error', message });
        }
      }

      if (msg.type === 'analyzePasted') {
        const text = String(msg.text ?? '');
        if (!text.trim()) {
          panel.webview.postMessage({ type: 'error', message: 'Paste an export, or use Load export file.' });
          return;
        }
        try {
          const report = await service.analyzeText(text, pastedInput(msg));
          lastReport = report;
          panel.webview.postMessage({ type: 'results', report });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('cdn', 'pasted analysis failed', { err: message });
          panel.webview.postMessage({ type: 'error', message });
        }
      }

      if (msg.type === 'loadFile') {
        try {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Analyze',
            filters: { 'CDN export': ['json', 'ndjson', 'log', 'txt'], 'All Files': ['*'] }
          });
          if (!uris || !uris.length) {
            panel.webview.postMessage({ type: 'idle' });
            return;
          }
          const filePath = uris[0].fsPath;
          const report = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Analyzing CDN export ${path.basename(filePath)}...`,
              cancellable: false
            },
            () => service.analyzeFile(filePath, pastedInput(msg))
          );
          lastReport = report;
          panel.webview.postMessage({ type: 'results', report });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('cdn', 'file analysis failed', { err: message });
          panel.webview.postMessage({ type: 'error', message });
        }
      }

      if (msg.type === 'copyMarkdown') {
        if (!lastReport) return;
        await vscode.env.clipboard.writeText(reportToMarkdown(lastReport));
        vscode.window.showInformationMessage('CDN analysis copied to clipboard as Markdown.');
      }

      if (msg.type === 'addFindingToCase') {
        const index = Number(msg.index);
        const finding = lastReport?.findings?.[index];
        if (!lastReport || !finding) {
          panel.webview.postMessage({ type: 'addFindingToCaseResult', index, ok: false, error: 'Finding not found — re-run the analysis.' });
          return;
        }
        const caseId = caseManager.getActiveCaseId();
        if (!caseId) {
          panel.webview.postMessage({ type: 'addFindingToCaseResult', index, ok: false, error: 'No active case open.' });
          return;
        }
        const caseDir = caseManager.getCaseDir(caseId);
        if (!caseDir) {
          panel.webview.postMessage({ type: 'addFindingToCaseResult', index, ok: false, error: 'Could not determine case directory.' });
          return;
        }
        try {
          fs.mkdirSync(caseDir, { recursive: true });
          const markdown = findingToMarkdown(lastReport, finding);
          const ts = new Date();
          const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}h${String(ts.getMinutes()).padStart(2, '0')}m`;
          const filename = `cdn-${slugify(finding.signatureName)}-${stamp}.md`;
          const filePath = path.join(caseDir, filename);
          fs.writeFileSync(filePath, markdown, 'utf-8');
          const evId = `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          caseManager.addEvidence(caseId, {
            id: evId,
            type: 'generic',
            source: filename,
            capturedAt: ts,
            filePath
          });
          log.info('cdn', 'addFindingToCase success', { caseId, filename });
          panel.webview.postMessage({ type: 'addFindingToCaseResult', index, ok: true, filename });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('cdn', 'addFindingToCase failed', { err: message });
          panel.webview.postMessage({ type: 'addFindingToCaseResult', index, ok: false, error: message });
        }
      }
    });
  }
}

/** Builds the analysis input for offline (paste/file) mode, where service/window are optional context. */
function pastedInput(msg: Record<string, unknown>): CdnAnalysisInput {
  const tier: 'author' | 'publish' = String(msg.tier ?? 'publish') === 'author' ? 'author' : 'publish';
  const urls = String(msg.urls ?? '').split('\n').map(u => u.trim()).filter(Boolean);
  return {
    service: String(msg.service ?? '').trim() || '(from export)',
    from: String(msg.from ?? '').trim() || '(export)',
    to: String(msg.to ?? '').trim() || '(export)',
    tier,
    urls
  };
}

/** Renders a report as Markdown for the "Copy" action. */
function reportToMarkdown(r: CdnAnalysisReport): string {
  const m = r.metrics;
  const lines: string[] = [
    `# CDN Cache Miss Analysis — ${r.input.service}`,
    '',
    `**Tier:** ${r.input.tier ?? 'publish'}`,
    `**Window:** ${r.input.from} → ${r.input.to}`,
    r.input.urls && r.input.urls.length ? `**URLs:** ${r.input.urls.join(', ')}` : '**URLs:** (all)',
    `**Generated:** ${new Date(r.generatedAt).toISOString()}`,
    '',
    `## Summary`,
    r.summary,
    '',
    ...(r.splunkQueries && r.splunkQueries.length
      ? ['## Splunk queries', '', ...r.splunkQueries.flatMap(q => ['```', q, '```']), '']
      : []),
    `## Key metrics`,
    `- Events analysed: ${m.totalRequests}`,
    `- Cache MISS: ${m.missCount}  |  HIT: ${m.hitCount}  |  PASS: ${m.passCount} (PASS+200: ${m.passWith200Count})`,
    `- PASS breakdown: ${pct(m.passWith200Share)} are 200 (bypassing cache), ${pct(m.passNon200Non429Share)} non-200 excl. 429 (429s: ${m.pass429Count})`,
    `- MISS ratio (MISS/MISS+HIT): ${pct(m.missRatio)}`,
    `- HTTP 429: ${m.error429Count} (${pct(m.missShareOf429)} on MISS); origin 5xx: ${m.originError5xxCount}`,
    `- Distinct MISS URLs: ${m.distinctMissUrlCount} (unique ratio ${pct(m.uniqueMissUrlRatio)})`,
    `- Why MISS: ${pct(m.coldPopFirstFetchShare)} first-fetch-at-POP (cold), ${pct(m.repeatSamePopShare)} repeat-at-same-POP (should HIT), ${pct(Math.max(m.missNoPositiveTtlShare, m.missNoStoreShare))} not-cacheable-by-directive`,
    `- POPs serving MISS: ${m.distinctPopCount}; origin shielding on: ${pct(m.shieldingUsedMissShare)} of MISSes`,
    m.ttlDataSufficient
      ? `- TTL: current ${m.observedMaxAgeSeconds || '?'}s, recommended ~${m.recommendedTtlSeconds}s (req rate ${m.cacheableRequestRatePerMin.toFixed(1)}/min; P90 gap shield ${Math.round(m.p90AggGapSeconds)}s / edge ${Math.round(m.p90PerPopGapSeconds)}s)`
      : `- TTL: insufficient repeat-request data in this window to size a TTL`,
    `- Bot MISS share: ${pct(m.botMissShare)}; rare-POP MISS share: ${pct(m.rarePopMissShare)}`,
    `- Traffic sources: ${pct(m.cloudAsnRequestShare)} from cloud/hosting ASNs; top ${m.topAsnRequestName || '?'} (${pct(m.topAsnRequestShare)}); peak ${m.peakRequestsPerSec}/s (burst ${m.burstRatio.toFixed(1)}×); CDN-flagged ${pct(m.cdnThreatShare)}`,
    `- Client concentration: ${m.distinctClientIpCount} distinct IPs (top ${pct(m.topClientIpRequestShare)}: ${m.topClientIpAddress || '?'}); ${m.distinctUserAgentCount} distinct user agents (top ${pct(m.topUserAgentRequestShare)}: "${m.topUserAgentName || '?'}"); ${m.distinctCountryCount} distinct countries (top ${pct(m.topCountryRequestShare)}: ${m.topCountryCode || '?'})`,
    ''
  ];

  if (m.warnings.length) {
    lines.push('## Warnings', ...m.warnings.map(w => `- ${w}`), '');
  }

  lines.push('## Findings');
  for (const f of r.findings) {
    lines.push('', ...findingLines(f));
  }
  return lines.join('\n');
}

/** Renders a single finding's heading, signals, evidence and next steps as Markdown lines. */
function findingLines(f: CdnAnalysisReport['findings'][number]): string[] {
  const lines: string[] = [`### [${f.confidence.toUpperCase()}] ${f.signatureName}`];
  if (f.matchedConditions.length) {
    lines.push('**Signals matched:**');
    for (const c of f.matchedConditions) lines.push(`- ${c.description} — \`${c.observedValue}\``);
  }
  if (f.evidence.length) {
    lines.push('**Evidence:**');
    for (const e of f.evidence) lines.push(`- ${e}`);
  }
  if (f.nextSteps.length) {
    lines.push('**Next steps:**');
    for (const s of f.nextSteps) lines.push(`- ${s}`);
  }
  return lines;
}

/** Renders a single finding as a standalone Markdown doc (with report context) for the "Add to Case" action. */
function findingToMarkdown(r: CdnAnalysisReport, f: CdnAnalysisReport['findings'][number]): string {
  const lines: string[] = [
    `# CDN Cache Miss Analysis — ${r.input.service} — ${f.signatureName}`,
    '',
    `**Tier:** ${r.input.tier ?? 'publish'}`,
    `**Window:** ${r.input.from} → ${r.input.to}`,
    r.input.urls && r.input.urls.length ? `**URLs:** ${r.input.urls.join(', ')}` : '**URLs:** (all)',
    `**Generated:** ${new Date(r.generatedAt).toISOString()}`,
    '',
    ...findingLines(f)
  ];
  return lines.join('\n');
}

/** Slugifies a signature name for use in a filename. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finding';
}

/**
 * Formats a 0–1 ratio as a percentage. Plain nearest-integer rounding would show "100%"/"0%" for
 * values merely close to those boundaries, which reads as an impossible claim of certainty — show
 * two decimal places instead whenever rounding would land exactly on a boundary the raw value did
 * not actually reach.
 */
function pct(x: number): string {
  const p = x * 100;
  const rounded = Math.round(p);
  if ((rounded === 100 && p < 100) || (rounded === 0 && p > 0)) return `${p.toFixed(2)}%`;
  return `${rounded}%`;
}

function buildHtml(defaults: { index: string; sourcetype: string; baseline: boolean; tier: 'author' | 'publish' }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CDN Cache Miss Analysis</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}
h2{font-size:13px;font-weight:600;margin-bottom:12px}
h3{font-size:12px;font-weight:600;margin:14px 0 6px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.section{margin-bottom:12px}
label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
input,textarea,select{width:100%;padding:4px 7px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:inherit;font-size:12px}
textarea{resize:vertical;min-height:60px;font-family:var(--vscode-editor-font-family,monospace)}
input:focus,textarea:focus,select:focus{outline:1px solid var(--vscode-focusBorder)}
.hint{font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px}
.actions{display:flex;gap:8px;margin-top:8px;align-items:center}
.btn{padding:4px 12px;font-size:12px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn:disabled{opacity:.5;cursor:default}
.meta{font-size:10px;color:var(--vscode-descriptionForeground)}
.warn{background:var(--vscode-inputValidation-warningBackground,rgba(255,200,0,.1));border:1px solid var(--vscode-inputValidation-warningBorder,#c90);padding:6px 8px;border-radius:2px;font-size:11px;margin-bottom:10px}
.summary{border-left:3px solid var(--vscode-focusBorder);padding:8px 10px;background:var(--vscode-textBlockQuote-background);border-radius:2px;margin:10px 0;font-size:12px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;margin:10px 0}
.metric{background:var(--vscode-editorWidget-background,rgba(127,127,127,.08));border:1px solid var(--vscode-panel-border);border-radius:3px;padding:6px 8px}
.metric .k{font-size:10px;color:var(--vscode-descriptionForeground)}
.metric .v{font-size:14px;font-weight:600}
.finding{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:10px;margin-bottom:10px}
.finding.high{border-left:3px solid var(--vscode-charts-red,#e51400)}
.finding.medium{border-left:3px solid var(--vscode-charts-yellow,#c90)}
.finding.low{border-left:3px solid var(--vscode-charts-blue,#3794ff)}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-right:6px;text-transform:uppercase}
.badge.high{background:var(--vscode-charts-red,#e51400);color:#fff}
.badge.medium{background:var(--vscode-charts-yellow,#c90);color:#000}
.badge.low{background:var(--vscode-charts-blue,#3794ff);color:#fff}
.finding h4{font-size:12px;display:inline}
.finding ul{margin:6px 0 6px 16px;font-size:11px}
.finding .cond{color:var(--vscode-foreground)}
.finding .obs{color:var(--vscode-descriptionForeground)}
.finding-top{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.btn-sm{padding:2px 8px;font-size:10px;margin-left:auto}
.add-case-msg{font-size:10px}
.label-sm{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground);margin-top:6px}
code{font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
details{margin:8px 0}
summary{cursor:pointer;font-size:11px;color:var(--vscode-textLink-foreground)}
pre{white-space:pre-wrap;word-break:break-all;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.12));padding:6px 8px;border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;margin:4px 0}
</style>
</head>
<body>
<h2>CDN Cache Miss Analysis</h2>
<div class="meta">Source: index <code>${escapeAttr(defaults.index)}</code>, sourcetype <code>${escapeAttr(defaults.sourcetype || '(none - optional)')}</code> | baseline ${defaults.baseline ? 'on (max 2d)' : 'off'} | edit in settings (investigator.cdn.*)</div>

<div class="section" style="margin-top:12px">
  <label>Data source</label>
  <select id="mode" onchange="onMode()">
    <option value="splunk">Query Splunk (runs sky splunk query)</option>
    <option value="paste">Analyze a pasted / saved export (no query)</option>
  </select>
</div>

<div class="grid">
  <div class="section">
    <label>AEM service (aem_service)</label>
    <input id="service" placeholder="cm-p53812-e590634" />
  </div>
  <div class="section">
    <label>Tier (aem_tier)</label>
    <select id="tier">
      <option value="publish"${defaults.tier === 'publish' ? ' selected' : ''}>publish</option>
      <option value="author"${defaults.tier === 'author' ? ' selected' : ''}>author</option>
    </select>
  </div>
</div>
<div class="grid">
  <div class="section">
    <label>From (earliest)</label>
    <input id="from" value="-60m@m" />
    <div class="hint">ISO 8601 (2026-07-16T03:30:00Z) or Splunk relative (-60m@m, -2h)</div>
  </div>
  <div class="section">
    <label>To (latest)</label>
    <input id="to" value="now" />
    <div class="hint">ISO 8601 or Splunk relative (now, @m)</div>
  </div>
</div>
<div class="section">
  <label>URLs to check (one per line, optional - * wildcards allowed)</label>
  <textarea id="urls" placeholder="/apac/galaxy/*&#10;/products/foo"></textarea>
  <div class="hint">Leave empty to analyse all URLs for the service. In export mode the fields above are just labels for the report.</div>
</div>
<div class="section" id="paste-section" style="display:none">
  <label>Paste CDN export (sky splunk query JSON / NDJSON, or the raw KV event block)</label>
  <textarea id="pasted" style="min-height:140px" placeholder="Paste sky splunk query output here, or use Load export file below"></textarea>
  <div class="actions" style="margin-top:6px">
    <button class="btn" id="loadfile" type="button" onclick="loadFile()">Load export file...</button>
    <span class="hint">Large files are streamed line-by-line.</span>
  </div>
</div>
<div class="actions">
  <button class="btn primary" id="run" onclick="run()">Run analysis</button>
  <button class="btn" id="runsave" onclick="runSave()">Run &amp; save raw...</button>
  <button class="btn" id="copy" onclick="copyMd()" disabled>Copy Markdown</button>
  <span class="meta" id="status"></span>
</div>

<div id="results"></div>

<script>
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);

function ctx() {
  return {
    service: $('service').value,
    tier: $('tier').value,
    from: $('from').value,
    to: $('to').value,
    urls: $('urls').value
  };
}
function setBusy(s) {
  $('run').disabled = true;
  $('runsave').disabled = true;
  $('copy').disabled = true;
  $('status').textContent = s;
  $('results').innerHTML = '';
}
function onMode() {
  const paste = $('mode').value === 'paste';
  $('paste-section').style.display = paste ? '' : 'none';
  $('runsave').style.display = paste ? 'none' : '';
  $('run').textContent = paste ? 'Analyze pasted export' : 'Run analysis';
}
function runSave() {
  setBusy('Running & saving...');
  vscode.postMessage(Object.assign({ type: 'analyzeSave' }, ctx()));
}
function run() {
  if ($('mode').value === 'paste') {
    const text = $('pasted').value;
    if (!text.trim()) { $('results').innerHTML = '<div class="warn">Paste an export, or use Load export file.</div>'; return; }
    setBusy('Analyzing pasted export...');
    vscode.postMessage(Object.assign({ type: 'analyzePasted', text: text }, ctx()));
  } else {
    setBusy('Running...');
    vscode.postMessage(Object.assign({ type: 'analyze' }, ctx()));
  }
}
function loadFile() {
  setBusy('Loading file...');
  vscode.postMessage(Object.assign({ type: 'loadFile' }, ctx()));
}
function copyMd() { vscode.postMessage({ type: 'copyMarkdown' }); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function pct(x){ var p=x*100; var r=Math.round(p); if ((r===100&&p<100)||(r===0&&p>0)) return p.toFixed(2)+'%'; return r+'%'; }

function metric(k, v){ return '<div class="metric"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>'; }

function renderFinding(f, index){
  let h = '<div class="finding '+esc(f.confidence)+'">';
  h += '<div class="finding-top">';
  h += '<span class="badge '+esc(f.confidence)+'">'+esc(f.confidence)+'</span>';
  h += '<h4>'+esc(f.signatureName)+'</h4>';
  h += '<button class="btn btn-sm add-case-btn" data-index="'+index+'" type="button">+ Add to Case</button>';
  h += '<span class="meta add-case-msg" data-index="'+index+'"></span>';
  h += '</div>';
  if (f.matchedConditions && f.matchedConditions.length){
    h += '<div class="label-sm">Signals matched</div><ul>';
    for (const c of f.matchedConditions){
      h += '<li><span class="cond">'+esc(c.description)+'</span> - <span class="obs">'+esc(c.observedValue)+'</span></li>';
    }
    h += '</ul>';
  }
  if (f.evidence && f.evidence.length){
    h += '<div class="label-sm">Evidence</div><ul>';
    for (const e of f.evidence){ h += '<li>'+esc(e)+'</li>'; }
    h += '</ul>';
  }
  if (f.nextSteps && f.nextSteps.length){
    h += '<div class="label-sm">Next steps</div><ul>';
    for (const s of f.nextSteps){ h += '<li>'+esc(s)+'</li>'; }
    h += '</ul>';
  }
  h += '</div>';
  return h;
}

function render(report){
  const m = report.metrics;
  let h = '';
  h += '<div class="summary">'+esc(report.summary)+'</div>';
  if (report.splunkQueries && report.splunkQueries.length){
    h += '<details class="queries"><summary>Splunk queries ('+report.splunkQueries.length+') - click to show your work</summary>';
    for (const q of report.splunkQueries){ h += '<pre>'+esc(q)+'</pre>'; }
    h += '</details>';
  }
  h += '<div class="metrics">';
  h += metric('Events', m.totalRequests);
  h += metric('Cache MISS', m.missCount);
  h += metric('MISS ratio', pct(m.missRatio));
  h += metric('PASS (200)', m.passCount+' ('+m.passWith200Count+')');
  h += metric('PASS 200 / other', pct(m.passWith200Share)+' / '+pct(1-m.passWith200Share));
  h += metric('HTTP 429', m.error429Count+' | '+pct(m.missShareOf429)+' on MISS');
  h += metric('Origin 5xx', m.originError5xxCount);
  h += metric('Distinct MISS URLs', m.distinctMissUrlCount+' ('+pct(m.uniqueMissUrlRatio)+' uniq)');
  h += metric('First fetch / cold POP', pct(m.coldPopFirstFetchShare));
  h += metric('Repeat at same POP', pct(m.repeatSamePopShare)+' (should HIT)');
  h += metric('POPs (MISS)', m.distinctPopCount);
  h += metric('Shielding on (MISS)', pct(m.shieldingUsedMissShare));
  h += metric('TTL cur / rec', (m.observedMaxAgeSeconds ? m.observedMaxAgeSeconds+'s' : '-') + ' / ' + (m.recommendedTtlSeconds ? m.recommendedTtlSeconds+'s' : 'n/a'));
  h += metric('Bot MISS share', pct(m.botMissShare));
  h += metric('Rare-POP MISS', pct(m.rarePopMissShare)+(m.baselineUsed? ' (baseline)':' (in-window)'));
  h += metric('Cloud-ASN reqs', pct(m.cloudAsnRequestShare));
  h += metric('Burst peak/s', m.peakRequestsPerSec+' ('+m.burstRatio.toFixed(1)+'x)');
  h += metric('Top client IP', m.distinctClientIpCount+' distinct ('+pct(m.topClientIpRequestShare)+': '+(m.topClientIpAddress||'?')+')');
  h += metric('Top user agent', m.distinctUserAgentCount+' distinct ('+pct(m.topUserAgentRequestShare)+')');
  h += metric('Top country', m.distinctCountryCount+' distinct ('+pct(m.topCountryRequestShare)+': '+(m.topCountryCode||'?')+')');
  h += '</div>';

  if (m.warnings && m.warnings.length){
    h += '<div class="warn">'+m.warnings.map(esc).join('<br>')+'</div>';
  }

  h += '<h3>Findings</h3>';
  if (!report.findings || !report.findings.length){
    h += '<div class="meta">No hypotheses met their thresholds.</div>';
  } else {
    report.findings.forEach((f, i) => { h += renderFinding(f, i); });
  }
  $('results').innerHTML = h;
}

document.getElementById('results').addEventListener('click', ev => {
  const btn = ev.target && ev.target.closest && ev.target.closest('.add-case-btn');
  if (!btn) return;
  const index = Number(btn.dataset.index);
  btn.disabled = true;
  const msgEl = document.querySelector('.add-case-msg[data-index="'+index+'"]');
  if (msgEl) msgEl.textContent = 'Saving...';
  vscode.postMessage({ type: 'addFindingToCase', index: index });
});

window.addEventListener('message', ev => {
  const msg = ev.data;
  $('run').disabled = false;
  $('runsave').disabled = false;
  if (msg.type === 'results'){
    $('status').textContent = 'Done - '+msg.report.entryCount+' events';
    $('copy').disabled = false;
    render(msg.report);
  }
  if (msg.type === 'error'){
    $('status').textContent = '';
    $('results').innerHTML = '<div class="warn">'+esc(msg.message)+'</div>';
  }
  if (msg.type === 'idle'){
    $('status').textContent = '';
  }
  if (msg.type === 'addFindingToCaseResult'){
    const btn = document.querySelector('.add-case-btn[data-index="'+msg.index+'"]');
    const msgEl = document.querySelector('.add-case-msg[data-index="'+msg.index+'"]');
    if (btn) btn.disabled = false;
    if (msgEl){
      if (msg.ok){
        msgEl.textContent = 'Saved: '+msg.filename;
        msgEl.style.color = 'var(--vscode-charts-green,#4ec9b0)';
      } else {
        msgEl.textContent = 'Error: '+(msg.error || 'unknown error');
        msgEl.style.color = 'var(--vscode-errorForeground)';
      }
    }
  }
});
onMode();
</script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
