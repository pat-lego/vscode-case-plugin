import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CaseManager } from '../services/case-manager';
import { AnalysisService } from '../services/analysis-service';
import { BridgeServer } from '../services/bridge-server';

export class InvestigationWebview {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private context: vscode.ExtensionContext,
    private caseManager: CaseManager,
    private analysisService: AnalysisService,
    private bridgeServer: BridgeServer
  ) {
    this.caseManager.onFindingsChange(({ caseId, findings }) => {
      this.panels.get(caseId)?.webview.postMessage({ type: 'findings', findings });
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
        this.panels.get(caseId)?.webview.postMessage({
          type: 'evidenceAdded',
          item: { id: ev.id, name, type: ev.type, timestamp: ev.capturedAt.toISOString() }
        });
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
    panel.onDidDispose(() => this.panels.delete(caseId));
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.active) this.caseManager.setActiveCase(caseId);
    });
  }

  private async handleMessage(caseId: string, msg: Record<string, unknown>) {
    const panel = this.panels.get(caseId);
    if (!panel) return;

    switch (String(msg.type)) {
      case 'ready': {
        this.caseManager.refreshDiskEvidence(caseId);
        const session = this.caseManager.getSession(caseId);
        if (!session) return;
        panel.webview.postMessage({ type: 'bridgeStatus', connected: this.bridgeServer.isConnected() });
        panel.webview.postMessage({
          type: 'initialState',
          status: session.meta.status,
          evidence: session.meta.evidence.map(e => ({
            id: e.id,
            name: e.filePath ? path.basename(e.filePath) : e.id,
            type: e.type,
            timestamp: e.capturedAt instanceof Date && !isNaN(e.capturedAt.getTime())
              ? e.capturedAt.toISOString()
              : new Date().toISOString()
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
        for (const uri of uris) {
          const stat = fs.statSync(uri.fsPath);
          if (stat.isDirectory()) {
            this.addFolderEvidence(caseId, uri.fsPath, caseDir, panel);
          } else {
            const added = this.addFileEvidence(caseId, uri.fsPath, caseDir);
            if (added) panel.webview.postMessage({ type: 'evidenceAdded', item: added.item });
            if (added?.findings?.length) panel.webview.postMessage({ type: 'findings', findings: added.findings });
          }
        }
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
            content = text ? text.slice(0, 200000) : null;
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
    }
  }

  private addFileEvidence(caseId: string, filePath: string, caseDir: string | undefined): { item: { id: string; name: string; type: string; timestamp: string }; findings?: unknown[] } | null {
    const TEXT_EXTS = new Set(['.txt','.log','.tdump','.jfr','.md','.json','.xml','.csv','.yaml','.yml']);
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath);

    if (TEXT_EXTS.has(ext)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { evidenceItem, findings } = this.analysisService.processEvidence(caseId, name, content, filePath);
        return {
          item: { id: evidenceItem.id, name, type: evidenceItem.type, timestamp: evidenceItem.capturedAt.toISOString() },
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
    };
    this.caseManager.addEvidence(caseId, item as import('@incident-investigator/core').EvidenceItem);
    return { item: { id: item.id, name, type, timestamp: item.capturedAt.toISOString() } };
  }

  private addFolderEvidence(caseId: string, folderPath: string, caseDir: string | undefined, panel: vscode.WebviewPanel) {
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
              panel.webview.postMessage({ type: 'evidenceAdded', item: { id: evidenceItem.id, name: displayName, type: evidenceItem.type, timestamp: evidenceItem.capturedAt.toISOString() } });
              if (findings.length) panel.webview.postMessage({ type: 'findings', findings });
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
            };
            this.caseManager.addEvidence(caseId, item as import('@incident-investigator/core').EvidenceItem);
            panel.webview.postMessage({ type: 'evidenceAdded', item: { id: item.id, name: displayName, type: evType, timestamp: item.capturedAt.toISOString() } });
          }
        }
      }
    };
    if (caseDir) {
      try { fs.mkdirSync(path.join(caseDir, folderName), { recursive: true }); } catch {}
    }
    walk(folderPath, folderName);
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
.notes-area{flex:1;width:100%;resize:none;background:transparent;color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family,var(--vscode-font-family));font-size:var(--vscode-editor-font-size,var(--vscode-font-size));border:none;outline:none;padding:8px;line-height:1.6;box-sizing:border-box}
.notes-area::placeholder{color:var(--vscode-input-placeholderForeground)}
.save-indicator{font-size:9px;color:var(--vscode-descriptionForeground);opacity:0;transition:opacity .3s;padding-right:4px;cursor:default;text-transform:none;letter-spacing:0;font-weight:400}
.save-indicator.show{opacity:1}
.add-btn{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px;border:1px dashed var(--vscode-panel-border);border-radius:3px;font-size:11px;color:var(--vscode-descriptionForeground);cursor:pointer;background:none;width:100%;margin-bottom:6px}
.add-btn:hover{border-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
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
.timeline{height:50px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:5px 12px;flex-shrink:0}
.tl-label{font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:3px}
.tl-bar{height:16px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:2px;position:relative;overflow:hidden}
.tl-mark{position:absolute;width:2px;height:100%;background:var(--vscode-focusBorder);opacity:.7;cursor:pointer}
.tl-mark:hover{opacity:1}
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
</style>
</head>
<body>
<div class="header">
  <h2>${caseId} — <span id="case-title" contenteditable="true" spellcheck="false">${title}</span></h2>
  <div class="header-right">
    <div class="bridge"><div class="dot" id="dot"></div><span id="bridge-lbl">Disconnected</span></div>
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
      <button class="collapse-btn" data-collapse="notes" title="Collapse">&#x2039;</button>
    </div>
    <textarea class="notes-area" id="notes-area" placeholder="Write your investigation notes here&#x2026;&#10;&#10;What did you observe? What have you tried? What&#x27;s the current hypothesis?"></textarea>
  </div>
  <div class="resize-handle" id="handle-1"></div>
  <div class="col viewer" id="col-viewer">
    <div class="col-header" draggable="true" data-col="viewer">
      <span>Viewer<span class="col-drag-hint">drag to reorder</span></span>
      <button class="collapse-btn" data-collapse="viewer" title="Collapse">&#x2039;</button>
    </div>
    <div class="viewer-body" id="viewer-body">
      <div class="viewer-empty-state" id="viewer-empty-state">Click an evidence item to open it here.<br>Each item opens in its own pane.</div>
    </div>
  </div>
</div>

<div class="timeline">
  <div class="tl-label">Timeline</div>
  <div class="tl-bar" id="tl-bar"></div>
</div>

<!-- Context menu for evidence items -->
<div class="ctx-menu" id="ctx-menu">
  <div class="ctx-item" id="ctx-open">Open in Editor &#x2197;</div>
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

// ── Layout ────────────────────────────────────────────────────
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
    if (btn) btn.textContent = '›'; // ›
    if (hdr) hdr.removeAttribute('draggable');
  } else {
    if (col) col.classList.remove('collapsed');
    if (btn) btn.textContent = '‹'; // ‹
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

// ── Resize handles ────────────────────────────────────────────
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

// ── Drag-to-reorder ───────────────────────────────────────────
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

// ── Collapse delegation ───────────────────────────────
document.getElementById('workspace').addEventListener('click', function(e) {
  var btn = e.target && e.target.closest && e.target.closest('.collapse-btn');
  if (!btn || !btn.dataset || !btn.dataset.collapse) return;
  e.stopPropagation();
  toggleCollapse(btn.dataset.collapse);
});

try { loadLayout(); } catch(e) { /* stale state — ignore, use defaults */ }

// ── Messaging ─────────────────────────────────────────────────
function send(type, extra) { vscode.postMessage(Object.assign({type}, extra||{})); }

window.addEventListener('message', function(evt) {
  var m = evt.data;
  if (m.type === 'initialState') {
    m.evidence.forEach(addEvidence);
    renderFindings(m.findings);
    var ta = document.getElementById('notes-area');
    if (ta && m.notes) ta.value = m.notes;
    updateStatusButton(m.status);
  }
  else if (m.type === 'statusChanged') { updateStatusButton(m.status); }
  else if (m.type === 'evidenceAdded') addEvidence(m.item);
  else if (m.type === 'evidenceRemoved') removeEvidence(m.id);
  else if (m.type === 'findings') renderFindings(m.findings);
  else if (m.type === 'bridgeStatus') setBridge(m.connected);
  else if (m.type === 'evidenceView') renderViewerContent(m.paneId, m.id, m.name, m.content, m.contentType);
});

function doSaveNotes() {
  send('saveNotes', { notes: document.getElementById('notes-area').value });
  var ind = document.getElementById('save-indicator');
  if (ind) { ind.classList.add('show'); setTimeout(function() { ind.classList.remove('show'); }, 1200); }
}

document.getElementById('notes-area').addEventListener('input', function() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSaveNotes, 150);
});

