import * as vscode from 'vscode';
import { Case, EvidenceItem, ThreadDumpSignals, Finding } from '@incident-investigator/core';

export interface CaseSession {
  meta: Case;
  threadDumpSignals: ThreadDumpSignals[];
  findings: Finding[];
}

export class CaseManager {
  private sessions = new Map<string, CaseSession>();
  private activeCaseId: string | null = null;

  private onActiveChangeEmitter = new vscode.EventEmitter<string | null>();
  readonly onActiveChange = this.onActiveChangeEmitter.event;

  private onFindingsChangeEmitter = new vscode.EventEmitter<{ caseId: string; findings: Finding[] }>();
  readonly onFindingsChange = this.onFindingsChangeEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    const persisted = context.globalState.get<Case[]>('investigator.cases', []);
    for (const c of persisted) {
      this.sessions.set(c.id, {
        meta: {
          ...c,
          createdAt: new Date(c.createdAt),
          updatedAt: new Date(c.updatedAt),
          evidence: c.evidence.map(e => ({ ...e, capturedAt: new Date(e.capturedAt) }))
        },
        threadDumpSignals: [],
        findings: []
      });
    }
  }

  createCase(id: string, title: string): CaseSession {
    const now = new Date();
    const meta: Case = { id, title, createdAt: now, updatedAt: now, status: 'open', evidence: [] };
    const session: CaseSession = { meta, threadDumpSignals: [], findings: [] };
    this.sessions.set(id, session);
    this.activeCaseId = id;
    this.persist();
    this.onActiveChangeEmitter.fire(id);
    return session;
  }

  setActiveCase(caseId: string): boolean {
    if (!this.sessions.has(caseId)) return false;
    this.activeCaseId = caseId;
    this.onActiveChangeEmitter.fire(caseId);
    return true;
  }

  getActiveCaseId(): string | null {
    return this.activeCaseId;
  }

  getActiveSession(): CaseSession | undefined {
    return this.activeCaseId ? this.sessions.get(this.activeCaseId) : undefined;
  }

  getSession(caseId: string): CaseSession | undefined {
    return this.sessions.get(caseId);
  }

  getAllCases(): Case[] {
    return Array.from(this.sessions.values())
      .map(s => s.meta)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  addEvidence(caseId: string, item: EvidenceItem, signals?: ThreadDumpSignals) {
    const session = this.sessions.get(caseId);
    if (!session) return;
    session.meta.evidence.push(item);
    session.meta.updatedAt = new Date();
    if (signals) session.threadDumpSignals.push(signals);
    this.persist();
  }

  updateFindings(caseId: string, findings: Finding[]) {
    const session = this.sessions.get(caseId);
    if (!session) return;
    session.findings = findings;
    this.onFindingsChangeEmitter.fire({ caseId, findings });
  }

  resolveCase(caseId: string, resolution: string, resolvedBy: string) {
    const session = this.sessions.get(caseId);
    if (!session) return;
    session.meta.status = 'resolved';
    session.meta.resolution = resolution;
    session.meta.resolvedBy = resolvedBy;
    session.meta.updatedAt = new Date();
    this.persist();
  }

  private persist() {
    this.context.globalState.update('investigator.cases', this.getAllCases());
  }
}
