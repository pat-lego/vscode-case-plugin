import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';
import { SignatureService } from '../services/signature-service';

export class ClaudeReviewPanel {
  static show(context: vscode.ExtensionContext, caseId: string, caseManager: CaseManager, sigService?: SignatureService) {
    ClaudeReviewPanel.open(context, caseId, undefined, caseManager, sigService);
  }

  static showForSignature(
    context: vscode.ExtensionContext,
    caseId: string,
    signatureId: string,
    caseManager: CaseManager,
    sigService?: SignatureService
  ) {
    ClaudeReviewPanel.open(context, caseId, signatureId, caseManager, sigService);
  }

  private static open(
    context: vscode.ExtensionContext,
    caseId: string,
    focusSignatureId: string | undefined,
    caseManager: CaseManager,
    sigService?: SignatureService
  ) {
    const session = caseManager.getSession(caseId);
    if (!session) return;

    const panel = vscode.window.createWebviewPanel(
      'investigator.claudeReview',
      `Claude Review — ${caseId}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    const allSignatures = sigService?.getAll() ?? [];
    const summary = buildContext(session, focusSignatureId, allSignatures);
    panel.webview.html = buildHtml(caseId, summary);

    panel.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'runReview') {
        const apiKey = vscode.workspace.getConfiguration('investigator').get<string>('claudeApiKey');
        if (!apiKey) {
          panel.webview.postMessage({
            type: 'result',
            error: 'No Claude API key configured. Set investigator.claudeApiKey in settings.'
          });
          return;
        }
        try {
          const result = await callClaude(apiKey, msg.prompt);
          panel.webview.postMessage({ type: 'result', text: result });
        } catch (e) {
          panel.webview.postMessage({ type: 'result', error: String(e) });
        }
      }
      if (msg.type === 'createSignature') {
        vscode.commands.executeCommand('investigator.buildSignature', caseId, msg.finding);
      }
      if (msg.type === 'cancel') panel.dispose();
    });
  }
}

function buildContext(
  session: ReturnType<CaseManager['getSession']>,
  focusSignatureId?: string,
  allSignatures: ReturnType<SignatureService['getAll']> = []
): string {
  if (!session) return '';
  const { meta, findings, threadDumpSignals } = session;

  const lines: string[] = [
    `Case: ${meta.id} — ${meta.title}`,
    `Evidence: ${meta.evidence.length} item(s)`,
    `Thread dumps: ${threadDumpSignals.length}`
  ];

  if (threadDumpSignals.length > 0) {
    const last = threadDumpSignals[threadDumpSignals.length - 1]!;
    lines.push(`Latest dump: ${last.totalThreadCount} threads total`);
    lines.push(`  RUNNABLE: ${last.stateCounts.RUNNABLE}, BLOCKED: ${last.stateCounts.BLOCKED}, WAITING: ${last.stateCounts.WAITING}`);
    lines.push(`  IO threads: ${last.ioThreadCount}`);
    if (last.stackFingerprints.length > 0) {
      const top = last.stackFingerprints[0];
      lines.push(`  Top fingerprint: ${top.count} threads on ${top.topFrame}`);
    }
    if (last.blockedMonitors.length > 0) {
      lines.push(`  Blocked monitors: ${last.blockedMonitors.length}, max waiters: ${Math.max(...last.blockedMonitors.map(m => m.waitingThreadCount))}`);
    }
  }

  if (findings.length > 0) {
    lines.push('\n## Matched Signatures');
    const matchedIds = new Set(findings.map(f => f.signatureId));
    for (const f of findings) {
      lines.push(`\n### [${f.confidence.toUpperCase()}] ${f.signatureName}`);
      lines.push(`Evidence: ${f.evidence.join('; ')}`);
      const sig = allSignatures.find(s => s.id === f.signatureId);
      if (sig) {
        if (sig.description) lines.push(`What this means: ${sig.description}`);
        if (sig.indicators.length > 0) lines.push(`Indicators: ${sig.indicators.join('; ')}`);
        if (sig.nextSteps.length > 0) lines.push(`Recommended next steps: ${sig.nextSteps.join('; ')}`);
        if (sig.relatedSignatures.length > 0) lines.push(`Related patterns: ${sig.relatedSignatures.join(', ')}`);
      }
    }

    // Signatures not matched — brief catalogue so Claude knows what was ruled out
    const unmatched = allSignatures.filter(s => !matchedIds.has(s.id));
    if (unmatched.length > 0) {
      lines.push('\n## Available Signatures (not matched)');
      for (const s of unmatched) {
        lines.push(`- ${s.name}: ${s.description}`);
      }
    }
  } else if (allSignatures.length > 0) {
    lines.push('\n## Signature Library');
    lines.push('No signatures matched yet. Available patterns to consider:');
    for (const s of allSignatures) {
      lines.push(`\n### ${s.name}`);
      lines.push(`What it detects: ${s.description}`);
      if (s.indicators.length > 0) lines.push(`Indicators: ${s.indicators.join('; ')}`);
      if (s.nextSteps.length > 0) lines.push(`If confirmed: ${s.nextSteps.join('; ')}`);
    }
  }

