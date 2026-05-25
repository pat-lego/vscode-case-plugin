import * as vscode from 'vscode';
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

  const caseId = generateCaseId(initials);
  caseManager.createCase(caseId, title);
  webview.openCase(caseId);
}

function generateCaseId(initials: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Date.now()).slice(-3);
  return `CASE-${date}-${initials.toUpperCase()}-${seq}`;
}