document.getElementById('notes-area').addEventListener('blur', function() {
  clearTimeout(saveTimer);
  doSaveNotes();
});

// ── Editable case title ───────────────────────────────
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

var TYPE_SHORT = {'thread-dump':'TD','log-export':'LOG','top-output':'TOP','screenshot':'IMG','generic':'FILE'};

function addEvidence(item) {
  items.push(item);
  var t = new Date(item.timestamp);
  var row = document.createElement('div');
  row.className = 'ev-item';
  row.title = item.name;
  row.dataset.evId = item.id;
  row.innerHTML =
    '<span class="ev-type">'+(TYPE_SHORT[item.type]||'FILE')+'</span>'+
    '<span class="ev-name">'+esc(item.name)+'</span>'+
    '<span class="ev-time">'+fmt(t)+'</span>'+
    '<button class="ev-ext" title="Open in editor">&#x2197;</button>'+
    '<button class="ev-del" title="Remove">&#x2715;</button>';

  row.querySelector('.ev-ext').addEventListener('click', function(e) {
    e.stopPropagation();
    send('openEvidence', { id: item.id });
  });
  row.querySelector('.ev-del').addEventListener('click', function(e) {
    e.stopPropagation();
    send('deleteEvidence', { id: item.id });
  });

  row.addEventListener('click', function(e) {
    if (e.target.classList.contains('ev-del') || e.target.classList.contains('ev-ext')) return;
    openInViewer(item.id, item.name);
  });

  var wrapper = document.createElement('div');
  wrapper.dataset.evId = item.id;
  wrapper.appendChild(row);
  document.getElementById('ev-list').appendChild(wrapper);
  updateTimeline();
}

