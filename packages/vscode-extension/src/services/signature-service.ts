import * as path from 'path';
import * as vscode from 'vscode';
import { Signature, loadSignaturesFromDir } from '@incident-investigator/core';

export class SignatureService {
  private cache: Signature[] = [];

  constructor(private context: vscode.ExtensionContext) {}

  getAll(): Signature[] {
    if (this.cache.length === 0) this.reload();
    return this.cache;
  }

  getById(id: string): Signature | undefined {
    return this.getAll().find(s => s.id === id);
  }

  reload(): Signature[] {
    const config = vscode.workspace.getConfiguration('investigator');
    const customPath = config.get<string>('signaturesPath');

    // Bundled signatures ship two levels above the extension package
    const bundledPath = path.join(this.context.extensionPath, '..', '..', 'signatures');
    const bundled = loadSignaturesFromDir(bundledPath);

    const custom = customPath ? loadSignaturesFromDir(customPath) : [];

    // Custom overrides bundled by ID
    const map = new Map<string, Signature>();
    for (const s of bundled) map.set(s.id, s);
    for (const s of custom) map.set(s.id, s);

    this.cache = Array.from(map.values());
    return this.cache;
  }

  saveSignature(sig: Signature): boolean {
    const config = vscode.workspace.getConfiguration('investigator');
    const savePath = config.get<string>('signaturesPath');
    if (!savePath) {
      vscode.window.showErrorMessage(
        'Set investigator.signaturesPath before saving signatures.',
        'Open Settings'
      ).then(a => {
        if (a === 'Open Settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'investigator.signaturesPath');
        }
      });
      return false;
    }

    const yaml = require('js-yaml') as typeof import('js-yaml');
    const fs = require('fs') as typeof import('fs');
    const filePath = path.join(savePath, `${sig.id}.yaml`);
    fs.writeFileSync(filePath, yaml.dump(sig), 'utf-8');
    this.reload();
    return true;
  }
}
