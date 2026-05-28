import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CaseManager } from '../services/case-manager';
import { AnalysisService } from '../services/analysis-service';
import { BridgeServer } from '../services/bridge-server';

export class InvestigationWebview {
  private panels = new Map<string, vscode.WebviewPanel>();
  private knownEvidenceIds = new Map<string, Set<string>>();

  constructor(
    private context: vscode.ExtensionContext,
    private caseManager: CaseManager,
    private analysisService: AnalysisService,
    private bridgeServer: BridgeServer
  ) {
    this.caseManager.onFindingsChange(({ caseId, findings }) => {
      this.panels.get(caseId)?.webview.postMessage({ type: 'findings', findings });
    });

    // Push external case state changes (e.g. reopen from sidebar, notes heading change) to open panels.
    // Detect evidence added from outside this panel (e.g. static analysis) and push evidenceAdded.
    // The diff is deferred via setImmediate so that any pushEvidenceAdded() call on the same
    // synchronous tick (which fires before onCaseUpdated returns, because vscode.EventEmitter is
    // synchronous) has already registered its ID — preventing double delivery.
    this.caseManager.onCaseUpdated(updatedCaseId => {
      const panel = this.panels.get(updatedCaseId);
      if (!panel) return;
      const session = this.caseManager.getSession(updatedCaseId);
      if (!session) return;
      panel.webview.postMessage({ type: 'caseUpdated', status: session.meta.status, title: session.meta.title });

      setImmediate(() => {
        const known = this.knownEvidenceIds.get(updatedCaseId);
        if (!known) return;
        const current = this.caseManager.getSession(updatedCaseId);
        if (!current) return;
        for (const e of current.meta.evidence) {
          if (known.has(e.id)) continue;
          this.pushEvidenceAdded(updatedCaseId, {
            id: e.id,
            name: e.displayName ?? (e.filePath ? path.basename(e.filePath) : e.id),
            type: e.type,
            timestamp: e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime())
              ? e.capturedAt.toISOString()
              : new Date().toISOString(),
            group: e.group
          });
        }
      });
    });

    this.bridgeServer.onStatusChange(connected => {
      for (const panel of this.panels.values()) {
        panel.webview.postMessage({ type: 'bridgeStatus', connected });
      }
    });

