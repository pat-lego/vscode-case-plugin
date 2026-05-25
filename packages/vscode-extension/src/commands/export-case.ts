import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';
import { ExportService } from '../services/export-service';

export async function exportCase(
  caseManager: CaseManager,
  exportService: ExportService
): Promise<void> {
  const session = caseManager.getActiveSession();
  if (!session) {
    vscode.window.showWarningMessage('No active investigation to export.');
    return;
  }
  const mdPath = await exportService.exportCase(session);
  if (mdPath) vscode.window.showInformationMessage(`Case exported: ${mdPath}`);
}
