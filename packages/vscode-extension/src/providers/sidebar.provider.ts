import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';

export class CaseItem extends vscode.TreeItem {
  constructor(
    public readonly caseId: string,
    label: string,
    status: 'open' | 'resolved',
    isActive = false
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = caseId;
    this.description = isActive ? 'active' : (status === 'resolved' ? 'resolved' : '');
    this.command = { command: 'investigator.openCase', title: 'Open', arguments: [caseId] };
    this.iconPath = new vscode.ThemeIcon(isActive ? 'circle-large-filled' : status === 'open' ? 'circle-outline' : 'check');
    this.contextValue = 'case';
  }
}

class FilterableCasesProvider implements vscode.TreeDataProvider<CaseItem> {
  private changeEmitter = new vscode.EventEmitter<CaseItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  protected filter = '';

  constructor(protected caseManager: CaseManager, protected showResolved: boolean) {
    this.caseManager.onActiveChange(() => this.changeEmitter.fire(undefined));
  }

  setFilter(q: string) {
    this.filter = q.toLowerCase().trim();
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: CaseItem): vscode.TreeItem { return element; }

  getChildren(): CaseItem[] {
    const activeCaseId = this.caseManager.getActiveCaseId();
    return this.caseManager.getAllCases()
      .filter(c => this.showResolved ? c.status === 'resolved' : c.status !== 'resolved')
      .filter(c => !this.filter ||
        c.id.toLowerCase().includes(this.filter) ||
        c.title.toLowerCase().includes(this.filter))
      .map(c => new CaseItem(c.id, `${c.id} — ${c.title}`, c.status, c.id === activeCaseId));
  }

  refresh() { this.changeEmitter.fire(undefined); }
}

export class OpenCasesProvider extends FilterableCasesProvider {
  constructor(caseManager: CaseManager) { super(caseManager, false); }
}

export class ClosedCasesProvider extends FilterableCasesProvider {
  constructor(caseManager: CaseManager) { super(caseManager, true); }
}

// Keep old SidebarProvider as a re-export alias so nothing else breaks
export class SidebarProvider extends OpenCasesProvider {}
