import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CaseManager } from '../services/case-manager';
import { InvestigationWebview } from '../providers/investigation.webview';

export async function newCase(
  _context: vscode.ExtensionContext,
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
  const initialNotes = resolveTemplate(config, caseId, title, initials);
  caseManager.createCase(caseId, title, targetCasePath, initialNotes);
  webview.openCase(caseId);
}

function resolveTemplate(
  config: vscode.WorkspaceConfiguration,
  caseId: string,
  title: string,
  initials: string
): string | undefined {
  const templatePath = config.get<string>('notesTemplatePath');
  if (!templatePath) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    vscode.window.showWarningMessage(`Notes template not found: ${templatePath}`);
    return undefined;
  }
  const date = new Date().toISOString().slice(0, 10);
  return raw
    .replace(/\{\{caseId\}\}/g, caseId)
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{initials\}\}/g, initials.toUpperCase());
}

function generateCaseId(initials: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Date.now()).slice(-3);
  return `CASE-${date}-${initials.toUpperCase()}-${seq}`;
}
