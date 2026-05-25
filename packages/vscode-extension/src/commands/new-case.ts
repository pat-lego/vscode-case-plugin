import * as vscode from 'vscode';
import * as path from 'path';
import { CaseManager } from '../services/case-manager';
import { InvestigationWebview } from '../providers/investigation.webview';

export async function newCase(
  context: vscode.ExtensionContext,
  caseManager: CaseManager,
  webview: InvestigationWebview
): Promise<void> {
  const config = vscode.workspace.getConfiguration('investigator');
  const initials = config.get<string>('engineerInitials') ?? 'XX';

  const title = await vscode.window.showInputBox({
    prompt: 'Investigation title',
    placeHolder: 'e.g. API degradation on search endpoint'
  });
  if (!title) return;

  // If multiple casePaths are configured, let the user pick which one.
  const casePaths = caseManager.getCasePaths();
  let targetCasePath: string | undefined;
  if (casePaths.length > 1) {
    const items = casePaths.map(p => ({ label: path.basename(p), description: p }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select destination folder for this case'
    });
    if (!pick) return;
    targetCasePath = pick.description;
  } else if (casePaths.length === 1) {
    targetCasePath = casePaths[0];
  }

  const caseId = generateCaseId(initials);
  caseManager.createCase(caseId, title, targetCasePath);
  webview.openCase(caseId);
}

function generateCaseId(initials: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Date.now()).slice(-3);
  return `CASE-${date}-${initials.toUpperCase()}-${seq}`;
}
