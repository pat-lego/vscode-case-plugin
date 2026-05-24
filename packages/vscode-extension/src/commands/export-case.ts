import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export async function exportCase(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('investigator');
  const vaultPath = config.get<string>('obsidianVaultPath');

  if (!vaultPath) {
    const action = await vscode.window.showErrorMessage(
      'Obsidian vault path not configured.',
      'Open Settings'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'investigator.obsidianVaultPath');
    }
    return;
  }

  vscode.window.showInformationMessage('Export to Obsidian — coming in Phase 2');
}
