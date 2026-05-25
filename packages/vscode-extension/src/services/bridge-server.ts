import * as vscode from 'vscode';
import WebSocket, { WebSocketServer } from 'ws';
import { CaseManager } from './case-manager';
import { AnalysisService } from './analysis-service';

export interface BridgeCapture {
  type: 'capture' | 'screenshot';
  source: string;
  timestamp?: string;
  name?: string;
  content?: string;
  data?: string;
  mimeType?: string;
}

export class BridgeServer {
  private server: WebSocketServer | undefined;
  private clients = new Set<WebSocket.WebSocket>();

  private statusEmitter = new vscode.EventEmitter<boolean>();
  readonly onStatusChange = this.statusEmitter.event;

  private captureEmitter = new vscode.EventEmitter<{ caseId: string; name: string }>();
  readonly onCapture = this.captureEmitter.event;

  constructor(
    private caseManager: CaseManager,
    private analysisService: AnalysisService
  ) {
    // Broadcast active case whenever it changes
    this.caseManager.onActiveChange(() => this.broadcastActiveCase());
  }

  start(port: number) {
    if (this.server) return;

    try {
      this.server = new WebSocketServer({ port, host: '127.0.0.1' });
    } catch {
      vscode.window.showWarningMessage(`Investigation Bridge: could not start on port ${port}.`);
      return;
    }

    this.server.on('connection', (ws) => {
      this.clients.add(ws);
      this.sendTo(ws, this.activeCasePayload());
      this.statusEmitter.fire(true);

      ws.on('message', (raw) => {
        try {
          this.handleMessage(ws, JSON.parse(raw.toString()));
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        if (this.clients.size === 0) this.statusEmitter.fire(false);
      });
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        vscode.window.showWarningMessage(
          `Investigation Bridge: port ${port} is in use. Change investigator.bridgePort and reload.`
        );
      }
    });
  }

  stop() {
    this.server?.close();
    this.server = undefined;
    this.clients.clear();
  }

  isConnected(): boolean {
    return this.clients.size > 0;
  }

  broadcastActiveCase() {
    this.broadcast(this.activeCasePayload());
  }

  private handleMessage(ws: WebSocket.WebSocket, msg: Record<string, unknown>) {
    if (msg.type === 'ping') {
      this.sendTo(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'capture' || msg.type === 'screenshot') {
      const caseId = this.caseManager.getActiveCaseId();
      if (!caseId) {
        this.sendTo(ws, { type: 'error', message: 'No active case — open an investigation in VS Code first.' });
        return;
      }

      const name = String(msg.name ?? `${msg.source ?? 'capture'}-${Date.now()}`);
      const content = String(msg.content ?? msg.data ?? '');

      this.analysisService.processEvidence(caseId, name, content, '');
      this.captureEmitter.fire({ caseId, name });
      this.sendTo(ws, { type: 'captureAck', name, caseId });
    }
  }

  private broadcast(payload: object) {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  private sendTo(ws: WebSocket.WebSocket, payload: object) {
    if (ws.readyState === WebSocket.WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  private activeCasePayload(): object {
    const session = this.caseManager.getActiveSession();
    return session
      ? { type: 'activeCase', caseId: session.meta.id, title: session.meta.title }
      : { type: 'noActiveCase' };
  }
}
