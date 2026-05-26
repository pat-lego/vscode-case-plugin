import * as fs from 'fs';
import * as path from 'path';
import {
  parseThreadDump,
  extractSignals,
  matchSignatures,
  Finding,
  ThreadDumpSignals,
  EvidenceItem
} from '@incident-investigator/core';
import { CaseManager } from './case-manager';
import { SignatureService } from './signature-service';
import { IILogger, nullLogger } from '../logger';

export type EvidenceType = EvidenceItem['type'];

export function detectEvidenceType(name: string, content: string): EvidenceType {
  const lower = name.toLowerCase();

  if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif')) {
    return 'screenshot';
  }

  if (
    lower.includes('threaddump') ||
    lower.includes('thread-dump') ||
    lower.includes('thread_dump') ||
    lower.endsWith('.tdump') ||
    lower.endsWith('.jfr')
  ) {
    return 'thread-dump';
  }

  if (
    content.includes('java.lang.Thread.State:') ||
    content.includes('3XMTHREADINFO') ||
    /^"[^"]+" #\d+/.test(content) ||
    (content.includes('nid=0x') && content.includes('tid=0x'))
  ) {
    return 'thread-dump';
  }

  if (lower.includes('top') && (content.includes('load average') || content.includes('PID'))) {
    return 'top-output';
  }

  return 'log-export';
}

export function extractTimestamp(content: string): Date {
  // jstack: "2024-01-15 14:32:45"
  const jstack = content.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/m);
  if (jstack) {
    const d = new Date(jstack[1]);
    if (!isNaN(d.getTime())) return d;
  }

  // IBM J9: "1TIDATETIME    Date: 2024/01/15 at 14:32:45:000"
  const ibm = content.match(/1TIDATETIME\s+Date:\s+(\d{4}\/\d{2}\/\d{2}) at (\d{2}:\d{2}:\d{2})/);
  if (ibm) {
    const d = new Date(`${ibm[1].replace(/\//g, '-')}T${ibm[2]}`);
    if (!isNaN(d.getTime())) return d;
  }

  return new Date();
}

export class AnalysisService {
  constructor(
    private caseManager: CaseManager,
    private signatureService: SignatureService,
    private log: IILogger = nullLogger
  ) {}

  processEvidence(
    caseId: string,
    name: string,
    content: string,
    filePath: string
  ): { evidenceItem: EvidenceItem; findings: Finding[] } {
    const type = detectEvidenceType(name, content);
    const capturedAt = type === 'thread-dump' ? extractTimestamp(content) : new Date();

    this.log.info('analysis', 'processEvidence', { caseId, name, type, contentLen: content.length, filePath: filePath || null });

    let signals: ThreadDumpSignals | undefined;
    if (type === 'thread-dump') {
      signals = parseThreadDump(content, capturedAt);
      this.log.info('analysis', 'parsed thread dump', {
        caseId,
        format: signals.format,
        totalThreads: signals.totalThreadCount,
        blocked: signals.stateCounts.BLOCKED,
        waiting: signals.stateCounts.WAITING,
        timedWaiting: signals.stateCounts.TIMED_WAITING,
        gcThreads: signals.gcThreadCount,
        ioThreads: signals.ioThreadCount,
        capturedAt: capturedAt.toISOString(),
      });
    }

    const evidenceItem: EvidenceItem = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      source: filePath ? 'local-file' : 'bridge-capture',
      capturedAt,
      filePath,
      rawContent: content || undefined
    };

    this.caseManager.addEvidence(caseId, evidenceItem, signals);

    const session = this.caseManager.getSession(caseId);
    if (!session || session.threadDumpSignals.length === 0) {
      this.log.debug('analysis', 'no thread dump signals yet — skipping analysis', { caseId });
      return { evidenceItem, findings: [] };
    }

    const findings = this.rerun(session.threadDumpSignals);
    this.caseManager.updateFindings(caseId, findings);
    this.log.info('analysis', 'processEvidence done', { caseId, evId: evidenceItem.id, findings: findings.length });
    return { evidenceItem, findings };
  }

  rerun(signals: ThreadDumpSignals[]): Finding[] {
    if (signals.length === 0) return [];
    this.log.debug('analysis', 'extractSignals', { dumpCount: signals.length });
    const extracted = extractSignals(signals);
    const s = extracted.summary;
    this.log.debug('analysis', 'signals summary', {
      totalThreads: s.totalThreadCount,
      blocked: s.blockedThreadCount,
      waiting: s.waitingThreadCount,
      ioThreads: s.ioThreadCount,
      gcThreads: s.gcThreadCount,
      dominantFP: s.dominantFingerprintCount,
      dominantRatio: Math.round(s.dominantFingerprintRatio * 100) + '%',
      persistentMonitors: s.persistentBlockedMonitors,
      maxBlockedOnMonitor: s.maxBlockedOnSingleMonitor,
      topMonitorClass: s.topBlockedMonitorClass || null,
    });
    const sigs = this.signatureService.getAll();
    this.log.debug('analysis', 'matchSignatures', { signatureCount: sigs.length });
    const findings = matchSignatures(extracted, sigs);
    for (const f of findings) {
      this.log.debug('analysis', 'finding', {
        sig: f.signatureId,
        name: f.signatureName,
        confidence: f.confidence,
        score: Math.round(f.confidenceScore * 100) + '%',
        matched: f.matchedConditions.length,
        unmatched: f.unmatchedConditions.length,
      });
    }
    this.log.info('analysis', 'rerun complete', { dumpCount: signals.length, findings: findings.length });
    return findings;
  }

  reanalyzeCaseWithLatestSignatures(caseId: string): Finding[] {
    const session = this.caseManager.getSession(caseId);
    if (!session) return [];
    this.signatureService.reload();
    const findings = this.rerun(session.threadDumpSignals);
    this.caseManager.updateFindings(caseId, findings);
    return findings;
  }
}
