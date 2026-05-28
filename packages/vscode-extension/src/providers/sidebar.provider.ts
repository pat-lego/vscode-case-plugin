import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';

const CLOSED_CASES_LIMIT = 30;

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

class InfoItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'info';
    this.tooltip = label;
  }
}

class FilterableCasesProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  protected filter = '';

  constructor(protected caseManager: CaseManager, protected showResolved: boolean) {
    this.caseManager.onActiveChange(() => this.changeEmitter.fire(undefined));
    this.caseManager.onCaseUpdated(() => this.changeEmitter.fire(undefined));
  }

  setFilter(q: string) {
    this.filter = q.toLowerCase().trim();
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  getChildren(): vscode.TreeItem[] {
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

  getChildren(): vscode.TreeItem[] {
    const activeCaseId = this.caseManager.getActiveCaseId();
    const resolved = this.caseManager.getAllCases().filter(c => c.status === 'resolved');

    const matched = this.filter
      ? resolved.filter(c =>
          c.id.toLowerCase().includes(this.filter) ||
          c.title.toLowerCase().includes(this.filter))
      : resolved;

    const visible = this.filter ? matched : matched.slice(0, CLOSED_CASES_LIMIT);
    const items: vscode.TreeItem[] = visible.map(
      c => new CaseItem(c.id, `${c.id} — ${c.title}`, c.status, c.id === activeCaseId)
    );

    if (!this.filter && resolved.length > CLOSED_CASES_LIMIT) {
      items.push(new InfoItem(`${resolved.length - CLOSED_CASES_LIMIT} older case(s) hidden — use search to find them`));
    }

    return items;
  }
}

// Keep old SidebarProvider as a re-export alias so nothing else breaks
export class SidebarProvider extends OpenCasesProvider {}
