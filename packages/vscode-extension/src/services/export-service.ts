import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Finding } from '@incident-investigator/core';
import { CaseSession } from './case-manager';

export class ExportService {
  async exportCase(session: CaseSession): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('investigator');
    const vaultPath = config.get<string>('obsidianVaultPath');

    if (!vaultPath) {
      const action = await vscode.window.showErrorMessage(
        'Obsidian vault path not configured.',
        'Open Settings'
      );
      if (action === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'investigator.obsidianVaultPath');
      }
      return undefined;
    }

    const caseDir = path.join(vaultPath, 'cases', session.meta.id);
    fs.mkdirSync(caseDir, { recursive: true });

    // Write each evidence file into the case folder
    for (const ev of session.meta.evidence) {
      if (!ev.rawContent || ev.type === 'screenshot') continue;
      const ext = ev.type === 'log-export' ? '.log' : '.txt';
      const safeName = toSafeFilename(`${ev.type}-${formatTime(ev.capturedAt)}`) + ext;
      fs.writeFileSync(path.join(caseDir, safeName), ev.rawContent, 'utf-8');
    }

    const md = buildMarkdown(session);
    const mdPath = path.join(caseDir, `${session.meta.id}.md`);
    fs.writeFileSync(mdPath, md, 'utf-8');

    return mdPath;
  }
}

function buildMarkdown(session: CaseSession): string {
  const { meta, findings } = session;
  const lines: string[] = [];

  lines.push('---');
  lines.push(`case_id: ${meta.id}`);
  lines.push(`title: "${meta.title}"`);
  lines.push(`created: ${meta.createdAt.toISOString()}`);
  lines.push(`status: ${meta.status}`);
  lines.push(`tags: [incident]`);
  lines.push('---', '');
  lines.push(`# ${meta.id} — ${meta.title}`, '');

  lines.push('## Summary');
  lines.push(meta.status === 'resolved' && meta.resolution ? meta.resolution : '_Investigation in progress_');
  lines.push('');

  lines.push('## Evidence');
  for (const ev of meta.evidence) {
    const ext = ev.type === 'log-export' ? '.log' : '.txt';
    const safeName = toSafeFilename(`${ev.type}-${formatTime(ev.capturedAt)}`);
    const label = evidenceLabel(ev.type, ev.capturedAt);
    if (ev.type === 'screenshot') {
      lines.push(`- ![[${safeName}.png]] — ${label}`);
    } else {
      lines.push(`- [[${safeName}${ext}]] — ${label}`);
    }
  }
  lines.push('');

  if (findings.length > 0) {
    lines.push('## Findings', '');
    for (const f of findings) {
      lines.push(`### [${f.confidence.toUpperCase()}] ${f.signatureName}`);
      lines.push(`Signature: [[${f.signatureId}]]`, '');
      lines.push('**Evidence:**');
      for (const e of f.evidence) lines.push(`- ${e}`);
      lines.push('');
      lines.push('**Next Steps:**');
      for (const step of f.nextSteps) lines.push(`- [ ] ${step}`);
      if (f.relatedSignatures.length > 0) {
        lines.push('');
        lines.push('**Related:** ' + f.relatedSignatures.map(s => `[[${s}]]`).join(', '));
      }
      lines.push('');
    }
  }

  lines.push('## Timeline');
  for (const ev of meta.evidence) {
    lines.push(`- ${formatTime(ev.capturedAt)} — ${evidenceLabel(ev.type, ev.capturedAt)}`);
  }
  lines.push('');

  lines.push('## Resolution');
  if (meta.status === 'resolved') {
    lines.push(`**Resolved by:** ${meta.resolvedBy ?? 'Unknown'}`, '');
    lines.push(meta.resolution ?? '');
  } else {
    lines.push('_Not yet resolved_');
  }

  return lines.join('\n');
}

function toSafeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase();
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}h${pad(date.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function evidenceLabel(type: string, at: Date): string {
  const t = formatTime(at);
  const labels: Record<string, string> = {
    'thread-dump': `Thread dump at ${t}`,
    'log-export':  `Log export at ${t}`,
    'top-output':  `Top output at ${t}`,
    'screenshot':  `Screenshot at ${t}`,
    'generic':     `Evidence at ${t}`
  };
  return labels[type] ?? `Evidence at ${t}`;
}
