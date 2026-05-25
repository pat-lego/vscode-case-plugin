import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Case, EvidenceItem, ThreadDumpSignals, Finding } from '@incident-investigator/core';

export interface CaseSession {
  meta: Case;
  threadDumpSignals: ThreadDumpSignals[];
  findings: Finding[];
  /** The root folder this case was loaded from, or will be written to. */
  casePath: string;
  /** True for plain Obsidian notes loaded without extension frontmatter — never written back. */
  readonly?: boolean;
}

export class CaseManager {
  private sessions = new Map<string, CaseSession>();
  private activeCaseId: string | null = null;

  private onActiveChangeEmitter = new vscode.EventEmitter<string | null>();
  readonly onActiveChange = this.onActiveChangeEmitter.event;

  private onFindingsChangeEmitter = new vscode.EventEmitter<{ caseId: string; findings: Finding[] }>();
  readonly onFindingsChange = this.onFindingsChangeEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    const paths = this.getCasePaths();
    if (paths.length > 0) {
      this.loadFromDisk(paths);
    } else {
      this.loadFromGlobalState();
    }
  }

  createCase(id: string, title: string): CaseSession {
    const now = new Date();
    const meta: Case = { id, title, createdAt: now, updatedAt: now, status: 'open', evidence: [] };
    // New cases are written to the first configured path.
    // Falls back to '' (globalState) when no paths are configured.
    const casePath = this.getCasePaths()[0] ?? '';
    const session: CaseSession = { meta, threadDumpSignals: [], findings: [], casePath };
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

  removeEvidence(caseId: string, evidenceId: string): boolean {
    const session = this.sessions.get(caseId);
    if (!session) return false;
    const idx = session.meta.evidence.findIndex(e => e.id === evidenceId);
    if (idx === -1) return false;
    session.meta.evidence.splice(idx, 1);
    session.threadDumpSignals.splice(idx, 1);
    session.meta.updatedAt = new Date();
    this.save(caseId);
    return true;
  }

  updateNotes(caseId: string, notes: string) {
    const session = this.sessions.get(caseId);
    if (!session) return;
    session.meta.notes = notes;
    session.meta.updatedAt = new Date();
    this.save(caseId);
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

  /**
   * Returns the list of configured case root paths, filtering out blanks.
   * Each path is a folder whose immediate subdirectories are individual cases.
   */
  getCasePaths(): string[] {
    return (
      vscode.workspace.getConfiguration('investigator').get<string[]>('casePaths') ?? []
    ).filter(p => p.trim() !== '');
  }

  // ── Disk persistence ──────────────────────────────────────────────────────

  private save(caseId: string) {
    const session = this.sessions.get(caseId);
    if (!session || session.readonly) return;

    if (session.casePath) {
      try {
        this.writeToDisk(caseId, session.casePath);
      } catch (err) {
        vscode.window.showWarningMessage(`Incident Investigator: could not write case to disk — ${err}`);
      }
    } else {
      this.persistToGlobalState();
    }
  }

  /**
   * Scans every configured path for case subdirectories. A directory is
   * recognised as a case when it contains a primary MD file with the same
   * name as the directory (e.g. issues/ISSUE-1/ISSUE-1.md).
   *
   * When the same case ID appears in more than one path the first path wins,
   * so the order of casePaths acts as a priority list.
   */
  private loadFromDisk(casePaths: string[]) {
    for (const casePath of casePaths) {
      if (!fs.existsSync(casePath)) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(casePath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const caseId = entry.name;

        // First path wins — do not overwrite a case already loaded.
        if (this.sessions.has(caseId)) continue;

        const caseDir = path.join(casePath, caseId);
        const mdPath = path.join(caseDir, `${caseId}.md`);
        if (!fs.existsSync(mdPath)) continue;

        try {
          const result = this.parseCaseFile(mdPath, caseDir);
          if (result) {
            this.sessions.set(result.meta.id, {
              meta: result.meta,
              threadDumpSignals: [],
              findings: [],
              casePath,
              readonly: result.readonly,
            });
          }
        } catch {
          // Malformed case file — skip silently and leave the folder untouched
        }
      }
    }
  }

  /**
   * Parses a case's primary MD file and restores the Case object.
   * If the file has extension YAML frontmatter (case_id field) it is treated as
   * a full editable case. Otherwise the folder is treated as a read-only Obsidian
   * note: the folder name becomes the case ID and the first heading (if any)
   * becomes the title.
   */
  private parseCaseFile(mdPath: string, caseDir: string): { meta: Case; readonly: boolean } | null {
    const content = fs.readFileSync(mdPath, 'utf-8');
    const fm = extractFrontmatter(content);

    if (fm && fm.case_id) {
      const rawEvidence = Array.isArray(fm.evidence) ? fm.evidence as Record<string, unknown>[] : [];

      const evidence: EvidenceItem[] = rawEvidence.map(raw => {
        const item: EvidenceItem = {
          id: String(raw['id'] ?? ''),
          type: raw['type'] as EvidenceItem['type'],
          source: String(raw['source'] ?? ''),
          capturedAt: new Date(raw['captured_at'] as string),
          filePath: String(raw['file_path'] ?? ''),
        };
        if (raw['stored_file']) {
          const storedPath = path.join(caseDir, String(raw['stored_file']));
          if (fs.existsSync(storedPath)) {
            item.rawContent = fs.readFileSync(storedPath, 'utf-8');
          }
        }
        return item;
      });

      return {
        meta: {
          id: String(fm.case_id),
          title: String(fm.title ?? ''),
          createdAt: new Date(fm.created as string),
          updatedAt: new Date(fm.updated as string),
          status: (fm.status as 'open' | 'resolved') ?? 'open',
          evidence,
          resolution: fm.resolution ? String(fm.resolution) : undefined,
          resolvedBy: fm.resolved_by ? String(fm.resolved_by) : undefined,
          notes: fm.notes ? String(fm.notes) : undefined,
        },
        readonly: false,
      };
    }

    // Plain Obsidian note — no case_id frontmatter.
    // Load as read-only so the extension never overwrites the user's file.
    const caseId = path.basename(caseDir);
    const stats = fs.statSync(mdPath);
    const title = extractFirstHeading(content) ?? caseId;

    return {
      meta: {
        id: caseId,
        title,
        createdAt: stats.birthtime,
        updatedAt: stats.mtime,
        status: 'open',
        evidence: [],
      },
      readonly: true,
    };
  }

  /**
   * Writes the primary MD file for a case into its root path.
   *
   * Layout inside the root path:
   *   <casePath>/
   *     <CASE-ID>/
   *       <CASE-ID>.md      ← YAML frontmatter + human-readable summary
   *       <ev-id>.txt       ← raw content of each text evidence item
   */
  private writeToDisk(caseId: string, casePath: string) {
    const session = this.sessions.get(caseId);
    if (!session) return;

    const caseDir = path.join(casePath, caseId);
    fs.mkdirSync(caseDir, { recursive: true });

    const { meta } = session;

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
        notes: meta.notes ?? null,
      },
      { lineWidth: -1, sortKeys: false }
    );

    const body = buildCaseSummary(session);
    const md = `---\n${frontmatter}---\n\n${body}`;
    fs.writeFileSync(path.join(caseDir, `${caseId}.md`), md, 'utf-8');
  }

  // ── Global state fallback (used when no casePaths are configured) ─────────

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
        findings: [],
        casePath: ''
      });
    }
  }

  private persistToGlobalState() {
    this.context.globalState.update('investigator.cases', this.getAllCases());
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractFirstHeading(content: string): string | null {
  const match = content.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

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
