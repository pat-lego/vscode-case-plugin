import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { CaseManager, CaseSession } from './services/case-manager';
import { SignatureService } from './services/signature-service';
import { AnalysisService } from './services/analysis-service';
import { Signature } from '@incident-investigator/core';
import { BridgeServer } from './services/bridge-server';
import { OpenCasesProvider, ClosedCasesProvider, CaseItem } from './providers/sidebar.provider';
import { SignatureProvider, SignatureItem } from './providers/signature.provider';
import { InvestigationWebview } from './providers/investigation.webview';
import { newCase } from './commands/new-case';
import { SignatureBuilderPanel } from './panels/signature-builder.webview';
import { SignatureViewerPanel } from './panels/signature-viewer.webview';
import { ManualSignatureBuilderPanel } from './panels/manual-signature-builder.webview';
import { CaseResolutionPanel } from './panels/case-resolution.webview';
import { ClaudeReviewPanel } from './panels/claude-review.webview';
import { StaticAnalysisPanel } from './panels/static-analysis.webview';

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Incident Investigator');
  context.subscriptions.push(out);

  // Services
  const caseManager     = new CaseManager(context);
  const sigService      = new SignatureService(context);
  const analysisService = new AnalysisService(caseManager, sigService);
  const bridgeServer    = new BridgeServer(caseManager, analysisService, out);

  // Providers
  const openCasesProvider   = new OpenCasesProvider(caseManager);
  const closedCasesProvider = new ClosedCasesProvider(caseManager);
  const sigProvider         = new SignatureProvider(sigService);
  const webview             = new InvestigationWebview(
    context, caseManager, analysisService, bridgeServer
  );

  // Start bridge server (registered so it's stopped on extension deactivation)
  context.subscriptions.push(bridgeServer);
  const cfg = vscode.workspace.getConfiguration('investigator');
  bridgeServer.start(cfg.get<number>('bridgePort') ?? 7734);

  // Log startup state so we can diagnose active-case issues
  out.appendLine(`[init] sessions=${caseManager.getAllCases().length} activeCaseId=${caseManager.getActiveCaseId() ?? 'null'}`);

  // Status bar bridge indicator
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const updateStatusBar = () => {
    const connected = bridgeServer.isConnected();
    const caseId = caseManager.getActiveCaseId();
    statusItem.text = connected ? '$(circle-filled) Bridge' : '$(circle-outline) Bridge';
    statusItem.color = connected ? new vscode.ThemeColor('charts.green') : undefined;
    statusItem.tooltip = `Incident Investigator bridge\nActive case: ${caseId ?? 'none'}`;
  };
  updateStatusBar();
  statusItem.show();
  bridgeServer.onStatusChange(() => updateStatusBar());
  caseManager.onActiveChange(id => {
    out.appendLine(`[activeCase] → ${id ?? 'null'}`);
    updateStatusBar();
  });

  // Restart bridge if port config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('investigator.bridgePort')) {
        bridgeServer.stop();
        const port = vscode.workspace.getConfiguration('investigator').get<number>('bridgePort') ?? 7734;
        bridgeServer.start(port);
      }
    })
  );

  // Tree views
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('investigator.openCases', openCasesProvider),
    vscode.window.registerTreeDataProvider('investigator.closedCases', closedCasesProvider),
    vscode.window.registerTreeDataProvider('investigator.signatures', sigProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('investigator.newCase', () =>
      newCase(context, caseManager, webview)
    ),
    vscode.commands.registerCommand('investigator.openCase', (caseId: string) =>
      webview.openCase(caseId)
    ),
    vscode.commands.registerCommand('investigator.resolveCase', (caseId: string) =>
      CaseResolutionPanel.show(context, caseId, caseManager, sigService)
    ),
    vscode.commands.registerCommand('investigator.fullReview', (caseId: string) =>
      ClaudeReviewPanel.show(context, caseId, caseManager, sigService)
    ),
    vscode.commands.registerCommand('investigator.askClaude', (caseId: string, signatureId: string) =>
      ClaudeReviewPanel.showForSignature(context, caseId, signatureId, caseManager, sigService)
    ),
    vscode.commands.registerCommand('investigator.buildSignature', (caseId: string, finding: unknown) =>
      SignatureBuilderPanel.show(context, caseId, finding, caseManager, sigService)
    ),
    vscode.commands.registerCommand('investigator.viewSignature', (sigIdOrItem: string | SignatureItem) => {
      const sigId = typeof sigIdOrItem === 'string' ? sigIdOrItem : sigIdOrItem?.sigId ?? '';
      const sig = sigService.getById(sigId);
      if (!sig) { vscode.window.showWarningMessage(`Signature "${sigId}" not found.`); return; }
      SignatureViewerPanel.show(context, sig);
    }),
    vscode.commands.registerCommand('investigator.newSignature', () =>
      ManualSignatureBuilderPanel.show(context, sigService)
    ),
    vscode.commands.registerCommand('investigator.reloadSignatures', () => {
      sigService.reload();
      sigProvider.refresh();
      vscode.window.showInformationMessage('Signatures reloaded.');
    }),
    vscode.commands.registerCommand('investigator.deleteCase', async (item: CaseItem) => {
      const answer = await vscode.window.showWarningMessage(
        `Delete case "${item.caseId}"? This will permanently remove the case folder from disk.`,
        { modal: true },
        'Delete'
      );
      if (answer !== 'Delete') return;
      caseManager.deleteCase(item.caseId);
      openCasesProvider.refresh();
      closedCasesProvider.refresh();
    }),
    vscode.commands.registerCommand('investigator.openCaseInFinder', (item: CaseItem) => {
      const dir = caseManager.getCaseDir(item.caseId);
      if (dir) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
      } else {
        vscode.window.showInformationMessage('This case is not stored on disk.');
      }
    }),
    vscode.commands.registerCommand('investigator.reopenCase', (caseIdOrItem: string | CaseItem) => {
      const id = typeof caseIdOrItem === 'string' ? caseIdOrItem : caseIdOrItem.caseId;
      caseManager.reopenCase(id);
      openCasesProvider.refresh();
      closedCasesProvider.refresh();
    }),
    vscode.commands.registerCommand('investigator.filterOpenCases', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Filter open cases (ID or title)', value: openCasesProvider['filter'] ?? '' });
      if (q !== undefined) openCasesProvider.setFilter(q);
    }),
    vscode.commands.registerCommand('investigator.filterClosedCases', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Filter closed cases (ID or title)', value: closedCasesProvider['filter'] ?? '' });
      if (q !== undefined) closedCasesProvider.setFilter(q);
    }),
    vscode.commands.registerCommand('investigator.sendToAI', async (item?: CaseItem) => {
      const caseId = item?.caseId ?? caseManager.getActiveCaseId();
      if (!caseId) { vscode.window.showWarningMessage('No active case. Open an investigation first.'); return; }
      const session = caseManager.getSession(caseId);
      if (!session) return;

      const userQuestion = await vscode.window.showInputBox({
        prompt: 'Additional context or question for the AI (optional — press Enter to skip)',
        placeHolder: 'e.g. Focus on memory pressure patterns, or what is the most likely root cause?'
      });
      if (userQuestion === undefined) return; // user pressed Escape

      const signatures = sigService.getAll();
      const prompt = buildAiPrompt(session, userQuestion || undefined, signatures);
      const tmpFile = path.join(os.tmpdir(), `ii-${caseId}.md`);
      require('fs').writeFileSync(tmpFile, prompt, 'utf-8');

      const cliCmd = await pickAiCli();
      if (!cliCmd) return;

      const terminal = vscode.window.createTerminal(`AI Review — ${caseId}`);
      terminal.show();
      terminal.sendText(`${cliCmd} < "${tmpFile}"`);
    }),
    vscode.commands.registerCommand('investigator.suggestSignatureFromResolution', async (caseId: string, resolution: string) => {
      const session = caseManager.getSession(caseId);
      if (!session) return;
      const signatures = sigService.getAll();
      const prompt = buildSignatureSuggestionPrompt(session, resolution, signatures);
      const tmpFile = path.join(os.tmpdir(), `ii-sig-${caseId}.md`);
      require('fs').writeFileSync(tmpFile, prompt, 'utf-8');

      const cliCmd = await pickAiCli();
      if (!cliCmd) return;

      const terminal = vscode.window.createTerminal(`Signature Review — ${caseId}`);
      terminal.show();
      terminal.sendText(`${cliCmd} < "${tmpFile}"`);
    }),
    vscode.commands.registerCommand('investigator.runStaticAnalysis', () => {
      StaticAnalysisPanel.show(context, analysisService);
    }),
    vscode.commands.registerCommand('investigator.editSignature', (item: SignatureItem) => {
      const sig = sigService.getById(item.sigId);
      if (!sig) { vscode.window.showWarningMessage(`Signature "${item.sigId}" not found.`); return; }
      ManualSignatureBuilderPanel.show(context, sigService, sig);
    }),
    statusItem
  );
}