    this.bridgeServer.onCapture(({ caseId, name }) => {
      const session = this.caseManager.getSession(caseId);
      const evArr = session?.meta.evidence ?? [];
      const ev = evArr[evArr.length - 1];
      if (ev) {
        this.pushEvidenceAdded(caseId, { id: ev.id, name, type: ev.type, timestamp: ev.capturedAt.toISOString() });
      }
    });
  }

  openCase(caseId: string) {
    const existing = this.panels.get(caseId);
    if (existing) {
      this.caseManager.setActiveCase(caseId);
      existing.reveal(vscode.ViewColumn.One);
      return;
    }

    const session = this.caseManager.getSession(caseId);
    if (!session) return;

    const panel = vscode.window.createWebviewPanel(
      'investigator.case',
      session.meta.id,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = this.buildHtml(session.meta.id, session.meta.title);
    this.panels.set(caseId, panel);
    this.caseManager.setActiveCase(caseId);

    panel.webview.onDidReceiveMessage(msg => this.handleMessage(caseId, msg));
    panel.onDidDispose(() => { this.panels.delete(caseId); this.knownEvidenceIds.delete(caseId); });
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) this.caseManager.setActiveCase(caseId);
    });
  }

  private pushEvidenceAdded(caseId: string, item: { id: string; [key: string]: unknown }) {
    this.knownEvidenceIds.get(caseId)?.add(item.id);
    this.panels.get(caseId)?.webview.postMessage({ type: 'evidenceAdded', item });
  }

  private async handleMessage(caseId: string, msg: Record<string, unknown>) {
    const panel = this.panels.get(caseId);
    if (!panel) return;

    switch (String(msg.type)) {
      case 'ready': {
        this.caseManager.refreshDiskEvidence(caseId);
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        this.knownEvidenceIds.set(caseId, new Set(session.meta.evidence.map(e => e.id)));
        panel.webview.postMessage({ type: 'bridgeStatus', connected: this.bridgeServer.isConnected() });
        panel.webview.postMessage({
          type: 'initialState',
          status: session.meta.status,
          evidence: session.meta.evidence.map(e => ({
            id: e.id,
            name: e.displayName ?? (e.filePath ? path.basename(e.filePath) : e.id),
            type: e.type,
            timestamp: e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime())
              ? e.capturedAt.toISOString()
              : new Date().toISOString(),
            group: e.group
          })),
          findings: session.findings,
          notes: session.meta.notes ?? ''
        });
        break;
      }

      case 'addEvidence': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Add to Investigation',
          filters: {
            'All Supported': ['txt','log','tdump','jfr','png','jpg','jpeg','gif','webp','pdf','pptx','ppt','xlsx','xls','docx','doc','zip','tar','gz','7z','json','xml','csv','md','yaml','yml'],
            'Thread Dumps & Logs': ['txt','log','tdump','jfr'],
            'Images': ['png','jpg','jpeg','gif','webp'],
            'Documents': ['pdf','pptx','ppt','xlsx','xls','docx','doc'],
            'Archives': ['zip','tar','gz','7z'],
            'All Files': ['*']
          }
        });
        if (!uris?.length) return;
        const caseDir = this.caseManager.getCaseDir(caseId);

        // Separate folders from files; group files sharing the same parent dir
        const filesByDir = new Map<string, string[]>();
        const folderPaths: string[] = [];
        for (const uri of uris) {
          let stat: import('fs').Stats;
          try { stat = fs.statSync(uri.fsPath); } catch { continue; }
          if (stat.isDirectory()) {
            folderPaths.push(uri.fsPath);
          } else {
            const dir = path.dirname(uri.fsPath);
            if (!filesByDir.has(dir)) filesByDir.set(dir, []);
            filesByDir.get(dir)!.push(uri.fsPath);
          }
        }

        for (const [dir, filePaths] of filesByDir) {
          const group = filePaths.length >= 2 ? path.basename(dir) : undefined;
          for (const filePath of filePaths) {
            const added = this.addFileEvidence(caseId, filePath, caseDir, group);
            if (added) this.pushEvidenceAdded(caseId, added.item);
            if (added?.findings?.length) panel.webview.postMessage({ type: 'findings', findings: added.findings });
          }
        }

        for (const folderPath of folderPaths) {
          this.addFolderEvidence(caseId, folderPath, caseDir, panel);
        }
        break;
      }

      case 'exportJira': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const rawNotes = String(msg.notes ?? session.meta.notes ?? '');
        const caseDir = this.caseManager.getCaseDir(caseId);
        const newEvidence: Array<{id: string; name: string; type: string; timestamp: string}> = [];
        let snippetIdx = 1;

        const JIRA_MAX = 32767;
        const INLINE_CHAR_LIMIT = 5000;

        // Collect all fenced code blocks in document order.
        const blocks: Array<{ full: string; inner: string }> = [];
        rawNotes.replace(/```[\s\S]*?```/g, (match) => {
          const inner = match.slice(3, -3).replace(/^[^\n]*\n/, '').trim();
          blocks.push({ full: match, inner });
          return match;
        });

        // Blocks over the character limit are always extracted to files.
        const toExtract = new Set<number>(
          blocks.flatMap((b, i) => b.inner.length > INLINE_CHAR_LIMIT ? [i] : [])
        );

        // Check if keeping small blocks inline would blow the JIRA character limit.
        // Build a draft replacing only large blocks with a short placeholder.
        let draftIdx = -1;
        const draft = rawNotes.replace(/```[\s\S]*?```/g, () => {
          draftIdx++;
          return toExtract.has(draftIdx) ? '[snippet.txt](./snippet.txt)' : blocks[draftIdx].full;
        });
        if (convertToJiraMarkup(draft).length >= JIRA_MAX) {
          // Small blocks also need extraction to stay under the limit.
          for (let i = 0; i < blocks.length; i++) toExtract.add(i);
        }

        // Assign filenames to extracted blocks and save them as evidence files.
        const fileNames = new Map<number, string>();
        for (const i of toExtract) {
          const fileName = `snippet-${snippetIdx++}.txt`;
          fileNames.set(i, fileName);
          if (caseDir) {
            try {
              fs.mkdirSync(caseDir, { recursive: true });
              const filePath = path.join(caseDir, fileName);
              // Skip if this file is already tracked as evidence — avoids duplicates on re-export.
              const session2 = this.caseManager.getSession(caseId);
              const alreadyTracked = session2?.meta.evidence.some(e => e.filePath === filePath);
              if (!alreadyTracked) {
                fs.writeFileSync(filePath, blocks[i].inner, 'utf-8');
                const item: import('@incident-investigator/core').EvidenceItem = {
                  id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  type: 'generic',
                  source: fileName,
                  capturedAt: new Date(),
                  filePath,
                };
                this.caseManager.addEvidence(caseId, item);
                newEvidence.push({ id: item.id, name: fileName, type: 'generic', timestamp: item.capturedAt.toISOString() });
              }
            } catch { /* best-effort */ }
          }
        }

        // Build processed notes: replace extracted blocks with file refs, leave the rest inline.
        let blockIdx = -1;
        const processedNotes = rawNotes.replace(/```[\s\S]*?```/g, () => {
          blockIdx++;
          const fileName = fileNames.get(blockIdx);
          return fileName ? `[${fileName}](./${fileName})` : blocks[blockIdx].full;
        });

        if (newEvidence.length > 0) {
          this.caseManager.updateNotes(caseId, processedNotes);
        }

        const exportText = buildJiraExport(session, processedNotes);
        panel.webview.postMessage({
          type: 'jiraExport',
          text: exportText,
          newNotes: newEvidence.length > 0 ? processedNotes : undefined,
          newEvidence,
        });
        break;
      }

      case 'deleteGroup': {
        const group = String(msg.group);
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const ids = session.meta.evidence.filter(e => e.group === group).map(e => e.id);
        for (const id of ids) { this.caseManager.removeEvidence(caseId, id); }
        const s2 = this.caseManager.getSession(caseId);
        if (s2) {
          const findings = this.analysisService.rerun([...s2.threadDumpSignals.values()]);
          this.caseManager.updateFindings(caseId, findings);
        }
        panel.webview.postMessage({ type: 'groupRemoved', group });
        break;
      }

      case 'viewEvidence': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const ev = session.meta.evidence.find(e => e.id === String(msg.id));
        if (!ev) return;
        const paneId = String(msg.paneId ?? '');
        const isImage = ev.type === 'screenshot' || /\.(png|jpg|jpeg|gif|webp)$/i.test(ev.filePath);
        const name = ev.filePath ? path.basename(ev.filePath) : ev.id;
        let content: string | null = null;
        let contentType = 'text';
        if (isImage) {
          if (ev.rawContent?.startsWith('data:')) {
            content = ev.rawContent;
            contentType = 'image';
          } else if (ev.filePath) {
            try {
              const data = fs.readFileSync(ev.filePath);
              const ext = path.extname(ev.filePath).slice(1).toLowerCase();
              const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : `image/${ext}`;
              content = `data:${mime};base64,${data.toString('base64')}`;
              contentType = 'image';
            } catch { content = null; }
          }
        } else {
          const BINARY_EXTS = new Set(['.pdf','.pptx','.ppt','.xlsx','.xls','.docx','.doc','.zip','.tar','.gz','.7z']);
          const fileExt = path.extname(ev.filePath ?? '').toLowerCase();
          if (BINARY_EXTS.has(fileExt)) {
            content = `${fileExt.slice(1).toUpperCase()} file — click "Open ↗" to view in your default application.`;
            contentType = 'text';
          } else {
            let text: string | undefined = ev.rawContent;
            if (!text && ev.filePath) {
              try { text = fs.readFileSync(ev.filePath, 'utf-8'); } catch { text = undefined; }
            }
            content = text ?? null;
          }
        }
        panel.webview.postMessage({ type: 'evidenceView', id: ev.id, name, paneId, content, contentType });
        break;
      }

      case 'openEvidence': {
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        const ev = session.meta.evidence.find(e => e.id === String(msg.id));
        if (!ev?.filePath) return;
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(ev.filePath));
        break;
      }

      case 'deleteEvidence': {
        const removed = this.caseManager.removeEvidence(caseId, String(msg.id));
        if (!removed) return;
        const session = this.caseManager.getSession(caseId);
        if (session) {
          const findings = this.analysisService.rerun([...session.threadDumpSignals.values()]);
          this.caseManager.updateFindings(caseId, findings);
        }
        panel.webview.postMessage({ type: 'evidenceRemoved', id: msg.id });
        break;
      }

      case 'saveNotes':
        this.caseManager.updateNotes(caseId, String(msg.notes ?? ''));
        break;

      case 'saveTitle':
        this.caseManager.updateTitle(caseId, String(msg.title ?? ''));
        break;

      case 'reopenCase':
        this.caseManager.reopenCase(caseId);
        panel.webview.postMessage({ type: 'statusChanged', status: 'open' });
        break;

      case 'resolveCase':
        vscode.commands.executeCommand('investigator.resolveCase', caseId);
        break;

      case 'fullReview':
        vscode.commands.executeCommand('investigator.fullReview', caseId);
        break;

      case 'askClaude':
        vscode.commands.executeCommand('investigator.askClaude', caseId, msg.signatureId);
        break;

      case 'openSignatureBuilder':
        vscode.commands.executeCommand('investigator.buildSignature', caseId, msg.finding);
        break;

      case 'reviewEvidenceWithAI':
        vscode.commands.executeCommand('investigator.reviewEvidenceWithAI', caseId, String(msg.id ?? ''));
        break;

      case 'renameEvidence': {
        const session = this.caseManager.getSession(caseId);
        if (!session || !session.casePath) break;
        const evId = String(msg.id ?? '');
        const ev = session.meta.evidence.find(e => e.id === evId);
        if (!ev) break;
        const oldBasename = ev.filePath ? path.basename(ev.filePath) : ev.source;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename file on disk',
          value: oldBasename,
          ignoreFocusOut: true,
          validateInput: v => {
            if (!v.trim()) return 'Name cannot be empty';
            if (/[/\\]/.test(v)) return 'Name cannot contain path separators';
            return null;
          }
        });
        if (!newName || newName.trim() === oldBasename) break;
        const trimmed = newName.trim();
        const caseDir = path.join(session.casePath, caseId);
        let newFilePath: string;
        const fileInCaseDir = !!(ev.filePath && ev.filePath.startsWith(caseDir + path.sep));
        if (fileInCaseDir && fs.existsSync(ev.filePath!)) {
          newFilePath = path.join(path.dirname(ev.filePath!), trimmed);
          try { fs.renameSync(ev.filePath!, newFilePath); }
          catch (err) { vscode.window.showErrorMessage(`Failed to rename: ${err}`); break; }
        } else if (ev.rawContent) {
          newFilePath = path.join(caseDir, trimmed);
          try {
            fs.mkdirSync(caseDir, { recursive: true });
            fs.writeFileSync(newFilePath, ev.rawContent, 'utf-8');
          } catch (err) { vscode.window.showErrorMessage(`Failed to write renamed file: ${err}`); break; }
        } else if (ev.filePath && fs.existsSync(ev.filePath)) {
          newFilePath = path.join(caseDir, trimmed);
          try {
            fs.mkdirSync(caseDir, { recursive: true });
            fs.copyFileSync(ev.filePath, newFilePath);
          } catch (err) { vscode.window.showErrorMessage(`Failed to copy for rename: ${err}`); break; }
        } else {
          vscode.window.showErrorMessage('Cannot rename: file not found on disk.');
          break;
        }
        this.caseManager.updateEvidenceFilePath(caseId, evId, newFilePath);
        panel.webview.postMessage({ type: 'evidenceRenamed', id: evId, name: trimmed });

        // Update note links: replace both label and href for the old filename
        const notes = session.meta.notes ?? '';
        if (notes && oldBasename) {
          const escaped = oldBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const linkRe = new RegExp('\\[([^\\]]*)\\]\\((\\.{1,2}\\/(?:[^/)]*/)*)' + escaped + '\\)', 'g');
          const updated = notes.replace(linkRe, (_m: string, _label: string, prefix: string) => `[${trimmed}](${prefix}${trimmed})`);
          if (updated !== notes) {
            this.caseManager.updateNotes(caseId, updated);
            panel.webview.postMessage({ type: 'notesUpdated', notes: updated });
          }
        }
        break;
      }

      case 'dropEvidence': {
        const caseDir = this.caseManager.getCaseDir(caseId);
        let dropPath: string | undefined;
        if (msg.filePath) {
          dropPath = String(msg.filePath);
        } else if (msg.uri) {
          try { dropPath = vscode.Uri.parse(String(msg.uri)).fsPath; } catch { /* invalid URI */ }
        }
        if (!dropPath) return;
        try { fs.statSync(dropPath); } catch {
          vscode.window.showErrorMessage(`Cannot access dropped file: ${path.basename(dropPath)}`);
          return;
        }
        const dropStat = fs.statSync(dropPath);
        if (dropStat.isDirectory()) {
          this.addFolderEvidence(caseId, dropPath, caseDir, panel);
        } else {
          const added = this.addFileEvidence(caseId, dropPath, caseDir);
          if (added) {
            this.pushEvidenceAdded(caseId, added.item);
            if (added.findings?.length) panel.webview.postMessage({ type: 'findings', findings: added.findings });
          }
        }
        break;
      }

      case 'loadInlineFile': {
        const session = this.caseManager.getSession(caseId);
        if (!session || !session.casePath) break;
        const caseDir = path.join(session.casePath, caseId);
        const fileSrc = String(msg.src ?? '');
        const relPath = fileSrc.startsWith('./') ? fileSrc.slice(2) : fileSrc;
        const absPath = path.isAbsolute(relPath) ? relPath : path.join(caseDir, relPath);

        const BINARY_INLINE_EXTS = new Set([
          '.zip','.tar','.gz','.bz2','.7z','.rar',
          '.pdf','.pptx','.ppt','.xlsx','.xls','.docx','.doc',
          '.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp','.ico',
          '.exe','.dmg','.pkg','.jar','.class','.pyc','.so','.dylib','.dll',
        ]);

        let content: string | undefined;
        // Try the path resolved relative to the case directory
        try { content = fs.readFileSync(absPath, 'utf-8'); } catch { /* not found */ }
        // Fall back: find a matching evidence item by basename
        if (content === undefined) {
          const baseName = path.basename(relPath);
          const ev = session.meta.evidence.find(e =>
            (e.filePath && path.basename(e.filePath) === baseName) || e.source === baseName
          );
          if (ev?.rawContent) {
            content = ev.rawContent;
          } else if (ev?.filePath) {
            const evExt = path.extname(ev.filePath).toLowerCase();
            if (!BINARY_INLINE_EXTS.has(evExt)) {
              try { content = fs.readFileSync(ev.filePath, 'utf-8'); } catch { /* not found */ }
            }
          }
        }
        if (content !== undefined) {
          panel.webview.postMessage({ type: 'inlineFileLoaded', src: fileSrc, content });
        }
        break;
      }

      case 'loadPreviewImage': {
        const session = this.caseManager.getSession(caseId);
        if (!session || !session.casePath) break;
        const caseDir = path.join(session.casePath, caseId);
        const imgSrc = String(msg.src ?? '');
        const relPath = imgSrc.startsWith('./') ? imgSrc.slice(2) : imgSrc;
        const absPath = path.isAbsolute(relPath) ? relPath : path.join(caseDir, relPath);
        try {
          const data = fs.readFileSync(absPath);
          const ext = path.extname(absPath).toLowerCase().slice(1);
          const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : `image/${ext}`;
          panel.webview.postMessage({ type: 'previewImageLoaded', src: imgSrc, dataUri: `data:${mime};base64,${data.toString('base64')}` });
        } catch { /* image not found — img stays blank */ }
        break;
      }
    }
  }

  private addFileEvidence(caseId: string, filePath: string, caseDir: string | undefined, group?: string): { item: { id: string; name: string; type: string; timestamp: string; group?: string }; findings?: unknown[] } | null {
    const TEXT_EXTS = new Set(['.txt','.log','.tdump','.jfr','.md','.json','.xml','.csv','.yaml','.yml']);
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);

    if (TEXT_EXTS.has(ext)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { evidenceItem, findings } = this.analysisService.processEvidence(caseId, name, content, filePath);
        if (group) this.caseManager.setEvidenceGroup(caseId, evidenceItem.id, group);
        return {
          item: { id: evidenceItem.id, name, type: evidenceItem.type, timestamp: evidenceItem.capturedAt.toISOString(), group },
          findings
        };
      } catch { return null; }
    }

    // Binary file — copy to case dir if available
    let destPath = filePath;
    if (caseDir) {
      try {
        fs.mkdirSync(caseDir, { recursive: true });
        destPath = path.join(caseDir, name);
        if (destPath !== filePath) fs.copyFileSync(filePath, destPath);
      } catch { destPath = filePath; }
    }

    const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp']);
    const type = IMAGE_EXTS.has(ext) ? 'screenshot' : 'generic';
    const item = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      type,
      source: 'local-file' as const,
      capturedAt: new Date(),
      filePath: destPath,
      ...(group ? { group } : {}),
    };
    this.caseManager.addEvidence(caseId, item as import('@incident-investigator/core').EvidenceItem);
    return { item: { id: item.id, name, type, timestamp: item.capturedAt.toISOString(), group } };
  }

  private addFolderEvidence(caseId: string, folderPath: string, caseDir: string | undefined, panel?: vscode.WebviewPanel) {
    const folderName = path.basename(folderPath);
    const walk = (dir: string, relDir: string) => {
      let entries: import('fs').Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const srcPath = path.join(dir, entry.name);
        const relPath = path.join(relDir, entry.name);
        if (entry.isDirectory()) {
          if (caseDir) {
            try { fs.mkdirSync(path.join(caseDir, relPath), { recursive: true }); } catch {}
          }
          walk(srcPath, relPath);
        } else {
          let destPath = srcPath;
          if (caseDir) {
            destPath = path.join(caseDir, relPath);
            try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); fs.copyFileSync(srcPath, destPath); } catch { destPath = srcPath; }
          }
          const displayName = relPath; // preserve structure in the name
          const TEXT_EXTS = new Set(['.txt','.log','.tdump','.jfr','.md','.json','.xml','.csv','.yaml','.yml']);
          const ext = path.extname(entry.name).toLowerCase();
          if (TEXT_EXTS.has(ext)) {
            try {
              const content = fs.readFileSync(srcPath, 'utf-8');
              const { evidenceItem, findings } = this.analysisService.processEvidence(caseId, entry.name, content, destPath);
              this.caseManager.setEvidenceGroup(caseId, evidenceItem.id, folderName);
              this.pushEvidenceAdded(caseId, { id: evidenceItem.id, name: displayName, type: evidenceItem.type, timestamp: evidenceItem.capturedAt.toISOString(), group: folderName });
              if (findings.length) panel?.webview.postMessage({ type: 'findings', findings });
            } catch {}
          } else {
            const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp']);
            const evType = IMAGE_EXTS.has(ext) ? 'screenshot' : 'generic';
            const item = {
              id: `ev-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              type: evType,
              source: 'local-file' as const,
              capturedAt: new Date(),
              filePath: destPath,
              group: folderName,
            };
            this.caseManager.addEvidence(caseId, item as import('@incident-investigator/core').EvidenceItem);
            this.pushEvidenceAdded(caseId, { id: item.id, name: displayName, type: evType, timestamp: item.capturedAt.toISOString(), group: folderName });
          }
        }
      }
    };
    if (caseDir) {
      try { fs.mkdirSync(path.join(caseDir, folderName), { recursive: true }); } catch {}
    }
    walk(folderPath, folderName);
  }

  /**
   * Adds one or more file/folder URIs to an existing case as evidence.
   * If the case panel is already open the webview is updated live; otherwise
   * the evidence is persisted and will appear in initialState when the panel opens.
   * Returns the number of top-level items processed.
   */
  async addUrisToCase(caseId: string, uris: vscode.Uri[]): Promise<number> {
    const panel = this.panels.get(caseId);
    const caseDir = this.caseManager.getCaseDir(caseId);

    const filesByDir = new Map<string, string[]>();
    const folderPaths: string[] = [];
    for (const uri of uris) {
      let stat: import('fs').Stats;
      try { stat = fs.statSync(uri.fsPath); } catch { continue; }
      if (stat.isDirectory()) {
        folderPaths.push(uri.fsPath);
      } else {
        const dir = path.dirname(uri.fsPath);
        if (!filesByDir.has(dir)) filesByDir.set(dir, []);
        filesByDir.get(dir)!.push(uri.fsPath);
      }
    }

    let added = 0;
    for (const [, filePaths] of filesByDir) {
      const group = filePaths.length >= 2 ? path.basename(path.dirname(filePaths[0])) : undefined;
      for (const filePath of filePaths) {
        const result = this.addFileEvidence(caseId, filePath, caseDir, group);
        if (result) {
          added++;
          this.pushEvidenceAdded(caseId, result.item);
          if (result.findings?.length) panel?.webview.postMessage({ type: 'findings', findings: result.findings });
        }
      }
    }

    for (const folderPath of folderPaths) {
      this.addFolderEvidence(caseId, folderPath, caseDir, panel);
      added++;
    }

    return added;
  }

  private buildHtml(caseId: string, title: string): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'nonce-${nonce}';">
<title>${caseId}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0;gap:8px}
.header h2{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.header-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.bridge{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--vscode-descriptionForeground)}
.dot{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0}
.dot.on{background:#4ec9b0}
.workspace{display:flex;flex:1;overflow:hidden}
.col{display:flex;flex-direction:column;overflow:hidden}
.col.evidence{width:240px;flex-shrink:0}
.col.notes{flex:2}
.col.viewer{flex:1;min-width:200px}
.resize-handle{width:4px;flex-shrink:0;cursor:col-resize;background:var(--vscode-panel-border);transition:background .12s;user-select:none}
.resize-handle:hover,.resize-handle.active{background:var(--vscode-focusBorder)}
.col-header{padding:5px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;display:flex;align-items:center;justify-content:space-between;cursor:grab;user-select:none}
.col-header:active{cursor:grabbing}
.col-header.drag-src{opacity:.45}
.col-header.drag-over{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.col-drag-hint{font-size:9px;opacity:.45;margin-left:4px;font-weight:400;text-transform:none;letter-spacing:0}
.col-body{flex:1;overflow-y:auto;padding:8px}
.notes-area{flex:1;min-height:0;width:100%;resize:none;background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family,var(--vscode-font-family));font-size:var(--vscode-editor-font-size,var(--vscode-font-size));border:none;outline:none;padding:8px;line-height:1.6;box-sizing:border-box}
.notes-area::placeholder{color:var(--vscode-input-placeholderForeground)}
.save-indicator{font-size:9px;color:var(--vscode-descriptionForeground);opacity:0;transition:opacity .3s;padding-right:4px;cursor:default;text-transform:none;letter-spacing:0;font-weight:400}
.save-indicator.show{opacity:1}
.add-btn{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;border:1px dashed var(--vscode-panel-border);border-radius:3px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;background:none;width:100%;margin-bottom:6px}
.add-btn:hover{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
.ev-drop-active{outline:2px dashed var(--vscode-focusBorder);outline-offset:-3px}
.ev-drop-active .col-body{background:var(--vscode-list-hoverBackground)}
.ev-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px;font-size:11px;cursor:pointer}
.ev-item:hover{background:var(--vscode-list-hoverBackground)}
.ev-item.active{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.ev-type{font-size:9px;font-weight:700;padding:1px 4px;border-radius:2px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);flex-shrink:0}
.ev-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ev-time{font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0}
.ev-ext{opacity:0;pointer-events:none;background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:11px;line-height:1;flex-shrink:0}
.ev-ext:hover{color:var(--vscode-foreground)}
.ev-item:hover .ev-ext{opacity:.6;pointer-events:auto}
.ev-del{opacity:0;pointer-events:none;background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:14px;line-height:1;flex-shrink:0}
.ev-del:hover{color:var(--vscode-errorForeground)}
.ev-item:hover .ev-del{opacity:1;pointer-events:auto}
.ev-check{flex-shrink:0;cursor:pointer;width:13px;height:13px;margin:0;accent-color:var(--vscode-focusBorder);opacity:0;pointer-events:none}
.ev-item:hover .ev-check,.ev-item.selected .ev-check{opacity:1;pointer-events:auto}
.ev-item.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
.ev-select-bar{display:none;align-items:center;gap:5px;padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px;flex-shrink:0}
.ev-select-bar.visible{display:flex}
.global-search{display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0}
.ev-group{border:1px solid var(--vscode-panel-border);border-radius:3px;margin-bottom:4px;overflow:hidden}
.ev-group-hdr{display:flex;align-items:center;gap:5px;padding:4px 6px;cursor:pointer;font-size:11px;user-select:none;background:var(--vscode-sideBar-background)}
.ev-group-hdr:hover{background:var(--vscode-list-hoverBackground)}
.ev-group-icon{font-size:9px;color:var(--vscode-descriptionForeground);transition:transform .12s;flex-shrink:0;line-height:1}
.ev-group.collapsed .ev-group-icon{transform:rotate(-90deg)}
.ev-group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:600}
.ev-group-cnt{font-size:9px;padding:1px 5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px;flex-shrink:0}
.ev-group-del{opacity:0;pointer-events:none;background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;padding:0 3px;font-size:11px;flex-shrink:0;line-height:1}
.ev-group-del:hover{color:var(--vscode-errorForeground)}
.ev-group-hdr:hover .ev-group-del{opacity:.7;pointer-events:auto}
.ev-group-body{padding:2px 0 2px 8px}
.ev-group.collapsed .ev-group-body{display:none}
.empty{text-align:center;padding:24px 12px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6}
.analysis-section{border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:6px;display:none}
.analysis-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);padding:3px 4px;cursor:pointer;display:flex;align-items:center;gap:5px;user-select:none;border-radius:2px}
.analysis-hdr:hover{color:var(--vscode-foreground);background:var(--vscode-list-hoverBackground)}
.analysis-cnt{font-size:9px;padding:1px 5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px}
.analysis-body{margin-top:6px;display:none}
.card{border:1px solid var(--vscode-panel-border);border-radius:3px;margin-bottom:6px;overflow:hidden}
.card-header{display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;font-size:11px;user-select:none}
.card-header:hover{background:var(--vscode-list-hoverBackground)}
.badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:2px;letter-spacing:.04em;flex-shrink:0}
.badge.high{background:#f14c4c22;color:#f14c4c}
.badge.medium{background:#cca70022;color:#cca700}
.badge.low{background:#75beff22;color:#75beff}
.card-name{font-weight:500;flex:1}
.chevron{font-size:10px;color:var(--vscode-descriptionForeground);transition:transform .12s;line-height:1}
.card.open .chevron{transform:rotate(90deg)}
.card-body{padding:8px 10px;font-size:11px;border-top:1px solid var(--vscode-panel-border);display:none}
.card.open .card-body{display:block}
.ev-lines{color:var(--vscode-descriptionForeground);margin-bottom:7px;line-height:1.7}
.actions{display:flex;flex-wrap:wrap;gap:5px}
.btn{padding:2px 8px;font-size:11px;border:1px solid var(--vscode-button-border,var(--vscode-panel-border));background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-radius:2px;cursor:pointer;white-space:nowrap}
.btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.btn.accent{background:#cca70011;color:#cca700;border-color:#cca70044}
.btn.accent:hover{background:#cca70022}
.related{margin-top:6px;font-size:10px;color:var(--vscode-descriptionForeground)}
.viewer-body{flex:1;overflow-y:auto;overflow-x:hidden}
.viewer-pane{display:flex;flex-direction:column;border-bottom:1px solid var(--vscode-panel-border)}
.viewer-pane-hdr{display:flex;align-items:center;gap:5px;padding:3px 8px;font-size:10px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.viewer-lbl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-style:italic;font-size:10px}
.viewer-lbl.loaded{color:var(--vscode-foreground);font-style:normal}
.viewer-content{height:260px;overflow:auto;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;padding:8px;line-height:1.5}
.viewer-content pre{white-space:pre-wrap;word-break:break-all;margin:0}
.viewer-content img{max-width:100%;height:auto;display:block;margin:0 auto}
.viewer-empty{text-align:center;padding:32px 12px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.8}
.pane-search{display:none;padding:3px 6px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);align-items:center;gap:4px;flex-shrink:0}
.pane-search.visible{display:flex}
.pane-search-input{flex:1;min-width:0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:2px 5px;font-size:10px;border-radius:2px;outline:none;font-family:inherit}
.pane-search-input:focus{border-color:var(--vscode-focusBorder)}
.pane-search-count{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;min-width:52px;text-align:right}
.pane-search-nav{padding:0 5px;font-size:12px;line-height:1.6;background:none;border:1px solid transparent;border-radius:2px;color:var(--vscode-descriptionForeground);cursor:pointer;flex-shrink:0}
.pane-search-nav:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground);border-color:var(--vscode-panel-border)}
.pane-search-nav:disabled{opacity:.3;cursor:not-allowed}
mark.search-match{background:#cca70033;color:inherit;border-radius:1px}
mark.active-match{background:#cca700;color:#1e1e1e;border-radius:1px}
.viewer-empty-state{display:flex;align-items:center;justify-content:center;flex:1;font-size:11px;color:var(--vscode-descriptionForeground);padding:40px 12px;text-align:center;line-height:1.8}
.viewer-truncnote{font-size:10px;color:var(--vscode-descriptionForeground);padding:3px 8px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);text-align:center}
.search-ctx-list{padding:0;margin:0}
.search-ctx{border-bottom:1px solid var(--vscode-panel-border)}
.search-ctx-hdr{font-size:10px;color:var(--vscode-descriptionForeground);padding:2px 8px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);user-select:none}
.search-ctx-pre{margin:0;padding:4px 8px;white-space:pre-wrap;word-break:break-all;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);line-height:1.5}
.ctx-menu{display:none;position:fixed;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,var(--vscode-panel-border));border-radius:3px;z-index:9999;min-width:150px;overflow:hidden;box-shadow:2px 4px 12px rgba(0,0,0,.4)}
.ctx-item{padding:6px 14px;font-size:12px;cursor:pointer;color:var(--vscode-menu-foreground,var(--vscode-foreground));user-select:none}
.ctx-item:hover{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,var(--vscode-foreground))}
.ctx-danger{color:var(--vscode-errorForeground)!important}
.ctx-sep{height:1px;background:var(--vscode-menu-separatorBackground,var(--vscode-panel-border));margin:3px 0}
.collapse-btn{background:none;border:none;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:13px;padding:0 4px;line-height:1;border-radius:2px;flex-shrink:0;opacity:.55;font-weight:400}
.collapse-btn:hover{opacity:1;background:var(--vscode-list-hoverBackground)}
.col.collapsed{width:28px!important;min-width:0!important;flex:none!important;overflow:hidden!important}
.col.collapsed>*:not(.col-header){display:none!important}
.col.collapsed .col-header>*:not(.collapse-btn){display:none!important}
.col.collapsed .col-header{justify-content:center;cursor:default}
#case-title[contenteditable]{outline:none;cursor:text;border-bottom:1px solid transparent;padding:0 2px;border-radius:1px;font-weight:inherit}
#case-title[contenteditable]:hover{border-bottom-color:var(--vscode-descriptionForeground)}
#case-title[contenteditable]:focus{border-bottom-color:var(--vscode-focusBorder)}
.preview-btn{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);cursor:pointer;padding:1px 6px;font-size:10px;border-radius:2px;white-space:nowrap;flex-shrink:0}
.preview-btn:hover{color:var(--vscode-foreground);border-color:var(--vscode-foreground)}
.preview-btn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.notes-preview{flex:1;overflow-y:auto;padding:8px 10px;display:none;font-size:var(--vscode-font-size);line-height:1.6;color:var(--vscode-editor-foreground)}
.notes-preview h1,.notes-preview h2,.notes-preview h3,.notes-preview h4{font-weight:600;margin:12px 0 6px;line-height:1.3;color:var(--vscode-foreground)}
.notes-preview h1{font-size:1.4em}.notes-preview h2{font-size:1.2em}.notes-preview h3{font-size:1.05em}
.notes-preview p{margin:0 0 6px}
.notes-preview ul,.notes-preview ol{margin:0 0 6px;padding-left:20px}
.notes-preview li{margin:2px 0}
.notes-preview pre{background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:3px;padding:8px;overflow-x:auto;margin:0 0 8px;font-family:var(--vscode-editor-font-family,monospace);font-size:.95em}
.notes-preview code{font-family:var(--vscode-editor-font-family,monospace);font-size:.95em;background:var(--vscode-sideBar-background);padding:1px 4px;border-radius:2px}
.notes-preview pre code{background:none;padding:0}
.notes-preview a{color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none;cursor:default}
.notes-preview hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:10px 0}
.notes-preview strong{font-weight:700}
.notes-preview em{font-style:italic}
.notes-preview .emb-ref-link{font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;color:var(--vscode-textLink-foreground,#3794ff);background:var(--vscode-sideBar-background);padding:1px 5px;border-radius:2px}
#notes-refs-wrap{flex-shrink:0;max-height:45%;display:none;flex-direction:column;overflow:hidden}
#notes-refs-drag{height:6px;cursor:ns-resize;flex-shrink:0;background:transparent;border-top:2px solid var(--vscode-panel-border);position:relative}
#notes-refs-drag:hover,#notes-refs-drag.dragging{border-top-color:var(--vscode-focusBorder)}
#notes-refs-drag::after{content:'';position:absolute;top:1px;left:50%;transform:translateX(-50%);width:24px;height:2px;border-radius:1px;background:var(--vscode-panel-border)}
#notes-refs-searchbar{display:flex;align-items:center;gap:4px;padding:3px 6px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
#notes-refs-search-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:2px 5px;font-size:10px;border-radius:2px;outline:none;font-family:inherit}
#notes-refs-search-input:focus{border-color:var(--vscode-focusBorder)}
#notes-refs-count{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;min-width:48px;text-align:right}
#notes-embedded-refs{overflow-y:auto;flex:1}
.emb-ref{border-bottom:1px solid var(--vscode-panel-border)}
.emb-ref-hdr{display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--vscode-sideBar-background);cursor:pointer;user-select:none;font-size:11px;color:var(--vscode-descriptionForeground)}
.emb-ref-hdr:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}
.emb-ref-icon{font-size:9px;transition:transform .12s;flex-shrink:0}
.emb-ref.collapsed .emb-ref-icon{transform:rotate(-90deg)}
.emb-ref-name{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:var(--vscode-foreground);flex:1}
.emb-ref-body{margin:0;padding:6px 10px;max-height:350px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);line-height:1.5;color:var(--vscode-editor-foreground)}
.emb-ref.collapsed .emb-ref-body{display:none}
.md-toolbar{display:flex;align-items:center;gap:2px;padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
.md-btn{background:none;border:1px solid transparent;color:var(--vscode-descriptionForeground);cursor:pointer;padding:2px 7px;font-size:11px;border-radius:2px;font-family:inherit;line-height:1.4;flex-shrink:0}
.md-btn:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground);border-color:var(--vscode-panel-border)}
.md-toolbar-sep{width:1px;height:14px;background:var(--vscode-panel-border);margin:0 3px;flex-shrink:0}
.md-link-bar{display:flex;align-items:center;gap:4px;padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
.md-link-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:2px 5px;font-size:11px;border-radius:2px;outline:none;font-family:inherit}
.md-link-input:focus{border-color:var(--vscode-focusBorder)}
#notes-search-bar{display:none;align-items:center;gap:4px;padding:3px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)}
#notes-search-bar.visible{display:flex}
#notes-search-input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:2px 5px;font-size:10px;border-radius:2px;outline:none;font-family:inherit}
#notes-search-input:focus{border-color:var(--vscode-focusBorder)}
#notes-search-count{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;min-width:52px;text-align:right}
.export-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center}
.export-dialog{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:4px;width:700px;max-width:90vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.5)}
.export-dialog-hdr{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.export-dialog-title{font-size:12px;font-weight:700;flex:1}
.export-char-count{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.export-title-toggle{font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap;color:var(--vscode-descriptionForeground);user-select:none}
.export-area{flex:1;resize:none;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:none;padding:10px 12px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;line-height:1.6;min-height:320px;outline:none}
</style>
</head>
<body>
<div class="header">
  <h2>${caseId} &mdash; <span id="case-title" contenteditable="true" spellcheck="false">${title}</span></h2>
  <div class="header-right">
    <div class="bridge"><div class="dot" id="dot"></div><span id="bridge-lbl">Disconnected</span></div>
    <button class="btn" id="export-jira-btn" title="Export case as JIRA comment">Export to JIRA</button>
    <button class="btn" id="resolve-btn">Resolve</button>
  </div>
</div>

<div class="workspace" id="workspace">
  <div class="col evidence" id="col-evidence">
    <div class="col-header" draggable="true" data-col="evidence">
      <span>Evidence<span class="col-drag-hint">drag to reorder</span></span>
      <button class="collapse-btn" data-collapse="evidence" title="Collapse">&#x2039;</button>
    </div>
    <div class="col-body">
      <div class="ev-select-bar" id="ev-select-bar">
        <span id="ev-select-count" style="flex:1;color:var(--vscode-descriptionForeground)"></span>
        <button class="btn" id="ev-delete-selected" style="font-size:10px;padding:2px 6px">Delete</button>
        <button class="btn" id="ev-select-clear" style="font-size:10px;padding:2px 6px">Clear</button>
      </div>
      <button class="add-btn" id="add-evidence-btn">&#xff0b; Add evidence files</button>
      <div id="ev-list"></div>
      <div class="analysis-section" id="analysis-section">
        <div class="analysis-hdr" id="analysis-toggle">
          Analysis
          <span class="analysis-cnt" id="analysis-cnt">0</span>
          <span class="chevron" id="analysis-chevron" style="margin-left:auto">&#x203A;</span>
        </div>
        <div class="analysis-body" id="analysis-body"></div>
      </div>
    </div>
  </div>
  <div class="resize-handle" id="handle-0"></div>
  <div class="col notes" id="col-notes">
    <div class="col-header" draggable="true" data-col="notes">
      <span>Notes<span class="col-drag-hint">drag to reorder</span></span>
      <span class="save-indicator" id="save-indicator">Saved</span>
      <button class="preview-btn" id="preview-btn" title="Toggle markdown preview">Preview</button>
      <button class="collapse-btn" data-collapse="notes" title="Collapse">&#x2039;</button>
    </div>
    <div class="md-toolbar" id="md-toolbar">
      <button class="md-btn" data-wrap="**" title="Bold" style="font-weight:700">B</button>
      <button class="md-btn" data-wrap="*" title="Italic" style="font-style:italic">I</button>
      <button class="md-btn" data-wrap="u" title="Underline" style="text-decoration:underline">U</button>
      <div class="md-toolbar-sep"></div>
      <button class="md-btn md-link-btn" title="Insert link">Link</button>
    </div>
    <div class="md-link-bar" id="md-link-bar" style="display:none">
      <input class="md-link-input" id="md-link-input" placeholder="https://" autocomplete="off" spellcheck="false">
      <button class="btn" id="md-link-ok" style="font-size:10px;padding:2px 8px">Insert</button>
      <button class="btn" id="md-link-cancel" style="font-size:10px;padding:2px 8px">&#x2715;</button>
    </div>
    <div id="notes-search-bar">
      <input id="notes-search-input" placeholder="Search notes..." autocomplete="off" spellcheck="false">
      <span id="notes-search-count"></span>
      <button class="pane-search-nav" id="notes-search-prev" title="Previous (Shift+Enter)">&#x2191;</button>
      <button class="pane-search-nav" id="notes-search-next" title="Next (Enter)">&#x2193;</button>
      <button class="pane-search-nav" id="notes-search-close" title="Close (Escape)">&#x2715;</button>
    </div>
    <textarea class="notes-area" id="notes-area" placeholder="Write your investigation notes here&#x2026;&#10;&#10;What did you observe? What have you tried? What&#x27;s the current hypothesis?"></textarea>
    <div class="notes-preview" id="notes-preview"></div>
    <div id="notes-refs-wrap">
      <div id="notes-refs-drag"></div>
      <div id="notes-refs-searchbar">
        <input id="notes-refs-search-input" placeholder="Search snippets..." autocomplete="off" spellcheck="false">
        <span id="notes-refs-count"></span>
        <button class="pane-search-nav" id="notes-refs-prev" title="Previous">&#x2191;</button>
        <button class="pane-search-nav" id="notes-refs-next" title="Next">&#x2193;</button>
      </div>
      <div id="notes-embedded-refs"></div>
    </div>
  </div>
  <div class="resize-handle" id="handle-1"></div>
  <div class="col viewer" id="col-viewer">
    <div class="col-header" draggable="true" data-col="viewer">
      <span>Viewer<span class="col-drag-hint">drag to reorder</span></span>
      <button class="collapse-btn" data-collapse="viewer" title="Collapse">&#x2039;</button>
    </div>
    <div class="global-search" id="global-search">
      <input class="pane-search-input" id="global-search-input" placeholder="Search all open viewers..." autocomplete="off" spellcheck="false">
      <span class="pane-search-count" id="global-search-count"></span>
      <button class="pane-search-nav" id="global-search-prev" title="Previous (Shift+Enter)">&#x2191;</button>
      <button class="pane-search-nav" id="global-search-next" title="Next (Enter)">&#x2193;</button>
    </div>
    <div class="viewer-body" id="viewer-body">
      <div class="viewer-empty-state" id="viewer-empty-state">Click an evidence item to open it here.<br>Each item opens in its own pane.</div>
    </div>
  </div>
</div>


<!-- JIRA Export modal -->
<div class="export-modal" id="export-modal" style="display:none">
  <div class="export-dialog">
    <div class="export-dialog-hdr">
      <span class="export-dialog-title">JIRA Export</span>
      <span class="export-char-count" id="export-char-count"></span>
      <label class="export-title-toggle"><input type="checkbox" id="export-title-cb"> Include title</label>
      <button class="btn" id="export-copy-btn" style="font-size:11px">Copy</button>
      <button class="btn" id="export-close-btn" style="font-size:11px">&#x2715;</button>
    </div>
    <textarea class="export-area" id="export-area" readonly spellcheck="false"></textarea>
  </div>
</div>

<!-- Context menu for evidence items -->
<div class="ctx-menu" id="ctx-menu">
  <div class="ctx-item" id="ctx-open">Open in Editor &#x2197;</div>
  <div class="ctx-item" id="ctx-rename">Rename...</div>
  <div class="ctx-item" id="ctx-copy-ref">Copy reference</div>
  <div class="ctx-item" id="ctx-ai-review">Send to AI for Review...</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item ctx-danger" id="ctx-delete">Delete Evidence</div>
</div>

<script nonce="${nonce}">
// Show any JS error visibly so it can be diagnosed
window.onerror = function(msg, src, line) {
  var banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f14c4c;color:#fff;padding:6px 10px;font-size:11px;z-index:99999;font-family:monospace;white-space:pre-wrap';
  banner.textContent = 'JS Error (line ' + line + '): ' + msg;
  document.body.appendChild(banner);
};

const vscode = acquireVsCodeApi();
let items = [];
let saveTimer = null;
var groupEls = {}; // groupName -> group container element
var draggingEv = null; // set during evidence drag-and-drop
var selectedEvIds = new Set();
var globalMatchList = []; // [{paneId, markIdx}] - ordered across all open panes
var globalMatchCur = 0;

function debounce(fn, ms) {
  var t;
  return function() { clearTimeout(t); t = setTimeout(fn, ms); };
}

// -- Notes search --------------------------------------------------------------
var notesSearchMatches = []; // [{start, end}]
var notesSearchCur = 0;

function openNotesSearch() {
  var bar = document.getElementById('notes-search-bar');
  var inp = document.getElementById('notes-search-input');
  bar.classList.add('visible');
  inp.focus();
  inp.select();
  if (inp.value) runNotesSearch();
}

function closeNotesSearch() {
  var bar = document.getElementById('notes-search-bar');
  bar.classList.remove('visible');
  notesSearchMatches = [];
  notesSearchCur = 0;
  document.getElementById('notes-search-count').textContent = '';
  document.getElementById('notes-area').focus();
}

function runNotesSearch() {
  var query = document.getElementById('notes-search-input').value;
  var ta = document.getElementById('notes-area');
  var countEl = document.getElementById('notes-search-count');
  notesSearchMatches = [];
  notesSearchCur = -1; // -1 so the first navNotesMatch(+1) lands on index 0
  if (!query) { countEl.textContent = ''; return; }
  var text = ta.value;
  var lower = text.toLowerCase();
  var lowerQ = query.toLowerCase();
  var qLen = lowerQ.length;
  if (qLen === 0) { countEl.textContent = ''; return; }
  var p = lower.indexOf(lowerQ);
  while (p !== -1) {
    notesSearchMatches.push({ start: p, end: p + qLen });
    p = lower.indexOf(lowerQ, p + qLen);
  }
  countEl.textContent = notesSearchMatches.length === 0 ? 'no results' : '0 / ' + notesSearchMatches.length;
}

// Measures the pixel offset of charIndex inside a textarea using a mirror div,
// accounting for line wrapping (unlike a simple lineCount * lineHeight approach).
function notesMatchScrollTop(ta, charIndex) {
  var style = window.getComputedStyle(ta);
  var mirror = document.createElement('div');
  mirror.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;' +
    'overflow:hidden;white-space:pre-wrap;word-wrap:break-word;box-sizing:border-box;' +
    'width:' + ta.clientWidth + 'px;' +
    'padding:' + style.paddingTop + ' ' + style.paddingRight + ' ' + style.paddingBottom + ' ' + style.paddingLeft + ';' +
    'font-family:' + style.fontFamily + ';font-size:' + style.fontSize + ';' +
    'font-weight:' + style.fontWeight + ';line-height:' + style.lineHeight + ';' +
    'letter-spacing:' + style.letterSpacing + ';';
  mirror.textContent = ta.value.slice(0, charIndex);
  document.body.appendChild(mirror);
  var top = mirror.scrollHeight;
  document.body.removeChild(mirror);
  return top;
}

function focusNotesMatch(idx) {
  var ta = document.getElementById('notes-area');
  var countEl = document.getElementById('notes-search-count');
  if (!notesSearchMatches.length) return;
  notesSearchCur = ((idx % notesSearchMatches.length) + notesSearchMatches.length) % notesSearchMatches.length;
  var m = notesSearchMatches[notesSearchCur];
  ta.focus();
  ta.setSelectionRange(m.start, m.end);
  var matchTop = notesMatchScrollTop(ta, m.start);
  ta.scrollTop = Math.max(0, matchTop - ta.clientHeight / 2);
  countEl.textContent = (notesSearchCur + 1) + ' / ' + notesSearchMatches.length;
}

function navNotesMatch(dir) {
  if (!notesSearchMatches.length) return;
  focusNotesMatch(notesSearchCur + dir);
}

(function() {
  var inp = document.getElementById('notes-search-input');
  inp.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); runNotesSearch(); navNotesMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeNotesSearch(); }
  });
  document.getElementById('notes-search-prev').addEventListener('click', function() { navNotesMatch(-1); });
  document.getElementById('notes-search-next').addEventListener('click', function() { navNotesMatch(1); });
  document.getElementById('notes-search-close').addEventListener('click', closeNotesSearch);
})();

// Ctrl+F / Cmd+F when notes area is focused opens notes search
document.getElementById('notes-area').addEventListener('keydown', function(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    openNotesSearch();
  }
});

var embRefMatchCur = 0;

function runEmbRefSearch() {
  var input = document.getElementById('notes-refs-search-input');
  var query = input ? input.value : '';
  var countEl = document.getElementById('notes-refs-count');
  embRefMatchCur = 0;
  var refBodies = document.querySelectorAll('.emb-ref-body');
  for (var i = 0; i < refBodies.length; i++) {
    var bodyEl = refBodies[i];
    var rawText = bodyEl.dataset.raw;
    if (!rawText) continue;
    if (!query) {
      bodyEl.textContent = rawText;
      continue;
    }
    var lower = rawText.toLowerCase();
    var lowerQ = query.toLowerCase();
    var qLen = lowerQ.length;
    if (qLen === 0) { bodyEl.textContent = rawText; continue; }
    var positions = [];
    var p = lower.indexOf(lowerQ);
    while (p !== -1) { positions.push(p); p = lower.indexOf(lowerQ, p + qLen); }
    if (positions.length > 0) {
      bodyEl.parentElement.classList.remove('collapsed');
      var html = '';
      var idx = 0;
      for (var k = 0; k < positions.length; k++) {
        var pos = positions[k];
        if (pos > idx) html += esc(rawText.slice(idx, pos));
        html += '<mark class="search-match">' + esc(rawText.slice(pos, pos + qLen)) + '</mark>';
        idx = pos + qLen;
      }
      if (idx < rawText.length) html += esc(rawText.slice(idx));
      bodyEl.innerHTML = html;
    } else {
      bodyEl.textContent = rawText;
    }
  }
  if (!query) { if (countEl) countEl.textContent = ''; return; }
  var allMarks = document.querySelectorAll('.emb-ref-body .search-match');
  if (allMarks.length > 0) {
    allMarks[0].classList.add('active-match');
    allMarks[0].scrollIntoView({ block: 'nearest' });
    if (countEl) countEl.textContent = '1 / ' + allMarks.length;
  } else {
    if (countEl) countEl.textContent = 'no results';
  }
}

function navEmbRefMatch(dir) {
  var allMarks = document.querySelectorAll('.emb-ref-body .search-match');
  if (!allMarks.length) return;
  allMarks[embRefMatchCur].classList.remove('active-match');
  embRefMatchCur = (embRefMatchCur + dir + allMarks.length) % allMarks.length;
  allMarks[embRefMatchCur].classList.add('active-match');
  allMarks[embRefMatchCur].scrollIntoView({ block: 'nearest' });
  var countEl = document.getElementById('notes-refs-count');
  if (countEl) countEl.textContent = (embRefMatchCur + 1) + ' / ' + allMarks.length;
}

(function() {
  var si = document.getElementById('notes-refs-search-input');
  si.addEventListener('input', debounce(runEmbRefSearch, 250));
  si.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); navEmbRefMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { si.value = ''; runEmbRefSearch(); }
  });
  document.getElementById('notes-refs-prev').addEventListener('click', function() { navEmbRefMatch(-1); });
  document.getElementById('notes-refs-next').addEventListener('click', function() { navEmbRefMatch(1); });
})();

var embRefTimer;
function updateEmbeddedRefs(notesText) {
  var container = document.getElementById('notes-embedded-refs');
  if (!container) return;
  // Parse all local non-image file links in order
  var ordered = [];
  var seen = {};
  var i = 0;
  while (i < notesText.length) {
    var ob = notesText.indexOf('[', i);
    if (ob === -1) break;
    var cb = notesText.indexOf(']', ob + 1);
    if (cb === -1) { i = ob + 1; continue; }
    if (notesText[cb + 1] !== '(') { i = cb + 1; continue; }
    var pe = findLinkEnd(notesText, cb + 2);
    if (pe === -1) { i = cb + 1; continue; }
    var href = notesText.slice(cb + 2, pe);
    var lhref = href.toLowerCase();
    var isLocal = lhref.startsWith('./') || lhref.startsWith('../');
    var isBinaryExt = /\\.(zip|tar|gz|bz2|7z|rar|pdf|pptx?|xlsx?|docx?|exe|dmg|pkg|jar|class|pyc|so|dylib|dll|png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(lhref);
    if (isLocal && !isBinaryExt && !seen[href]) {
      seen[href] = true;
      ordered.push({ href: href, fname: href.split('/').pop() });
    }
    i = pe + 1;
  }
  // Remove blocks no longer referenced
  var existingEls = container.querySelectorAll('.emb-ref');
  for (var ri = 0; ri < existingEls.length; ri++) {
    if (!seen[existingEls[ri].dataset.embSrc]) existingEls[ri].remove();
  }
  // Add new blocks; first 3 expanded, rest collapsed
  var expandedCount = container.querySelectorAll('.emb-ref:not(.collapsed)').length;
  ordered.forEach(function(ref) {
    var already = container.querySelectorAll('.emb-ref');
    for (var ai = 0; ai < already.length; ai++) {
      if (already[ai].dataset.embSrc === ref.href) return;
    }
    var collapsed = expandedCount >= 3;
    var div = document.createElement('div');
    div.className = 'emb-ref' + (collapsed ? ' collapsed' : '');
    div.dataset.embSrc = ref.href;
    div.innerHTML = '<div class="emb-ref-hdr">'
      + '<span class="emb-ref-icon">&#9660;</span>'
      + '<span class="emb-ref-name">' + esc(ref.fname) + '</span>'
      + '</div>'
      + '<pre class="emb-ref-body">Loading...</pre>';
    container.appendChild(div);
    if (!collapsed) expandedCount++;
    send('loadInlineFile', { src: ref.href });
  });
  // Show or hide the whole panel
  var wrap = document.getElementById('notes-refs-wrap');
  if (wrap) wrap.style.display = container.children.length > 0 ? 'flex' : 'none';
  capEmbRefsHeight();
}

var embRefsUserHeight = null; // set once user manually drags; bypasses auto-cap

function capEmbRefsHeight() {
  if (embRefsUserHeight !== null) return; // user owns the height
  requestAnimationFrame(function() {
    var container = document.getElementById('notes-embedded-refs');
    if (!container) return;
    var refs = container.querySelectorAll('.emb-ref');
    if (refs.length <= 3) {
      container.style.maxHeight = '';
      return;
    }
    var h = 0;
    for (var j = 0; j < 3; j++) h += refs[j].offsetHeight;
    container.style.maxHeight = h + 'px';
  });
}

// Event delegation for emb-ref toggle (CSP blocks inline onclick attributes)
document.getElementById('notes-embedded-refs').addEventListener('click', function(e) {
  var hdr = e.target.closest('.emb-ref-hdr');
  if (!hdr) return;
  hdr.parentElement.classList.toggle('collapsed');
  capEmbRefsHeight();
});

// Drag handle: resize the snippets panel
(function() {
  var handle = document.getElementById('notes-refs-drag');
  var wrap   = document.getElementById('notes-refs-wrap');
  var startY, startH;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startY = e.clientY;
    startH = wrap.offsetHeight;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    var delta  = e.clientY - startY;        // positive = drag down = shrink panel
    var newH   = Math.max(48, startH - delta);
    embRefsUserHeight = newH;
    wrap.style.height    = newH + 'px';
    wrap.style.maxHeight = newH + 'px';
  }

  function onUp() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
})();

// -- Layout ------------------------------------------------------------
const MIN_W = {evidence: 110, notes: 140, viewer: 200};
let colOrder = ['evidence', 'notes', 'viewer'];
var collapsed = {};
const handles = [document.getElementById('handle-0'), document.getElementById('handle-1')];

function getCol(id) { return document.getElementById('col-' + id); }

function applyOrder() {
  var ws = document.getElementById('workspace');
  if (!ws) return;
  colOrder.forEach(function(id, i) {
    var col = getCol(id);
    if (col) ws.appendChild(col);
    var h = handles[i];
    if (i < colOrder.length - 1 && h) ws.appendChild(h);
  });
}

function saveLayout() {
  const widths = {};
  colOrder.forEach(function(id) {
    if (!collapsed[id]) widths[id] = getCol(id).getBoundingClientRect().width;
  });
  vscode.setState({ colOrder: colOrder, widths: widths, collapsed: collapsed });
}

function applyCollapseState(colId) {
  var col = getCol(colId);
  var hdr = col ? col.querySelector('.col-header') : null;
  var btn = col ? col.querySelector('.collapse-btn') : null;
  if (collapsed[colId]) {
    if (col) { col.classList.add('collapsed'); col.style.width = ''; col.style.flex = ''; }
    if (btn) btn.textContent = '\\u203a'; // >
    if (hdr) hdr.removeAttribute('draggable');
  } else {
    if (col) col.classList.remove('collapsed');
    if (btn) btn.textContent = '\\u2039'; // <
    if (hdr) hdr.setAttribute('draggable', 'true');
  }
}

function toggleCollapse(colId) {
  collapsed[colId] = !collapsed[colId];
  applyCollapseState(colId);
  saveLayout();
}

function loadLayout() {
  const s = vscode.getState();
  if (!s) return;
  if (s.colOrder && s.colOrder.length === 3) {
    colOrder = s.colOrder.map(function(c) { return c === 'findings' ? 'viewer' : c; });
  }
  applyOrder();
  if (s.widths) {
    colOrder.forEach(function(id) {
      const el = getCol(id);
      const w = s.widths[id] || (id === 'viewer' ? s.widths['findings'] : undefined);
      if (w && w > 0) { el.style.flex = 'none'; el.style.width = w + 'px'; }
    });
  }
  if (s.collapsed) {
    for (var cid in s.collapsed) {
      if (s.collapsed[cid]) {
        collapsed[cid] = true;
        applyCollapseState(cid);
      }
    }
  }
}

// -- Resize handles ------------------------------------------------------------
handles.forEach(function(handle) {
  if (!handle) return;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const ws = document.getElementById('workspace');
    const children = Array.from(ws.children);
    const hIdx = children.indexOf(handle);
    const leftEl = children[hIdx - 1];
    const rightEl = children[hIdx + 1];
    if (!leftEl || !rightEl) return;

    let lw = leftEl.getBoundingClientRect().width;
    let rw = rightEl.getBoundingClientRect().width;
    leftEl.style.flex = 'none'; leftEl.style.width = lw + 'px';
    rightEl.style.flex = 'none'; rightEl.style.width = rw + 'px';

    const startX = e.clientX;
    const lId = leftEl.id.replace('col-', '');
    const rId = rightEl.id.replace('col-', '');

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const newLw = Math.max(MIN_W[lId] || 100, lw + dx);
      const newRw = Math.max(MIN_W[rId] || 100, rw - dx);
      leftEl.style.width = newLw + 'px';
      rightEl.style.width = newRw + 'px';
    }

    function onUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayout();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
});

// -- Drag-to-reorder -----------------------------------------------------------
var dragSrc = null;

document.querySelectorAll('.col-header[draggable]').forEach(function(header) {
  header.addEventListener('dragstart', function(e) {
    dragSrc = header.dataset.col;
    header.classList.add('drag-src');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragSrc);
  });
  header.addEventListener('dragend', function() {
    header.classList.remove('drag-src');
    dragSrc = null;
  });
  header.addEventListener('dragover', function(e) {
    e.preventDefault();
    if (dragSrc && dragSrc !== header.dataset.col) {
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drag-over');
    }
  });
  header.addEventListener('dragleave', function() {
    header.classList.remove('drag-over');
  });
  header.addEventListener('drop', function(e) {
    e.preventDefault();
    header.classList.remove('drag-over');
    if (!dragSrc || dragSrc === header.dataset.col) return;
    const srcIdx = colOrder.indexOf(dragSrc);
    const dstIdx = colOrder.indexOf(header.dataset.col);
    if (srcIdx < 0 || dstIdx < 0) return;
    colOrder.splice(srcIdx, 1);
    colOrder.splice(dstIdx, 0, dragSrc);
    applyOrder();
    saveLayout();
  });
});

// -- Collapse delegation -------------------------------------------------------
document.getElementById('workspace').addEventListener('click', function(e) {
  var btn = e.target && e.target.closest && e.target.closest('.collapse-btn');
  if (!btn || !btn.dataset || !btn.dataset.collapse) return;
  e.stopPropagation();
  toggleCollapse(btn.dataset.collapse);
});

try { loadLayout(); } catch(e) { /* stale state - ignore, use defaults */ }

// -- Messaging -----------------------------------------------------------------
function send(type, extra) { vscode.postMessage(Object.assign({type}, extra||{})); }

window.addEventListener('message', function(evt) {
  var m = evt.data;
  if (m.type === 'initialState') {
    m.evidence.forEach(addEvidence);
    renderFindings(m.findings);
    var ta = document.getElementById('notes-area');
    if (ta && m.notes) { ta.value = m.notes; updateEmbeddedRefs(m.notes); }
    updateStatusButton(m.status);
  }
  else if (m.type === 'statusChanged') { updateStatusButton(m.status); }
  else if (m.type === 'caseUpdated') {
    updateStatusButton(m.status);
    if (m.title) { var ct = document.getElementById('case-title'); if (ct) ct.textContent = m.title; }
  }
  else if (m.type === 'evidenceAdded') addEvidence(m.item);
  else if (m.type === 'notesUpdated') {
    var ta3 = document.getElementById('notes-area');
    if (ta3) { ta3.value = m.notes; updateEmbeddedRefs(m.notes); }
    if (previewMode) { document.getElementById('notes-preview').innerHTML = renderMd(m.notes); }
  }
  else if (m.type === 'evidenceRenamed') {
    var it = items.find(function(i) { return i.id === m.id; });
    if (it) {
      it.name = m.name;
      var row = document.querySelector('.ev-item[data-ev-id="' + m.id + '"]');
      var lbl = row && row.querySelector('.ev-name');
      if (lbl) lbl.textContent = m.name;
    }
  }
  else if (m.type === 'evidenceRemoved') removeEvidence(m.id);
  else if (m.type === 'groupRemoved') removeGroup(m.group);
  else if (m.type === 'jiraExport') {
    exportFullText = m.text;
    applyExportTitle();
    document.getElementById('export-modal').style.display = 'flex';
    if (m.newNotes !== undefined) {
      var ta2 = document.getElementById('notes-area');
      ta2.value = m.newNotes;
      if (previewMode) { document.getElementById('notes-preview').innerHTML = renderMd(m.newNotes); }
    }
    if (m.newEvidence && m.newEvidence.length) m.newEvidence.forEach(addEvidence);
  }
  else if (m.type === 'findings') renderFindings(m.findings);
  else if (m.type === 'bridgeStatus') setBridge(m.connected);
  else if (m.type === 'evidenceView') renderViewerContent(m.paneId, m.id, m.name, m.content, m.contentType);
  else if (m.type === 'previewImageLoaded') {
    var pvImgs = document.getElementById('notes-preview').querySelectorAll('img.preview-img');
    for (var pvi = 0; pvi < pvImgs.length; pvi++) {
      if (pvImgs[pvi].getAttribute('data-preview-src') === m.src) {
        pvImgs[pvi].src = m.dataUri;
      }
    }
  }
  else if (m.type === 'inlineFileLoaded') {
    var allEmb = document.querySelectorAll('.emb-ref');
    for (var ei = 0; ei < allEmb.length; ei++) {
      if (allEmb[ei].dataset.embSrc === m.src) {
        var eb = allEmb[ei].querySelector('.emb-ref-body');
        if (eb) { eb.dataset.raw = m.content; eb.textContent = m.content; }
      }
    }
    var refsInput = document.getElementById('notes-refs-search-input');
    if (refsInput && refsInput.value) runEmbRefSearch();
    capEmbRefsHeight();
  }
});

function doSaveNotes() {
  send('saveNotes', { notes: document.getElementById('notes-area').value });
  var ind = document.getElementById('save-indicator');
  if (ind) { ind.classList.add('show'); setTimeout(function() { ind.classList.remove('show'); }, 1200); }
}

document.getElementById('notes-area').addEventListener('input', function() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSaveNotes, 150);
  clearTimeout(embRefTimer);
  embRefTimer = setTimeout(function() { updateEmbeddedRefs(document.getElementById('notes-area').value); }, 600);
});

document.getElementById('notes-area').addEventListener('blur', function() {
  clearTimeout(saveTimer);
  doSaveNotes();
});

// -- Editable case title -------------------------------------------------------
var caseTitleEl = document.getElementById('case-title');
if (caseTitleEl) {
  caseTitleEl.addEventListener('blur', function() {
    var t = this.textContent.trim();
    if (t) send('saveTitle', { title: t });
  });
  caseTitleEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); this.blur(); }
    if (e.key === 'Escape') { this.blur(); }
  });
}

function setBridge(on) {
  document.getElementById('dot').className = 'dot'+(on?' on':'');
  document.getElementById('bridge-lbl').textContent = on ? 'Bridge connected' : 'Disconnected';
}

function buildEvidenceRef(item) {
  var label = (item.group && item.name.indexOf(item.group + '/') === 0)
    ? item.name.slice(item.group.length + 1)
    : item.name;
  return '[' + label + '](./' + item.name + ')';
}

function insertAtCursor(el, text) {
  var start = el.selectionStart;
  var end = el.selectionEnd;
  var val = el.value;
  el.value = val.slice(0, start) + text + val.slice(end);
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event('input'));
  el.focus();
}

function fallbackCopy(text) {
  var tmp = document.createElement('textarea');
  tmp.value = text;
  tmp.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(tmp);
  tmp.select();
  try { document.execCommand('copy'); } catch(err) {}
  document.body.removeChild(tmp);
}

// -- Export to JIRA modal ------------------------------------------------------
var exportFullText = '';

function applyExportTitle() {
  var cb = document.getElementById('export-title-cb');
  var ea = document.getElementById('export-area');
  var ec = document.getElementById('export-char-count');
  var text = (cb && !cb.checked)
    ? exportFullText.replace(/^h\\d\\. [^\\n]*\\n?\\n?/, '')
    : exportFullText;
  ea.value = text;
  if (ec) ec.textContent = text.length + ' / 32,767 chars';
}

document.getElementById('export-title-cb').addEventListener('change', applyExportTitle);

document.getElementById('export-jira-btn').addEventListener('click', function() {
  send('exportJira', { notes: document.getElementById('notes-area').value });
});

document.getElementById('export-copy-btn').addEventListener('click', function() {
  var text = document.getElementById('export-area').value;
  var cb = document.getElementById('export-title-cb');
  var notesHtml = renderMdForJira(document.getElementById('notes-area').value);
  if (cb && !cb.checked && notesHtml.slice(0, 2) === '<h') {
    var hCloseStart = notesHtml.indexOf('</h');
    if (hCloseStart !== -1) {
      var hCloseEnd = notesHtml.indexOf('>', hCloseStart);
      if (hCloseEnd !== -1) { notesHtml = notesHtml.slice(hCloseEnd + 1).replace(/^\s+/, ''); }
    }
  }
  var btn = this;
  if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
    var htmlBlob = new Blob([notesHtml], { type: 'text/html' });
    var textBlob = new Blob([text], { type: 'text/plain' });
    navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })])
      .catch(function() { fallbackCopy(text); });
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(function() { fallbackCopy(text); });
  } else { fallbackCopy(text); }
  btn.textContent = 'Copied!';
  setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
});

document.getElementById('export-close-btn').addEventListener('click', function() {
  document.getElementById('export-modal').style.display = 'none';
});

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('export-modal').style.display !== 'none') {
    document.getElementById('export-modal').style.display = 'none';
  }
});

// -- MD syntax toolbar ---------------------------------------------------------
var mdLinkSelStart = 0;
var mdLinkSelEnd = 0;

function mdWrap(before, after) {
  var ta = document.getElementById('notes-area');
  var start = ta.selectionStart;
  var end = ta.selectionEnd;
  var sel = ta.value.slice(start, end);
  var replacement = before + sel + (after !== undefined ? after : before);
  ta.value = ta.value.slice(0, start) + replacement + ta.value.slice(end);
  if (sel.length === 0) {
    ta.selectionStart = ta.selectionEnd = start + before.length;
  } else {
    ta.selectionStart = start;
    ta.selectionEnd = start + replacement.length;
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function insertLink() {
  var url = document.getElementById('md-link-input').value.trim();
  closeLinkBar();
  if (!url) return;
  var ta = document.getElementById('notes-area');
  var sel = ta.value.slice(mdLinkSelStart, mdLinkSelEnd) || 'link text';
  var replacement = '[' + sel + '](' + url + ')';
  ta.value = ta.value.slice(0, mdLinkSelStart) + replacement + ta.value.slice(mdLinkSelEnd);
  ta.selectionStart = mdLinkSelStart;
  ta.selectionEnd = mdLinkSelStart + replacement.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function closeLinkBar() {
  document.getElementById('md-link-bar').style.display = 'none';
  document.getElementById('notes-area').focus();
}

document.getElementById('md-toolbar').addEventListener('click', function(e) {
  var btn = e.target.closest('.md-btn');
  if (!btn) return;
  e.stopPropagation();
  var ta = document.getElementById('notes-area');
  if (btn.classList.contains('md-link-btn')) {
    mdLinkSelStart = ta.selectionStart;
    mdLinkSelEnd   = ta.selectionEnd;
    var bar = document.getElementById('md-link-bar');
    bar.style.display = 'flex';
    var inp = document.getElementById('md-link-input');
    inp.value = '';
    inp.focus();
    return;
  }
  var wrap = btn.dataset.wrap;
  if (wrap === 'u')  { mdWrap('<u>', '</u>'); }
  else if (wrap)     { mdWrap(wrap); }
});

document.getElementById('md-link-ok').addEventListener('click', insertLink);
document.getElementById('md-link-cancel').addEventListener('click', closeLinkBar);
document.getElementById('md-link-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter')  { e.preventDefault(); insertLink(); }
  if (e.key === 'Escape') { closeLinkBar(); }
});

// -- Notes drag-drop from evidence list ----------------------------------------
var notesArea = document.getElementById('notes-area');
notesArea.addEventListener('dragover', function(e) {
  if (!draggingEv) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'link';
});
notesArea.addEventListener('drop', function(e) {
  if (!draggingEv) return;
  e.preventDefault();
  insertAtCursor(this, buildEvidenceRef(draggingEv));
});

var TYPE_SHORT = {'thread-dump':'TD','log-export':'LOG','top-output':'TOP','screenshot':'IMG','generic':'FILE'};

function getOrCreateGroup(groupName) {
  if (groupEls[groupName]) return groupEls[groupName];
  var grp = document.createElement('div');
  grp.className = 'ev-group';
  var hdr = document.createElement('div');
  hdr.className = 'ev-group-hdr';
  hdr.innerHTML =
    '<span class="ev-group-icon">&#x25BE;</span>'+
    '<span class="ev-group-name">'+esc(groupName)+'</span>'+
    '<span class="ev-group-cnt">0</span>'+
    '<button class="ev-group-del" title="Delete group">&#x2715;</button>';
  hdr.querySelector('.ev-group-del').addEventListener('click', function(e) {
    e.stopPropagation();
    send('deleteGroup', { group: groupName });
  });
  hdr.addEventListener('click', function(e) {
    if (e.target.classList.contains('ev-group-del')) return;
    grp.classList.toggle('collapsed');
  });
  var body = document.createElement('div');
  body.className = 'ev-group-body';
  grp.appendChild(hdr);
  grp.appendChild(body);
  document.getElementById('ev-list').appendChild(grp);
  groupEls[groupName] = grp;
  return grp;
}

function addEvidence(item) {
  items.push(item);
  var t = new Date(item.timestamp);
  // Within a group, strip the group prefix from the display name
  var displayName = (item.group && item.name.indexOf(item.group + '/') === 0)
    ? item.name.slice(item.group.length + 1)
    : item.name;
  var row = document.createElement('div');
  row.className = 'ev-item';
  row.title = item.name;
  row.dataset.evId = item.id;
  row.innerHTML =
    '<input type="checkbox" class="ev-check">'+
    '<span class="ev-type">'+(TYPE_SHORT[item.type]||'FILE')+'</span>'+
    '<span class="ev-name">'+esc(displayName)+'</span>'+
    '<span class="ev-time">'+fmt(t)+'</span>'+
    '<button class="ev-ext" title="Open in editor">&#x2197;</button>'+
    '<button class="ev-del" title="Remove">&#x2715;</button>';

  var evCheck = row.querySelector('.ev-check');
  evCheck.addEventListener('click', function(e) { e.stopPropagation(); });
  evCheck.addEventListener('change', function() {
    if (evCheck.checked) { selectedEvIds.add(item.id); row.classList.add('selected'); }
    else { selectedEvIds.delete(item.id); row.classList.remove('selected'); }
    updateEvSelectBar();
  });

  row.querySelector('.ev-ext').addEventListener('click', function(e) {
    e.stopPropagation();
    send('openEvidence', { id: item.id });
  });
  row.querySelector('.ev-del').addEventListener('click', function(e) {
    e.stopPropagation();
    send('deleteEvidence', { id: item.id });
  });

  row.addEventListener('click', function(e) {
    if (e.target.classList.contains('ev-del') || e.target.classList.contains('ev-ext') || e.target.classList.contains('ev-check')) return;
    openInViewer(item.id, item.name);
  });

  row.draggable = true;
  row.addEventListener('dragstart', function(e) {
    draggingEv = item;
    e.dataTransfer.effectAllowed = 'link';
    e.dataTransfer.setData('text/plain', buildEvidenceRef(item));
  });
  row.addEventListener('dragend', function() { draggingEv = null; });

  var wrapper = document.createElement('div');
  wrapper.dataset.evId = item.id;
  if (item.group) wrapper.dataset.evGroup = item.group;
  wrapper.appendChild(row);

  if (item.group) {
    var grp = getOrCreateGroup(item.group);
    var body = grp.querySelector('.ev-group-body');
    var cnt = grp.querySelector('.ev-group-cnt');
    body.appendChild(wrapper);
    if (cnt) cnt.textContent = String(body.children.length);
  } else {
    document.getElementById('ev-list').appendChild(wrapper);
  }
}

// -- Multi-pane Viewer ---------------------------------------------------------
var viewerPanes = []; // [{ paneId, evId, el }]

function openInViewer(evId, name) {
  // If already open in a pane, scroll to it
  var existing = viewerPanes.find(function(p) { return p.evId === evId; });
  if (existing) {
    existing.el.scrollIntoView({ behavior: 'smooth' });
    markActiveEv(evId);
    return;
  }

  var paneId = 'vp-' + Date.now();
  var el = document.createElement('div');
  el.className = 'viewer-pane';
  el.dataset.paneId = paneId;
  el.dataset.evId = evId;
  el.innerHTML =
    '<div class="viewer-pane-hdr">'+
      '<span class="viewer-lbl loaded" id="lbl-'+paneId+'">'+esc(name)+'</span>'+
      '<button class="btn pane-open-btn" title="Open in editor" style="font-size:10px;padding:1px 5px;text-transform:none;letter-spacing:0;font-weight:400">Open &#x2197;</button>'+
      '<button class="btn pane-close-btn" title="Close pane" style="font-size:10px;padding:1px 5px;text-transform:none;letter-spacing:0;font-weight:400">&#x2715;</button>'+
    '</div>'+
    '<div class="pane-search" id="search-'+paneId+'">'+
      '<input class="pane-search-input" id="search-input-'+paneId+'" placeholder="Search in file..." autocomplete="off" spellcheck="false">'+
      '<span class="pane-search-count" id="search-count-'+paneId+'"></span>'+
      '<button class="pane-search-nav pane-search-prev" title="Previous (Shift+Enter)">&#x2191;</button>'+
      '<button class="pane-search-nav pane-search-next" title="Next (Enter)">&#x2193;</button>'+
    '</div>'+
    '<div class="viewer-content" id="vcontent-'+paneId+'"><div class="viewer-empty">Loading...</div></div>';

  el.querySelector('.pane-open-btn').addEventListener('click', function() {
    extOpenPane(paneId);
  });
  el.querySelector('.pane-close-btn').addEventListener('click', function(e) {
    closePane(e, paneId);
  });

  var searchInput = el.querySelector('.pane-search-input');
  searchInput.addEventListener('input', debounce(function() { runPaneSearch(paneId); }, 300));
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); navPaneMatch(paneId, e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { searchInput.value = ''; runPaneSearch(paneId); }
  });
  el.querySelector('.pane-search-prev').addEventListener('click', function() { navPaneMatch(paneId, -1); });
  el.querySelector('.pane-search-next').addEventListener('click', function() { navPaneMatch(paneId, 1); });

  var body = document.getElementById('viewer-body');
  document.getElementById('viewer-empty-state').style.display = 'none';
  body.appendChild(el);
  viewerPanes.push({ paneId: paneId, evId: evId, el: el });

  send('viewEvidence', { id: evId, paneId: paneId });
  markActiveEv(evId);
}

function closePane(e, paneId) {
  if (e) e.stopPropagation();
  var idx = viewerPanes.findIndex(function(p) { return p.paneId === paneId; });
  if (idx === -1) return;
  var evId = viewerPanes[idx].evId;
  viewerPanes[idx].el.remove();
  viewerPanes.splice(idx, 1);
  delete paneRawText[paneId];
  if (viewerPanes.length === 0) {
    document.getElementById('viewer-empty-state').style.display = '';
  }
  // Remove active class if no remaining pane shows this evidence
  if (!viewerPanes.find(function(p) { return p.evId === evId; })) {
    var row = document.querySelector('.ev-item[data-ev-id="'+evId+'"]');
    if (row) row.classList.remove('active');
  }
}

function extOpenPane(paneId) {
  var pane = viewerPanes.find(function(p) { return p.paneId === paneId; });
  if (pane) send('openEvidence', { id: pane.evId });
}

function markActiveEv(evId) {
  document.querySelectorAll('.ev-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.evId === evId);
  });
}

var paneRawText = {}; // paneId -> original text, kept for re-search without re-fetch

function renderViewerContent(paneId, evId, name, content, contentType) {
  var contentEl = document.getElementById('vcontent-' + paneId);
  var searchEl  = document.getElementById('search-' + paneId);
  if (!contentEl) return;
  if (!content) {
    contentEl.innerHTML = '<div class="viewer-empty">No content available for this file.</div>';
    if (searchEl) searchEl.classList.remove('visible');
    return;
  }
  if (contentType === 'image') {
    contentEl.innerHTML = '<img src="'+content+'" alt="'+esc(name)+'">';
    if (searchEl) searchEl.classList.remove('visible');
  } else {
    paneRawText[paneId] = content;
    contentEl.innerHTML = '<pre>' + esc(content) + '</pre>';
    if (searchEl) searchEl.classList.add('visible');
  }
}

// Applies query to a single pane and returns total match count.
// Pass noAutoFocus=true when driving from global search.
function applyPaneQuery(paneId, query, noAutoFocus) {
  var countEl   = document.getElementById('search-count-' + paneId);
  var contentEl = document.getElementById('vcontent-' + paneId);
  if (!contentEl) return 0;
  var rawText = paneRawText[paneId];
  if (rawText === undefined) return 0;

  if (!query) {
    contentEl.innerHTML = '<pre>' + esc(rawText) + '</pre>';
    if (countEl) countEl.textContent = '';
    contentEl.dataset.matchIdx = '0';
    return 0;
  }

  var lower  = rawText.toLowerCase();
  var lowerQ = query.toLowerCase();
  var qLen   = lowerQ.length;
  if (qLen === 0) return 0;

  // Collect all match positions via indexOf (fast, no DOM writes)
  var positions = [];
  var p = lower.indexOf(lowerQ);
  while (p !== -1) {
    positions.push(p);
    p = lower.indexOf(lowerQ, p + qLen);
  }

  if (positions.length === 0) {
    contentEl.innerHTML = '<pre>' + esc(rawText) + '</pre>';
    if (countEl) countEl.textContent = 'no results';
    contentEl.dataset.matchIdx = '0';
    return 0;
  }

  // Build full HTML with marks inserted at match positions
  var html = '';
  var i = 0;
  for (var k = 0; k < positions.length; k++) {
    var pos = positions[k];
    if (pos > i) html += esc(rawText.slice(i, pos));
    html += '<mark class="search-match">' + esc(rawText.slice(pos, pos + qLen)) + '</mark>';
    i = pos + qLen;
  }
  if (i < rawText.length) html += esc(rawText.slice(i));
  contentEl.innerHTML = '<pre>' + html + '</pre>';
  contentEl.dataset.matchIdx = '0';

  if (countEl) countEl.textContent = noAutoFocus ? String(positions.length) : '1 / ' + positions.length;
  if (!noAutoFocus) {
    var marks = contentEl.querySelectorAll('.search-match');
    if (marks.length > 0) {
      marks[0].classList.add('active-match');
      marks[0].scrollIntoView({ block: 'nearest' });
    }
  }
  return positions.length;
}

function runPaneSearch(paneId) {
  var input = document.getElementById('search-input-' + paneId);
  if (!input) return;
  applyPaneQuery(paneId, input.value);
}

function navPaneMatch(paneId, dir) {
  var contentEl = document.getElementById('vcontent-' + paneId);
  var countEl   = document.getElementById('search-count-' + paneId);
  if (!contentEl) return;
  var marks = Array.from(contentEl.querySelectorAll('.search-match'));
  if (!marks.length) return;
  var cur  = parseInt(contentEl.dataset.matchIdx || '0', 10);
  marks[cur].classList.remove('active-match');
  var next = (cur + dir + marks.length) % marks.length;
  marks[next].classList.add('active-match');
  marks[next].scrollIntoView({ block: 'nearest' });
  contentEl.dataset.matchIdx = String(next);
  if (countEl) countEl.textContent = (next + 1) + ' / ' + marks.length;
}

function removeEvidence(id) {
  selectedEvIds.delete(id);
  updateEvSelectBar();
  items = items.filter(function(i) { return i.id !== id; });
  var wrapper = document.querySelector('[data-ev-id="'+id+'"]');
  if (wrapper) {
    var groupName = wrapper.dataset.evGroup;
    wrapper.remove();
    if (groupName && groupEls[groupName]) {
      var grp = groupEls[groupName];
      var body = grp.querySelector('.ev-group-body');
      var cnt = grp.querySelector('.ev-group-cnt');
      if (body) {
        if (cnt) cnt.textContent = String(body.children.length);
        if (body.children.length === 0) { grp.remove(); delete groupEls[groupName]; }
      }
    }
  }
  viewerPanes.filter(function(p) { return p.evId === id; })
    .map(function(p) { return p.paneId; })
    .forEach(function(pid) { closePane(null, pid); });
}

function removeGroup(groupName) {
  var grp = groupEls[groupName];
  if (!grp) return;
  var wrappers = grp.querySelectorAll('[data-ev-id]');
  wrappers.forEach(function(w) {
    var evId = w.dataset.evId;
    items = items.filter(function(i) { return i.id !== evId; });
    viewerPanes.filter(function(p) { return p.evId === evId; })
      .map(function(p) { return p.paneId; })
      .forEach(function(pid) { closePane(null, pid); });
  });
  grp.remove();
  delete groupEls[groupName];
}

function delEvidence(e, id) {
  e.stopPropagation();
  send('deleteEvidence', { id: id });
}

function openInEditor(e, id) {
  e.stopPropagation();
  send('openEvidence', { id: id });
}

// -- Context menu --------------------------------------------------------------
var ctxEvId = null;
var ctxMenu = document.getElementById('ctx-menu');

document.addEventListener('contextmenu', function(e) {
  var evItem = e.target.closest('.ev-item');
  if (!evItem) { hideCtxMenu(); return; }
  e.preventDefault();
  ctxEvId = evItem.dataset.evId;
  // Keep menu inside viewport
  var menuW = 180, menuH = 140;
  var x = Math.min(e.clientX, window.innerWidth - menuW - 4);
  var y = Math.min(e.clientY, window.innerHeight - menuH - 4);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';
  ctxMenu.style.display = 'block';
});

document.addEventListener('click', function() { hideCtxMenu(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') hideCtxMenu(); });

function hideCtxMenu() { ctxMenu.style.display = 'none'; ctxEvId = null; }

document.getElementById('ctx-open').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) send('openEvidence', { id: ctxEvId });
  hideCtxMenu();
});

document.getElementById('ctx-rename').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) send('renameEvidence', { id: ctxEvId });
  hideCtxMenu();
});

document.getElementById('ctx-copy-ref').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) {
    var it = items.find(function(i) { return i.id === ctxEvId; });
    if (it) {
      var ref = buildEvidenceRef(it);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ref).catch(function() { fallbackCopy(ref); });
      } else {
        fallbackCopy(ref);
      }
    }
  }
  hideCtxMenu();
});

document.getElementById('ctx-ai-review').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) send('reviewEvidenceWithAI', { id: ctxEvId });
  hideCtxMenu();
});

document.getElementById('ctx-delete').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) send('deleteEvidence', { id: ctxEvId });
  hideCtxMenu();
});

// -- Analysis section ----------------------------------------------------------
var analysisOpen = false;

function toggleAnalysis() {
  analysisOpen = !analysisOpen;
  document.getElementById('analysis-body').style.display = analysisOpen ? 'block' : 'none';
  document.getElementById('analysis-chevron').style.transform = analysisOpen ? 'rotate(90deg)' : '';
}

function renderFindings(findings) {
  var section = document.getElementById('analysis-section');
  var body = document.getElementById('analysis-body');
  if (!findings || !findings.length) {
    section.style.display = 'none';
    body.innerHTML = '';
    document.getElementById('analysis-cnt').textContent = '0';
    return;
  }
  section.style.display = 'block';
  document.getElementById('analysis-cnt').textContent = String(findings.length);
  body.innerHTML = findings.map(cardHtml).join('');
}

function cardHtml(f) {
  var evHtml = f.evidence.map(function(e){return '<div>'+esc(e)+'</div>';}).join('');
  var stepsHtml = f.nextSteps.map(function(s){return '<button class="btn">'+esc(s)+'</button>';}).join('');
  var relHtml = f.relatedSignatures&&f.relatedSignatures.length
    ? '<div class="related">Related: '+f.relatedSignatures.map(esc).join(', ')+'</div>' : '';
  var fj = escAttr(JSON.stringify(f));
  return '<div class="card">'+
    '<div class="card-header" data-action="toggle-card">'+
      '<span class="badge '+f.confidence+'">'+f.confidence.toUpperCase()+'</span>'+
      '<span class="card-name">'+esc(f.signatureName)+'</span>'+
      '<span class="chevron">&#x203A;</span>'+
    '</div>'+
    '<div class="card-body">'+
      '<div class="ev-lines">'+evHtml+'</div>'+
      '<div class="actions">'+stepsHtml+
        '<button class="btn accent" data-action="openSignatureBuilder" data-finding="'+fj+'">Save as Signature</button>'+
        '<button class="btn" data-action="askClaude" data-sig-id="'+escAttr(f.signatureId)+'"> Ask Claude</button>'+
      '</div>'+relHtml+
    '</div>'+
  '</div>';
}

function toggle(card) { card.classList.toggle('open'); }



function fmt(d){return String(d.getHours()).padStart(2,'0')+'h'+String(d.getMinutes()).padStart(2,'0');}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escAttr(s){return String(s).replace(/'/g,'&#39;').replace(/"/g,'&quot;');}
function noop(){}

// -- Markdown renderer ---------------------------------------------------------

// Finds the closing ) of a markdown link/image href, correctly handling nested parens.
function findLinkEnd(text, start) {
  var depth = 0;
  for (var j = start; j < text.length; j++) {
    var ch = text[j];
    if (ch === '(') { depth++; }
    else if (ch === ')') {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

function inlineRender(text) {
  var out = '';
  var i = 0;
  while (i < text.length) {
    var c = text[i];
    if (c === '&') { out += '&amp;'; i++; continue; }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }

    // Inline code  (\` inside template literal = backtick in output)
    if (c === '\`') {
      var e1 = text.indexOf('\`', i + 1);
      if (e1 === -1) { out += '\`'; i++; continue; }
      out += '<code>' + esc(text.slice(i + 1, e1)) + '</code>';
      i = e1 + 1; continue;
    }

    // Bold+italic ***
    if (c === '*' && text[i+1] === '*' && text[i+2] === '*') {
      var e2 = text.indexOf('***', i + 3);
      if (e2 === -1) { out += '*'; i++; continue; }
      out += '<strong><em>' + esc(text.slice(i + 3, e2)) + '</em></strong>';
      i = e2 + 3; continue;
    }
    // Bold **
    if (c === '*' && text[i+1] === '*') {
      var e3 = text.indexOf('**', i + 2);
      if (e3 === -1) { out += '*'; i++; continue; }
      out += '<strong>' + esc(text.slice(i + 2, e3)) + '</strong>';
      i = e3 + 2; continue;
    }
    // Italic *
    if (c === '*') {
      var e4 = text.indexOf('*', i + 1);
      if (e4 === -1) { out += '*'; i++; continue; }
      out += '<em>' + esc(text.slice(i + 1, e4)) + '</em>';
      i = e4 + 1; continue;
    }

    // Image ![alt](src)
    if (c === '!' && text[i+1] === '[') {
      var imgBEnd = text.indexOf(']', i + 2);
      if (imgBEnd !== -1 && text[imgBEnd + 1] === '(') {
        var imgPEnd = findLinkEnd(text, imgBEnd + 2);
        if (imgPEnd !== -1) {
          var imgAlt = text.slice(i + 2, imgBEnd);
          var imgSrc = text.slice(imgBEnd + 2, imgPEnd);
          out += '<img src="" data-preview-src="' + escAttr(imgSrc) + '" alt="' + esc(imgAlt) + '" class="preview-img">';
          i = imgPEnd + 1; continue;
        }
      }
      out += '!'; i++; continue;
    }

    // Link [label](href) - image exts render inline; local text files show as badge (content in refs panel); else link
    if (c === '[') {
      var bEnd = text.indexOf(']', i + 1);
      if (bEnd !== -1 && text[bEnd + 1] === '(') {
        var pEnd = findLinkEnd(text, bEnd + 2);
        if (pEnd !== -1) {
          var linkHref = text.slice(bEnd + 2, pEnd);
          var linkLabel = text.slice(i + 1, bEnd);
          var lh = linkHref.toLowerCase();
          var isLocal = lh.startsWith('./') || lh.startsWith('../');
          if (lh.endsWith('.png') || lh.endsWith('.jpg') || lh.endsWith('.jpeg') || lh.endsWith('.gif') || lh.endsWith('.webp')) {
            out += '<img src="" data-preview-src="' + escAttr(linkHref) + '" alt="' + esc(linkLabel) + '" class="preview-img">';
          } else if (isLocal) {
            var fname = linkHref.split('/').pop();
            out += '<span class="emb-ref-link">' + esc(fname) + '</span>';
          } else {
            out += '<a href="' + esc(linkHref) + '">' + esc(linkLabel) + '</a>';
          }
          i = pEnd + 1; continue;
        }
      }
      out += '['; i++; continue;
    }

    out += c; i++;
  }
  return out;
}

function renderMd(src) {
  var lines = src.split('\\n');
  var out = '';
  var inFence = false;
  var inUl = false;
  var inOl = false;

  function closeList() {
    if (inUl) { out += '</ul>'; inUl = false; }
    if (inOl) { out += '</ol>'; inOl = false; }
  }

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var trimmed = line.trim();

    // Code fence (\`\`\` = three backticks in output)
    if (line.slice(0, 3) === '\`\`\`') {
      closeList();
      if (inFence) { out += '</code></pre>'; inFence = false; }
      else { out += '<pre><code>'; inFence = true; }
      continue;
    }
    if (inFence) { out += esc(line) + '\\n'; continue; }

    // Heading: count leading '#' chars followed by space
    var hLv = 0;
    while (hLv < 6 && line[hLv] === '#') hLv++;
    if (hLv > 0 && line[hLv] === ' ') {
      closeList();
      out += '<h' + hLv + '>' + inlineRender(line.slice(hLv + 1)) + '</h' + hLv + '>';
      continue;
    }

    // Horizontal rule
    if (trimmed === '---' || trimmed === '***') {
      closeList(); out += '<hr>'; continue;
    }

    // Unordered list: '- ' or '* '
    if (line.slice(0, 2) === '- ' || line.slice(0, 2) === '* ') {
      if (inOl) { out += '</ol>'; inOl = false; }
      if (!inUl) { out += '<ul>'; inUl = true; }
      out += '<li>' + inlineRender(line.slice(2)) + '</li>';
      continue;
    }

    // Ordered list: digit(s) + '. '
    var d = 0;
    while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
    if (d > 0 && line[d] === '.' && line[d + 1] === ' ') {
      if (inUl) { out += '</ul>'; inUl = false; }
      if (!inOl) { out += '<ol>'; inOl = true; }
      out += '<li>' + inlineRender(line.slice(d + 2)) + '</li>';
      continue;
    }

    // Blank line
    if (trimmed === '') { closeList(); out += '<p></p>'; continue; }

    // Paragraph
    closeList();
    out += '<p>' + inlineRender(line) + '</p>';
  }

  closeList();
  if (inFence) out += '</code></pre>';
  return out;
}

// Inline renderer for JIRA HTML export: produces clean HTML with no webview-specific attrs.
// Local image/file links become plain text (filename), external links become <a> tags.
function inlineRenderJira(text) {
  var out = '';
  var i = 0;
  while (i < text.length) {
    var c = text[i];
    if (c === '&') { out += '&amp;'; i++; continue; }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '\`') {
      var e1 = text.indexOf('\`', i + 1);
      if (e1 === -1) { out += '\`'; i++; continue; }
      out += '<code>' + esc(text.slice(i + 1, e1)) + '</code>';
      i = e1 + 1; continue;
    }
    if (c === '*' && text[i+1] === '*' && text[i+2] === '*') {
      var e2 = text.indexOf('***', i + 3);
      if (e2 === -1) { out += '*'; i++; continue; }
      out += '<strong><em>' + esc(text.slice(i + 3, e2)) + '</em></strong>';
      i = e2 + 3; continue;
    }
    if (c === '*' && text[i+1] === '*') {
      var e3 = text.indexOf('**', i + 2);
      if (e3 === -1) { out += '*'; i++; continue; }
      out += '<strong>' + esc(text.slice(i + 2, e3)) + '</strong>';
      i = e3 + 2; continue;
    }
    if (c === '*') {
      var e4 = text.indexOf('*', i + 1);
      if (e4 === -1) { out += '*'; i++; continue; }
      out += '<em>' + esc(text.slice(i + 1, e4)) + '</em>';
      i = e4 + 1; continue;
    }
    // Image or link: local refs become plain filename text, external become <a>
    if (c === '!' && text[i+1] === '[') {
      var imgBEnd = text.indexOf(']', i + 2);
      if (imgBEnd !== -1 && text[imgBEnd + 1] === '(') {
        var imgPEnd = findLinkEnd(text, imgBEnd + 2);
        if (imgPEnd !== -1) {
          var imgAlt = text.slice(i + 2, imgBEnd);
          out += esc(imgAlt || text.slice(imgBEnd + 2, imgPEnd).split('/').pop());
          i = imgPEnd + 1; continue;
        }
      }
      out += '!'; i++; continue;
    }
    if (c === '[') {
      var bEnd = text.indexOf(']', i + 1);
      if (bEnd !== -1 && text[bEnd + 1] === '(') {
        var pEnd = findLinkEnd(text, bEnd + 2);
        if (pEnd !== -1) {
          var linkHref = text.slice(bEnd + 2, pEnd);
          var linkLabel = text.slice(i + 1, bEnd);
          var isLocal = linkHref.startsWith('./') || linkHref.startsWith('../');
          if (isLocal) {
            out += esc(linkHref.split('/').pop());
          } else {
            out += '<a href="' + esc(linkHref) + '">' + esc(linkLabel) + '</a>';
          }
          i = pEnd + 1; continue;
        }
      }
      out += '['; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// Renders markdown to clean HTML for pasting into JIRA's TinyMCE rich-text editor.
function renderMdForJira(src) {
  var lines = src.split('\\n');
  var out = '';
  var inFence = false;
  var inUl = false;
  var inOl = false;

  function closeList() {
    if (inUl) { out += '</ul>'; inUl = false; }
    if (inOl) { out += '</ol>'; inOl = false; }
  }

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var trimmed = line.trim();
    if (line.slice(0, 3) === '\`\`\`') {
      closeList();
      if (inFence) { out += '</code></pre>'; inFence = false; }
      else { out += '<pre><code>'; inFence = true; }
      continue;
    }
    if (inFence) { out += esc(line) + '\\n'; continue; }
    var hLv = 0;
    while (hLv < 6 && line[hLv] === '#') hLv++;
    if (hLv > 0 && line[hLv] === ' ') {
      closeList();
      out += '<h' + hLv + '>' + inlineRenderJira(line.slice(hLv + 1)) + '</h' + hLv + '>';
      continue;
    }
    if (trimmed === '---' || trimmed === '***') { closeList(); out += '<hr>'; continue; }
    if (line.slice(0, 2) === '- ' || line.slice(0, 2) === '* ') {
      if (inOl) { out += '</ol>'; inOl = false; }
      if (!inUl) { out += '<ul>'; inUl = true; }
      out += '<li>' + inlineRenderJira(line.slice(2)) + '</li>';
      continue;
    }
    var d = 0;
    while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
    if (d > 0 && line[d] === '.' && line[d + 1] === ' ') {
      if (inUl) { out += '</ul>'; inUl = false; }
      if (!inOl) { out += '<ol>'; inOl = true; }
      out += '<li>' + inlineRenderJira(line.slice(d + 2)) + '</li>';
      continue;
    }
    if (trimmed === '') { closeList(); out += '<p></p>'; continue; }
    closeList();
    out += '<p>' + inlineRenderJira(line) + '</p>';
  }

  closeList();
  if (inFence) out += '</code></pre>';
  return out;
}

// -- Markdown preview toggle ---------------------------------------------------
var previewMode = false;

function togglePreview() {
  previewMode = !previewMode;
  var ta  = document.getElementById('notes-area');
  var pv  = document.getElementById('notes-preview');
  var btn = document.getElementById('preview-btn');
  var tb  = document.getElementById('md-toolbar');
  var lb  = document.getElementById('md-link-bar');
  if (previewMode) {
    pv.innerHTML = renderMd(ta.value);
    var pvImgEls = pv.querySelectorAll('img.preview-img');
    for (var pvii = 0; pvii < pvImgEls.length; pvii++) {
      var pvSrc = pvImgEls[pvii].getAttribute('data-preview-src');
      if (pvSrc) send('loadPreviewImage', { src: pvSrc });
    }
    ta.style.display = 'none';
    pv.style.display = 'block';
    if (tb) tb.style.display = 'none';
    if (lb) lb.style.display = 'none';
    btn.textContent = 'Edit';
    btn.classList.add('active');
  } else {
    ta.style.display = '';
    pv.style.display = 'none';
    if (tb) tb.style.display = '';
    btn.textContent = 'Preview';
    btn.classList.remove('active');
  }
}

document.getElementById('preview-btn').addEventListener('click', function(e) {
  e.stopPropagation();
  togglePreview();
});

// Prevent link navigation in preview (links are for visual reference only)
document.getElementById('notes-preview').addEventListener('click', function(e) {
  if (e.target && e.target.closest && e.target.closest('a')) e.preventDefault();
});

// Event delegation for dynamically-generated card actions in analysis body
document.getElementById('analysis-body').addEventListener('click', function(e) {
  var target = e.target;
  var action = target.dataset && target.dataset.action;
  if (!action) {
    // Walk up in case click landed on a child element
    var el = target.closest('[data-action]');
    if (el) { action = el.dataset.action; target = el; }
  }
  if (!action) return;
  if (action === 'toggle-card') {
    var card = target.closest('.card');
    if (card) card.classList.toggle('open');
  } else if (action === 'openSignatureBuilder') {
    try { send('openSignatureBuilder', { finding: JSON.parse(target.dataset.finding) }); } catch(err) {}
  } else if (action === 'askClaude') {
    send('askClaude', { signatureId: target.dataset.sigId });
  }
});

// Wire up static buttons via addEventListener (avoids inline-onclick scope issues)
function updateStatusButton(status) {
  var btn = document.getElementById('resolve-btn');
  if (!btn) return;
  if (status === 'resolved') {
    btn.textContent = 'Reopen';
    btn.dataset.caseStatus = 'resolved';
  } else {
    btn.textContent = 'Resolve';
    btn.dataset.caseStatus = 'open';
  }
}

// -- Multi-select delete -------------------------------------------------------
function updateEvSelectBar() {
  var bar = document.getElementById('ev-select-bar');
  var cnt = document.getElementById('ev-select-count');
  if (selectedEvIds.size > 0) {
    bar.classList.add('visible');
    cnt.textContent = selectedEvIds.size + ' selected';
  } else {
    bar.classList.remove('visible');
    cnt.textContent = '';
  }
}

document.getElementById('ev-delete-selected').addEventListener('click', function() {
  var ids = Array.from(selectedEvIds);
  selectedEvIds.clear();
  updateEvSelectBar();
  ids.forEach(function(id) { send('deleteEvidence', { id: id }); });
});

document.getElementById('ev-select-clear').addEventListener('click', function() {
  selectedEvIds.clear();
  document.querySelectorAll('.ev-check').forEach(function(cb) { cb.checked = false; });
  document.querySelectorAll('.ev-item.selected').forEach(function(el) { el.classList.remove('selected'); });
  updateEvSelectBar();
});

// -- Cross-pane global search --------------------------------------------------
function runGlobalSearch() {
  var query = document.getElementById('global-search-input').value;
  var cnt = document.getElementById('global-search-count');
  globalMatchList = [];
  globalMatchCur = 0;
  viewerPanes.forEach(function(p) {
    var n = applyPaneQuery(p.paneId, query, true);
    for (var k = 0; k < n; k++) { globalMatchList.push({ paneId: p.paneId, markIdx: k }); }
  });
  if (!query) { if (cnt) cnt.textContent = ''; return; }
  if (globalMatchList.length > 0) {
    focusGlobalMatch(0);
  } else {
    if (cnt) cnt.textContent = 'no results';
  }
}

function focusGlobalMatch(idx) {
  document.querySelectorAll('.search-match.active-match').forEach(function(el) { el.classList.remove('active-match'); });
  if (globalMatchList.length === 0) return;
  var match = globalMatchList[idx];
  var contentEl = document.getElementById('vcontent-' + match.paneId);
  if (!contentEl) return;
  var marks = contentEl.querySelectorAll('.search-match');
  var mark = marks[match.markIdx];
  if (mark) {
    mark.classList.add('active-match');
    mark.scrollIntoView({ block: 'nearest' });
  }
  var cnt = document.getElementById('global-search-count');
  if (cnt) cnt.textContent = (idx + 1) + ' / ' + globalMatchList.length;
}

function navGlobalMatch(dir) {
  if (globalMatchList.length === 0) return;
  globalMatchCur = (globalMatchCur + dir + globalMatchList.length) % globalMatchList.length;
  focusGlobalMatch(globalMatchCur);
}

(function() {
  var gi = document.getElementById('global-search-input');
  gi.addEventListener('input', debounce(runGlobalSearch, 300));
  gi.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); navGlobalMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { gi.value = ''; runGlobalSearch(); }
  });
  document.getElementById('global-search-prev').addEventListener('click', function() { navGlobalMatch(-1); });
  document.getElementById('global-search-next').addEventListener('click', function() { navGlobalMatch(1); });
})();

document.getElementById('add-evidence-btn').addEventListener('click', function() { send('addEvidence'); });
document.getElementById('resolve-btn').addEventListener('click', function() {
  if (this.dataset.caseStatus === 'resolved') {
    send('reopenCase');
  } else {
    send('resolveCase');
  }
});
document.getElementById('analysis-toggle').addEventListener('click', function() { toggleAnalysis(); });

// -- Evidence drag-and-drop from OS file system --------------------------------
(function() {
  var evCol = document.getElementById('col-evidence');

  evCol.addEventListener('dragover', function(e) {
    var hasFiles = false;
    for (var i = 0; i < e.dataTransfer.types.length; i++) {
      if (e.dataTransfer.types[i] === 'Files') { hasFiles = true; break; }
    }
    if (!hasFiles) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    evCol.classList.add('ev-drop-active');
  });

  evCol.addEventListener('dragleave', function(e) {
    if (evCol.contains(e.relatedTarget)) return;
    evCol.classList.remove('ev-drop-active');
  });

  evCol.addEventListener('drop', function(e) {
    evCol.classList.remove('ev-drop-active');
    var files = e.dataTransfer ? e.dataTransfer.files : null;
    if (!files || files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    var file = files[0];
    // Electron exposes a non-standard .path property with the OS filesystem path
    var fp = file.path || null;
    if (fp) {
      send('dropEvidence', { filePath: fp });
      return;
    }
    // Fallback: parse text/uri-list (file:///... URIs)
    var uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      var lines = uriList.split('\\n');
      for (var k = 0; k < lines.length; k++) {
        var line = lines[k].trim();
        if (line && line[0] !== '#') {
          send('dropEvidence', { uri: line });
          return;
        }
      }
    }
  });
})();

send('ready');
</script>
</body>
</html>`;
  }
}

// ── JIRA export helpers ────────────────────────────────────────────────────────

import type { CaseSession } from '../services/case-manager';

/** Returns the set of basenames referenced via relative markdown links in the notes. */
function getReferencedFilenames(notes: string): Set<string> {
  const refs = new Set<string>();
  const re = /\]\(\.[/\\]([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(notes)) !== null) {
    refs.add(path.basename(m[1]));
  }
  return refs;
}

function buildJiraExport(_session: CaseSession, notes: string): string {
  const MAX = 32767;
  let result = convertToJiraMarkup(notes);
  if (result.length > MAX) {
    result = result.slice(0, MAX - 22) + '\n\n_[content truncated]_';
  }
  return result;
}

const JIRA_IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg']);

function localHrefToJira(href: string): string {
  const base = path.basename(href.split('?')[0]);
  return JIRA_IMAGE_EXTS.has(path.extname(base).toLowerCase()) ? `!${base}!` : `[^${base}]`;
}

// Depth-counting link-end finder — mirrors client-side findLinkEnd.
// Handles URLs that contain balanced parentheses (e.g. Splunk query strings).
function findLinkEndServer(text: string, start: number): number {
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') { if (depth === 0) return j; depth--; }
  }
  return -1;
}

