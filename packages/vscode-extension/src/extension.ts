import * as vscode from 'vscode';
import { SidebarProvider } from './providers/sidebar.provider';
import { InvestigationWebview } from './providers/investigation.webview';
import { newCase } from './commands/new-case';
import { exportCase } from './commands/export-case';

export function activate(context: vscode.ExtensionContext) {
  const sidebarProvider = new SidebarProvider(context);
  const webviewProvider = new InvestigationWebview(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('investigator.cases', sidebarProvider),
    vscode.commands.registerCommand('investigator.newCase', () => newCase(context, webviewProvider)),
    vscode.commands.registerCommand('investigator.exportCase', () => exportCase(context)),
    vscode.commands.registerCommand('investigator.openCase', (caseId: string) =>
      webviewProvider.openCase(caseId)
    )
  );
}

export function deactivate() {}
