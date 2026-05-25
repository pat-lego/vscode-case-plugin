import * as vscode from 'vscode';
import { Signature } from '@incident-investigator/core';
import { SignatureService } from '../services/signature-service';

export class SignatureItem extends vscode.TreeItem {
  readonly sigId: string;

  constructor(sig: Signature) {
    super(sig.name, vscode.TreeItemCollapsibleState.None);
    this.sigId = sig.id;
    this.tooltip = sig.description;
    this.description = `v${sig.version}`;
    this.iconPath = new vscode.ThemeIcon('symbol-event');
    this.contextValue = 'signature';
    this.command = {
      command: 'investigator.viewSignature',
      title: 'View',
      arguments: [sig.id],
    };
  }
}

export class SignatureProvider implements vscode.TreeDataProvider<SignatureItem> {
  private changeEmitter = new vscode.EventEmitter<SignatureItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private sigService: SignatureService) {}

  getTreeItem(element: SignatureItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SignatureItem[] {
    return this.sigService.getAll().map(s => new SignatureItem(s));
  }

  refresh() {
    this.changeEmitter.fire(undefined);
  }
}