// Converts markdown image/link syntax to JIRA markup using a proper parser
// rather than a regex, so URLs with literal parentheses are handled correctly.
function convertLinksToJira(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    // Image: ![alt](src)
    if (text[i] === '!' && text[i + 1] === '[') {
      const altEnd = text.indexOf(']', i + 2);
      if (altEnd !== -1 && text[altEnd + 1] === '(') {
        const urlEnd = findLinkEndServer(text, altEnd + 2);
        if (urlEnd !== -1) {
          out += localHrefToJira(text.slice(altEnd + 2, urlEnd));
          i = urlEnd + 1;
          continue;
        }
      }
      out += text[i++];
      continue;
    }
    // Link: [text](href)
    if (text[i] === '[') {
      const textEnd = text.indexOf(']', i + 1);
      if (textEnd !== -1 && text[textEnd + 1] === '(') {
        const urlEnd = findLinkEndServer(text, textEnd + 2);
        if (urlEnd !== -1) {
          const linkText = text.slice(i + 1, textEnd);
          const href = text.slice(textEnd + 2, urlEnd);
          const lh = href.toLowerCase();
          const isLocal = lh.startsWith('./') || lh.startsWith('../');
          if (isLocal) {
            out += localHrefToJira(href);
          } else {
            // Escape any literal ] in the URL so it doesn't close JIRA's [text|url] syntax
            out += '[' + linkText + '|' + href.replace(/\]/g, '%5D') + ']';
          }
          i = urlEnd + 1;
          continue;
        }
      }
      out += text[i++];
      continue;
    }
    out += text[i++];
  }
  return out;
}

function convertToJiraMarkup(md: string): string {
  return convertLinksToJira(
    md
      .replace(/^######\s+(.+)$/gm, 'h6. $1')
      .replace(/^#####\s+(.+)$/gm,  'h5. $1')
      .replace(/^####\s+(.+)$/gm,   'h4. $1')
      .replace(/^###\s+(.+)$/gm,    'h3. $1')
      .replace(/^##\s+(.+)$/gm,     'h2. $1')
      .replace(/^#\s+(.+)$/gm,      'h1. $1')
      .replace(/\*\*\*(.+?)\*\*\*/g, '*_$1_*')
      .replace(/\*\*(.+?)\*\*/g,    '*$1*')
      .replace(/__(.+?)__/g,        '*$1*')
      .replace(/\*(.+?)\*/g,        '_$1_')
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, content) => {
        const body = content.trimEnd();
        return lang ? `{code:${lang}}\n${body}\n{code}` : `{code}\n${body}\n{code}`;
      })
      .replace(/`(.+?)`/g,          '{{$1}}')
      .replace(/^---+$/gm,          '----')
  );
}
