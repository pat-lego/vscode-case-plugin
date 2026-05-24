import * as vscode from 'vscode';
import { InvestigationWebview } from '../providers/investigation.webview';
import { SidebarProvider, CaseItem } from '../providers/sidebar.provider';

export async function newCase(
  context: vscode.ExtensionContext,
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

  context.globalState.update(`investigator.case.${caseId}`, {
    id: caseId,
    title,
    createdAt: new Date().toISOString(),
    status: 'open',
    evidence: []
  });

  const sidebar = new SidebarProvider(context);
  sidebar.addCase(new CaseItem(caseId, `${caseId} — ${title}`, 'open'));

  webview.openCase(caseId);
}

function generateCaseId(initials: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Date.now()).slice(-3);
  return `CASE-${date}-${initials.toUpperCase()}-${seq}`;
}