// ── Multi-pane Viewer ─────────────────────────────────────────
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
      '<input class="pane-search-input" id="search-input-'+paneId+'" placeholder="Search in file…" autocomplete="off" spellcheck="false">'+
      '<span class="pane-search-count" id="search-count-'+paneId+'"></span>'+
      '<button class="pane-search-nav pane-search-prev" title="Previous (Shift+Enter)">&#x2191;</button>'+
      '<button class="pane-search-nav pane-search-next" title="Next (Enter)">&#x2193;</button>'+
    '</div>'+
    '<div class="viewer-content" id="vcontent-'+paneId+'"><div class="viewer-empty">Loading…</div></div>';

  el.querySelector('.pane-open-btn').addEventListener('click', function() {
    extOpenPane(paneId);
  });
  el.querySelector('.pane-close-btn').addEventListener('click', function(e) {
    closePane(e, paneId);
  });

  var searchInput = el.querySelector('.pane-search-input');
  searchInput.addEventListener('input', function() { runPaneSearch(paneId); });
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

var paneRawText = {}; // paneId → original text, kept for re-search without re-fetch

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
    contentEl.innerHTML = '<pre>'+esc(content)+'</pre>';
    if (searchEl) searchEl.classList.add('visible');
  }
}

function runPaneSearch(paneId) {
  var input     = document.getElementById('search-input-' + paneId);
  var countEl   = document.getElementById('search-count-' + paneId);
  var contentEl = document.getElementById('vcontent-' + paneId);
  if (!input || !contentEl) return;
  var query   = input.value;
  var rawText = paneRawText[paneId];
  if (rawText === undefined) return;

  if (!query) {
    contentEl.innerHTML = '<pre>' + esc(rawText) + '</pre>';
    if (countEl) countEl.textContent = '';
    return;
  }

  // Build highlighted HTML by scanning the raw text for case-insensitive matches
  var lower  = rawText.toLowerCase();
  var lowerQ = query.toLowerCase();
  var html = '';
  var i = 0;
  var count = 0;
  while (i <= rawText.length) {
    var idx = lower.indexOf(lowerQ, i);
    if (idx === -1) { html += esc(rawText.slice(i)); break; }
    if (idx > i) html += esc(rawText.slice(i, idx));
    html += '<mark class="search-match">' + esc(rawText.slice(idx, idx + query.length)) + '</mark>';
    count++;
    i = idx + query.length;
    if (lowerQ.length === 0) break; // safety — empty query already handled above
  }
  contentEl.innerHTML = '<pre>' + html + '</pre>';
  contentEl.dataset.matchIdx = '0';

  var marks = contentEl.querySelectorAll('.search-match');
  if (marks.length > 0) {
    marks[0].classList.add('active-match');
    marks[0].scrollIntoView({ block: 'nearest' });
    if (countEl) countEl.textContent = '1 / ' + count;
  } else {
    if (countEl) countEl.textContent = 'no results';
  }
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
  items = items.filter(function(i) { return i.id !== id; });
  var wrapper = document.querySelector('[data-ev-id="'+id+'"]');
  if (wrapper) wrapper.remove();
  // Close any viewer panes showing this evidence
  viewerPanes.filter(function(p) { return p.evId === id; })
    .map(function(p) { return p.paneId; })
    .forEach(function(pid) { closePane(null, pid); });
  updateTimeline();
}