export function deactivate() {}

async function pickAiCli(): Promise<string | undefined> {
  const candidates = ['claude', 'llm', 'openai', 'codex'];
  const found = candidates.filter(cmd => {
    try { cp.execSync(process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`, { stdio: 'ignore' }); return true; }
    catch { return false; }
  });
  const choices: vscode.QuickPickItem[] = [
    ...found.map(c => ({ label: c, description: 'found on PATH' })),
    { label: '$(edit) Custom command…', description: '' }
  ];
  const pick = await vscode.window.showQuickPick(choices, { placeHolder: 'Select AI CLI' });
  if (!pick) return undefined;
  if (pick.label.startsWith('$(edit)')) {
    return vscode.window.showInputBox({ prompt: 'AI CLI command', value: 'claude' });
  }
  return pick.label;
}

function buildAiPrompt(session: CaseSession, userQuestion?: string, signatures?: Signature[]): string {
  const { meta, findings } = session;
  const lines: string[] = [
    `# Incident Review: ${meta.id} — ${meta.title}`,
    '',
    `**Status**: ${meta.status}  **Created**: ${meta.createdAt.toISOString().slice(0,10)}  **Updated**: ${meta.updatedAt.toISOString().slice(0,10)}`,
    '',
    '## Investigation Notes',
    meta.notes?.trim() || '_(no notes)_',
    '',
    `## Evidence (${meta.evidence.length} items)`,
    ...meta.evidence.map(e => `- [${e.type.toUpperCase()}] ${e.filePath ? path.basename(e.filePath) : e.id} — ${e.capturedAt.toISOString().slice(0,19)}`),
    '',
  ];

  const textEv = meta.evidence.filter(e => e.rawContent);
  if (textEv.length > 0) {
    lines.push('## Evidence Content');
    for (const e of textEv) {
      const name = e.filePath ? path.basename(e.filePath) : e.id;
      lines.push(`### ${name}`, '```', (e.rawContent ?? '').slice(0, 40000), '```', '');
    }
  }

  if (findings.length > 0) {
    lines.push('## Analysis Findings');
    for (const f of findings) {
      lines.push(`- **[${f.confidence.toUpperCase()}]** ${f.signatureName}`);
      if (f.evidence?.length) lines.push(`  Evidence: ${f.evidence.join('; ')}`);
    }
    lines.push('');
  }

  if (signatures && signatures.length > 0) {
    lines.push('## Known Signatures (for pattern matching)');
    lines.push('These signatures represent known incident patterns. Use them to identify matches in the evidence.');
    for (const sig of signatures) {
      lines.push(`### ${sig.id}: ${sig.name}`);
      if (sig.description) lines.push(sig.description);
      lines.push('');
    }
  }

  lines.push('---', '');

  if (userQuestion) {
    lines.push(`## Your Question`, userQuestion, '');
  }

  lines.push(
    'Please perform a comprehensive review of this incident:',
    '1. Identify the most likely root cause based on the evidence',
    '2. Assess severity and customer impact',
    '3. List immediate recommended actions',
    '4. Identify any missing evidence that would strengthen the investigation',
    '5. If any known signatures match the evidence, call them out explicitly',
    '6. Provide a concise executive summary (3-5 sentences)',
    ''
  );

  return lines.join('\n');
}

function buildSignatureSuggestionPrompt(session: CaseSession, resolution: string, signatures: Signature[]): string {
  const { meta, findings } = session;
  const lines: string[] = [
    `# Signature Suggestion Review: ${meta.id} — ${meta.title}`,
    '',
    `**Status**: resolved  **Resolved by**: ${meta.resolvedBy ?? 'unknown'}`,
    '',
    '## Resolution Summary',
    resolution,
    '',
    '## Investigation Notes',
    meta.notes?.trim() || '_(no notes)_',
    '',
    `## Evidence (${meta.evidence.length} items)`,
    ...meta.evidence.map(e => `- [${e.type.toUpperCase()}] ${e.filePath ? path.basename(e.filePath) : e.id} — ${e.capturedAt.toISOString().slice(0,19)}`),
    '',
  ];

  const textEv = meta.evidence.filter(e => e.rawContent);
  if (textEv.length > 0) {
    lines.push('## Key Evidence Content');
    for (const e of textEv.slice(0, 5)) { // cap at 5 to keep prompt size reasonable
      const name = e.filePath ? path.basename(e.filePath) : e.id;
      lines.push(`### ${name}`, '```', (e.rawContent ?? '').slice(0, 20000), '```', '');
    }
  }

  if (findings.length > 0) {
    lines.push('## Analysis Findings');
    for (const f of findings) {
      lines.push(`- **[${f.confidence.toUpperCase()}]** ${f.signatureName}`);
    }
    lines.push('');
  }

  if (signatures.length > 0) {
    lines.push('## Existing Signatures (do not duplicate these)');
    for (const sig of signatures) {
      lines.push(`- **${sig.id}**: ${sig.name}`);
      if (sig.description) lines.push(`  ${sig.description}`);
    }
    lines.push('');
  }

  lines.push(
    '---',
    '',
    'Based on the evidence and resolution above, please:',
    '1. Assess whether this incident represents a NEW reusable pattern not covered by the existing signatures',
    '2. If yes, propose a new signature in YAML format with the following structure:',
    '```yaml',
    'id: <short-kebab-case-id>',
    'name: <human-readable name>',
    'description: <what this pattern indicates>',
    'conditions:',
    '  - type: <thread-state|stack-frame|thread-name-pattern|blocked-ratio|thread-count>',
    '    value: <pattern or threshold>',
    'confidence: <high|medium|low>',
    '```',
    '3. If no new signature is warranted, explain why',
    '4. Keep the signature focused on observable signals (stack frames, thread states, counts) — not on business context',
    ''
  );

  return lines.join('\n');
}
