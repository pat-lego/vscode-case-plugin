import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
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
    const casePath = this.getCasePath();
    if (casePath) {
      this.loadFromDisk(casePath);
    } else {
      this.loadFromGlobalState();
    }
  }

  createCase(id: string, title: string): CaseSession {
    const now = new Date();
    const meta: Case = { id, title, createdAt: now, updatedAt: now, status: 'open', evidence: [] };
    const session: CaseSession = { meta, threadDumpSignals: [], findings: [] };
    this.sessions.set(id, session);
    this.activeCaseId = id;
    this.save(id);
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
    this.save(caseId);
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
    this.save(caseId);
  }

  getCasePath(): string | undefined {
    return vscode.workspace.getConfiguration('investigator').get<string>('casePath') || undefined;
  }

  // ── Disk persistence ──────────────────────────────────────────────────────

  private save(caseId: string) {
    const casePath = this.getCasePath();
    if (casePath) {
      try {
        this.writeToDisk(caseId, casePath);
      } catch (err) {
        vscode.window.showWarningMessage(`Incident Investigator: could not write case to disk — ${err}`);
      }
    } else {
      this.persistToGlobalState();
    }
  }

  /**
   * Scans casePath for subdirectories. Each subdirectory that contains a
   * primary MD file named after itself (CASE-ID/CASE-ID.md) is treated as a
   * case and loaded into memory.
   */
  private loadFromDisk(casePath: string) {
    if (!fs.existsSync(casePath)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(casePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const caseId = entry.name;
      const caseDir = path.join(casePath, caseId);
      const mdPath = path.join(caseDir, `${caseId}.md`);
      if (!fs.existsSync(mdPath)) continue;

      try {
        const c = this.parseCaseFile(mdPath, caseDir);
        if (c) this.sessions.set(c.id, { meta: c, threadDumpSignals: [], findings: [] });
      } catch {
        // Malformed case file — skip silently and leave the folder untouched
      }
    }
  }

  /**
   * Parses the YAML frontmatter from a case's primary MD file and restores
   * the Case object. Evidence raw content is read from the sibling files
   * stored in the case folder alongside the MD.
   */
  private parseCaseFile(mdPath: string, caseDir: string): Case | null {
    const content = fs.readFileSync(mdPath, 'utf-8');
    const fm = extractFrontmatter(content);
    if (!fm || !fm.case_id) return null;

    const rawEvidence = Array.isArray(fm.evidence) ? fm.evidence as Record<string, unknown>[] : [];

    const evidence: EvidenceItem[] = rawEvidence.map(raw => {
      const item: EvidenceItem = {
        id: String(raw['id'] ?? ''),
        type: raw['type'] as EvidenceItem['type'],
        source: String(raw['source'] ?? ''),
        capturedAt: new Date(raw['captured_at'] as string),
        filePath: String(raw['file_path'] ?? ''),
      };
      // Read raw content from the evidence file stored in the case folder
      if (raw['stored_file']) {
        const storedPath = path.join(caseDir, String(raw['stored_file']));
        if (fs.existsSync(storedPath)) {
          item.rawContent = fs.readFileSync(storedPath, 'utf-8');
        }
      }
      return item;
    });

    return {
      id: String(fm.case_id),
      title: String(fm.title ?? ''),
      createdAt: new Date(fm.created as string),
      updatedAt: new Date(fm.updated as string),
      status: (fm.status as 'open' | 'resolved') ?? 'open',
      evidence,
      resolution: fm.resolution ? String(fm.resolution) : undefined,
      resolvedBy: fm.resolved_by ? String(fm.resolved_by) : undefined,
    };
  }

  /**
   * Writes the primary MD file for a case.
   *
   * Layout:
   *   casePath/
   *     CASE-ID/
   *       CASE-ID.md          ← YAML frontmatter + human-readable summary
   *       ev-<id>.txt         ← raw content of each text evidence item
   */
  private writeToDisk(caseId: string, casePath: string) {
    const session = this.sessions.get(caseId);
    if (!session) return;

    const caseDir = path.join(casePath, caseId);
    fs.mkdirSync(caseDir, { recursive: true });

    const { meta } = session;

    // Write each evidence item's raw content to its own file
    const evidenceEntries = meta.evidence.map(ev => {
      let storedFile: string | null = null;
      if (ev.rawContent && ev.type !== 'screenshot') {
        storedFile = `${ev.id}.txt`;
        fs.writeFileSync(path.join(caseDir, storedFile), ev.rawContent, 'utf-8');
      }
      return {
        id: ev.id,
        type: ev.type,
        source: ev.source,
        captured_at: ev.capturedAt.toISOString(),
        file_path: ev.filePath,
        stored_file: storedFile,
      };
    });

    const frontmatter = yaml.dump(
      {
        case_id: meta.id,
        title: meta.title,
        created: meta.createdAt.toISOString(),
        updated: meta.updatedAt.toISOString(),
        status: meta.status,
        evidence: evidenceEntries,
        resolution: meta.resolution ?? null,
        resolved_by: meta.resolvedBy ?? null,
      },
      { lineWidth: -1, sortKeys: false }
    );

    const body = buildCaseSummary(session);
    const md = `---\n${frontmatter}---\n\n${body}`;
    fs.writeFileSync(path.join(caseDir, `${caseId}.md`), md, 'utf-8');
  }

  // ── Global state fallback (used when casePath is not configured) ──────────

  private loadFromGlobalState() {
    const persisted = this.context.globalState.get<Case[]>('investigator.cases', []);
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

  private persistToGlobalState() {
    this.context.globalState.update('investigator.cases', this.getAllCases());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extracts and parses the YAML frontmatter block from a markdown file. */
function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Builds the human-readable markdown body written below the frontmatter. */
function buildCaseSummary(session: CaseSession): string {
  const { meta, findings } = session;
  const lines: string[] = [];

  lines.push(`# ${meta.id} — ${meta.title}`, '');

  lines.push('## Summary');
  lines.push(
    meta.status === 'resolved' && meta.resolution
      ? meta.resolution
      : '_Investigation in progress_'
  );
  lines.push('');

  if (findings.length > 0) {
    lines.push('## Findings', '');
    for (const f of findings) {
      lines.push(`- **[${f.confidence.toUpperCase()}]** ${f.signatureName}`);
    }
    lines.push('');
  }

  lines.push('## Evidence');
  if (meta.evidence.length === 0) {
    lines.push('_No evidence added yet_');
  } else {
    for (const ev of meta.evidence) {
      lines.push(`- ${ev.capturedAt.toISOString()} — ${ev.type} (${ev.source})`);
    }
  }
  lines.push('');

  if (meta.status === 'resolved') {
    lines.push('## Resolution');
    lines.push(`**Resolved by:** ${meta.resolvedBy ?? 'Unknown'}`, '');
    lines.push(meta.resolution ?? '');
  }

  return lines.join('\n');
}