function delEvidence(e, id) {
  e.stopPropagation();
  send('deleteEvidence', { id: id });
}

function openInEditor(e, id) {
  e.stopPropagation();
  send('openEvidence', { id: id });
}

// ── Context menu ──────────────────────────────────────────────
var ctxEvId = null;
var ctxMenu = document.getElementById('ctx-menu');

document.addEventListener('contextmenu', function(e) {
  var evItem = e.target.closest('.ev-item');
  if (!evItem) { hideCtxMenu(); return; }
  e.preventDefault();
  ctxEvId = evItem.dataset.evId;
  // Keep menu inside viewport
  var menuW = 160, menuH = 80;
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

document.getElementById('ctx-delete').addEventListener('click', function(e) {
  e.stopPropagation();
  if (ctxEvId) send('deleteEvidence', { id: ctxEvId });
  hideCtxMenu();
});

// ── Analysis section ──────────────────────────────────────────
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

function updateTimeline() {
  if(!items.length) return;
  var ts = items.map(function(e){return new Date(e.timestamp).getTime();});
  var lo=Math.min.apply(null,ts), hi=Math.max.apply(null,ts), span=hi-lo||1;
  document.getElementById('tl-bar').innerHTML = items.map(function(e){
    var pct = ((new Date(e.timestamp).getTime()-lo)/span*92+4).toFixed(1);
    return '<div class="tl-mark" style="left:'+pct+'%" title="'+esc(e.name)+' '+fmt(new Date(e.timestamp))+'"></div>';
  }).join('');
}

function fmt(d){return String(d.getHours()).padStart(2,'0')+'h'+String(d.getMinutes()).padStart(2,'0');}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escAttr(s){return String(s).replace(/'/g,'&#39;').replace(/"/g,'&quot;');}
function noop(){}

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

document.getElementById('add-evidence-btn').addEventListener('click', function() { send('addEvidence'); });
document.getElementById('resolve-btn').addEventListener('click', function() {
  if (this.dataset.caseStatus === 'resolved') {
    send('reopenCase');
  } else {
    send('resolveCase');
  }
});
document.getElementById('analysis-toggle').addEventListener('click', function() { toggleAnalysis(); });

send('ready');
</script>
</body>
</html>`;
  }
}
