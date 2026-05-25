import * as vscode from 'vscode';
import { CaseManager } from '../services/case-manager';

export class CaseItem extends vscode.TreeItem {
  constructor(
    public readonly caseId: string,
    label: string,
    status: 'open' | 'resolved'
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = caseId;
    this.description = status;
    this.command = { command: 'investigator.openCase', title: 'Open', arguments: [caseId] };
    this.iconPath = new vscode.ThemeIcon(status === 'open' ? 'circle-filled' : 'check');
    this.contextValue = 'case';
  }
}

export class SidebarProvider implements vscode.TreeDataProvider<CaseItem> {
  private changeEmitter = new vscode.EventEmitter<CaseItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private caseManager: CaseManager) {
    this.caseManager.onActiveChange(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(element: CaseItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CaseItem[] {
    return this.caseManager.getAllCases().map(c =>
      new CaseItem(c.id, `${c.id} — ${c.title}`, c.status)
    );
  }

  refresh() {
    this.changeEmitter.fire(undefined);
  }
}
