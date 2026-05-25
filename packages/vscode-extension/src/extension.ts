import * as vscode from 'vscode';
import { CaseManager } from './services/case-manager';
import { SignatureService } from './services/signature-service';
import { AnalysisService } from './services/analysis-service';
import { ExportService } from './services/export-service';
import { BridgeServer } from './services/bridge-server';
import { SidebarProvider, CaseItem } from './providers/sidebar.provider';
import { SignatureProvider } from './providers/signature.provider';
import { InvestigationWebview } from './providers/investigation.webview';
import { newCase } from './commands/new-case';
import { exportCase } from './commands/export-case';
import { SignatureBuilderPanel } from './panels/signature-builder.webview';
import { CaseResolutionPanel } from './panels/case-resolution.webview';
import { ClaudeReviewPanel } from './panels/claude-review.webview';

export function activate(context: vscode.ExtensionContext) {
  // Services
  const caseManager     = new CaseManager(context);
  const sigService      = new SignatureService(context);
  const analysisService = new AnalysisService(caseManager, sigService);
  const exportService   = new ExportService();
  const bridgeServer    = new BridgeServer(caseManager, analysisService);

  // Providers
  const sidebarProvider = new SidebarProvider(caseManager);
  const sigProvider     = new SignatureProvider(sigService);
  const webview         = new InvestigationWebview(
    context, caseManager, analysisService, exportService, bridgeServer
  );

  // Start bridge server (registered so it's stopped on extension deactivation)
  context.subscriptions.push(bridgeServer);
  const cfg = vscode.workspace.getConfiguration('investigator');
  bridgeServer.start(cfg.get<number>('bridgePort') ?? 7734);

  // Status bar bridge indicator
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(circle-outline) Bridge';
  statusItem.tooltip = 'Incident Investigator: browser extension bridge';
  statusItem.show();
  bridgeServer.onStatusChange(connected => {
    statusItem.text = connected ? '$(circle-filled) Bridge' : '$(circle-outline) Bridge';
    statusItem.color = connected ? new vscode.ThemeColor('charts.green') : undefined;
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
    vscode.window.registerTreeDataProvider('investigator.cases', sidebarProvider),
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
    vscode.commands.registerCommand('investigator.exportCase', () =>
      exportCase(caseManager, exportService)
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
      sidebarProvider.refresh();
    }),
    vscode.commands.registerCommand('investigator.openCaseInFinder', (item: CaseItem) => {
      const dir = caseManager.getCaseDir(item.caseId);
      if (dir) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
      } else {
        vscode.window.showInformationMessage('This case is not stored on disk.');
      }
    }),
    statusItem
  );
}

export function deactivate() {}
