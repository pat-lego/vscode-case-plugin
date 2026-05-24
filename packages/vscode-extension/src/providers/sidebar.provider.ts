import * as vscode from 'vscode';

export class CaseItem extends vscode.TreeItem {
  constructor(
    public readonly caseId: string,
    public readonly label: string,
    public readonly status: 'open' | 'resolved'
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = caseId;
    this.description = status;
    this.command = {
      command: 'investigator.openCase',
      title: 'Open Case',
      arguments: [caseId]
    };
    this.iconPath = new vscode.ThemeIcon(status === 'open' ? 'circle-filled' : 'check');
  }
}

export class SidebarProvider implements vscode.TreeDataProvider<CaseItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CaseItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private cases: CaseItem[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.cases = this.context.globalState.get<CaseItem[]>('investigator.cases', []);
  }

  getTreeItem(element: CaseItem): vscode.TreeItem {
    return element;
  }

  getChildren(): CaseItem[] {
    return this.cases;
  }

  addCase(item: CaseItem) {
    this.cases.unshift(item);
    this.context.globalState.update('investigator.cases', this.cases);
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }
}