  if (focusSignatureId) {
    const f = findings.find(x => x.signatureId === focusSignatureId);
    if (f) lines.push(`\n## Focus\n"${f.signatureName}" — ${f.evidence.join(', ')}`);
  }

  return lines.join('\n');
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'You are an expert JVM and AEM incident analyst. You will be given case signals and a signature library — detection rules that describe known failure patterns, their indicators, and recommended next steps. Use matched signatures as your primary diagnostic guide. For unmatched signatures, explain why they were likely ruled out based on the evidence. Format your response with: **Root Cause**, **Contributing Factors**, **Ruled Out**, **Recommended Next Steps**. Be specific and actionable.',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content.find(c => c.type === 'text')?.text ?? 'No response';
}

function buildHtml(caseId: string, context: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claude Review</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px;display:flex;flex-direction:column;gap:12px}
h2{font-size:13px;font-weight:600}
label{font-size:11px;color:var(--vscode-descriptionForeground);display:block;margin-bottom:3px}
textarea{width:100%;padding:6px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;resize:vertical}
textarea:focus{outline:1px solid var(--vscode-focusBorder)}
.result{padding:10px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:3px;font-size:12px;line-height:1.6;white-space:pre-wrap;min-height:40px}
.result.error{color:#f14c4c}
.spinner{display:none;font-size:11px;color:var(--vscode-descriptionForeground)}
.actions{display:flex;gap:8px}
.btn{padding:4px 12px;font-size:12px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
<h2>Claude Case Review &mdash; ${caseId}</h2>

<div>
  <label>Context sent to Claude (you can edit before sending)</label>
  <textarea id="prompt" rows="12">${escHtml(context)}</textarea>
</div>

<div class="actions">
  <button class="btn primary" id="run-btn" onclick="run()">Run Review</button>
  <button class="btn" onclick="cancel()">Cancel</button>
  <span class="spinner" id="spinner">Analysing...</span>
</div>

<div>
  <label>Response</label>
  <div class="result" id="result">Press "Run Review" to begin.</div>
</div>

<script>
const vscode = acquireVsCodeApi();

window.addEventListener('message', ({data:m}) => {
  document.getElementById('spinner').style.display='none';
  document.getElementById('run-btn').disabled=false;
  const el=document.getElementById('result');
  if(m.type==='result'){
    if(m.error){el.className='result error';el.textContent=m.error;}
    else{el.className='result';el.textContent=m.text;}
  }
});

function run(){
  const prompt=document.getElementById('prompt').value.trim();
  if(!prompt)return;
  document.getElementById('spinner').style.display='inline';
  document.getElementById('run-btn').disabled=true;
  document.getElementById('result').textContent='Waiting for response...';
  vscode.postMessage({type:'runReview',prompt});
}
function cancel(){vscode.postMessage({type:'cancel'});}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
