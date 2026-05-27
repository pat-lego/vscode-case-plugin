import { Signature, SignatureCondition } from '../types/signature';
import { Finding, MatchedCondition, UnmatchedCondition } from '../types/finding';
import { ExtractedSignals } from './signal-extractor';

export function matchSignatures(signals: ExtractedSignals, signatures: Signature[]): Finding[] {
  return signatures
    .map(sig => evaluate(sig, signals))
    .filter(f => f.confidenceScore > 0)
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
}

function evaluate(signature: Signature, signals: ExtractedSignals): Finding {
  const matched: MatchedCondition[] = [];
  const unmatched: UnmatchedCondition[] = [];

  for (const condition of signature.conditions) {
    const result = evaluateCondition(condition, signals);
    if (result.matched) {
      matched.push({ field: condition.field, description: condition.description, observedValue: result.value });
    } else {
      unmatched.push({ field: condition.field, description: condition.description, required: true });
    }
  }

  const score = matched.length / signature.conditions.length;
  const confidence = score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';

  return {
    signatureId: signature.id,
    signatureName: signature.name,
    confidence,
    confidenceScore: score,
    matchedConditions: matched,
    unmatchedConditions: unmatched,
    evidence: buildEvidence(matched, signals),
    nextSteps: signature.nextSteps,
    relatedSignatures: signature.relatedSignatures
  };
}

function evaluateCondition(
  condition: SignatureCondition,
  signals: ExtractedSignals
): { matched: boolean; value: number | string } {
  const value = resolveField(condition.field, signals);
  if (value === undefined) return { matched: false, value: 'N/A' };

  const matched = compare(value, condition.operator, condition.value);
  return { matched, value };
}

function resolveField(field: string, signals: ExtractedSignals): number | string | undefined {
  const val = (signals.summary as unknown as Record<string, unknown>)[field];
  if (typeof val === 'number' || typeof val === 'string') return val;
  return undefined;
}

function compare(value: number | string, operator: SignatureCondition['operator'], target: number | string): boolean {
  const n = Number(value);
  const t = Number(target);
  switch (operator) {
    case 'gt':       return n > t;
    case 'gte':      return n >= t;
    case 'lt':       return n < t;
    case 'lte':      return n <= t;
    case 'eq':       return value === target;
    case 'contains': return String(value).includes(String(target));
    case 'matches': {
      let pattern = String(target);
      let flags = '';
      const inlineFlag = pattern.match(/^\(\?([a-z]+)\)([\s\S]*)/);
      if (inlineFlag) { flags = inlineFlag[1]; pattern = inlineFlag[2]; }
      return new RegExp(pattern, flags).test(String(value));
    }
    default:         return false;
  }
}

function buildEvidence(matched: MatchedCondition[], signals: ExtractedSignals): string[] {
  const lines: string[] = matched.map(c => `${c.description}: ${c.observedValue}`);

  // Enrich with thread-level context from the matched conditions
  const { summary, threadDumps } = signals;

  for (const c of matched) {
    // For conn-pool / timed-waiting key frame matches: show which threads are stuck
    if (c.field === 'suspiciousTimedWaitingKeyFrame' && summary.suspiciousTimedWaitingKeyFrame) {
      const kf = summary.suspiciousTimedWaitingKeyFrame;
      // Find fingerprints whose keyFrame matches this frame (across all dumps)
      const affectedNames: string[] = [];
      for (const dump of threadDumps) {
        for (const fp of dump.stackFingerprints) {
          if ((fp.keyFrame || fp.topFrame).includes(kf) || kf.includes(fp.keyFrame || fp.topFrame)) {
            affectedNames.push(...fp.threadNames);
          }
        }
      }
      const unique = [...new Set(affectedNames)].slice(0, 20);
      if (unique.length > 0) {
        lines.push(`Affected thread names (${unique.length}${affectedNames.length > 20 ? '+' : ''}): ${unique.join(', ')}`);
      }
    }

    // For dominant active fingerprint (hot-endpoint): show top thread names
    if (c.field === 'dominantActiveFingerprintCount' && summary.dominantActiveFingerprintCount > 0) {
      const topRunnable = (summary.dominantFingerprints ?? [])
        .filter(fp => fp.state === 'RUNNABLE')
        .sort((a, b) => b.count - a.count)[0];
      if (topRunnable) {
        const names = topRunnable.threadNames.slice(0, 20);
        const kf = topRunnable.keyFrame || topRunnable.topFrame;
        lines.push(`Hot code path: ${kf}`);
        lines.push(`Affected thread names (${names.length}${topRunnable.threadNames.length > 20 ? '+' : ''}): ${names.join(', ')}`);
      }
    }

    // For blocked monitor class: show lock holder and waiting threads
    if (c.field === 'topBlockedMonitorClass' && summary.topBlockedMonitorClass) {
      const cls = summary.topBlockedMonitorClass;
      for (const dump of threadDumps) {
        for (const mon of dump.blockedMonitors) {
          if (mon.monitorClass.includes(cls) || cls.includes(mon.monitorClass)) {
            if (mon.lockHolderThread) {
              lines.push(`Lock holder: ${mon.lockHolderThread}`);
            }
            if (mon.waitingThreadNames?.length > 0) {
              const names = mon.waitingThreadNames.slice(0, 15);
              lines.push(`Waiting threads (${mon.waitingThreadCount}): ${names.join(', ')}`);
            }
            break;
          }
        }
      }
    }

    // For active request thread count: show the top URLs being served
    if (c.field === 'activeRequestThreadCount' && summary.activeRequestThreadCount > 0) {
      const HTTP_REQUEST_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/[^\s]*)/;
      const urlCounts = new Map<string, number>();
      for (const dump of threadDumps) {
        for (const fp of dump.stackFingerprints) {
          for (const name of fp.threadNames) {
            const m = HTTP_REQUEST_RE.exec(name);
            if (m) {
              const url = m[1] + ' ' + m[2].split('?')[0];
              urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1);
            }
          }
        }
      }
      const top = [...urlCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (top.length > 0) {
        lines.push('Top requested URLs:');
        for (const [url, n] of top) lines.push(`  ${n} threads — ${url}`);
      }
    }

    // For blocked thread count: show which threads are BLOCKED and what they are waiting on
    if (c.field === 'blockedThreadCount' || c.field === 'synchronizedBlockedMonitorCount') {
      const blockedInfo: string[] = [];
      for (const dump of threadDumps) {
        for (const mon of dump.blockedMonitors) {
          if (mon.waitingThreadNames?.length > 0) {
            const names = mon.waitingThreadNames.slice(0, 10).join(', ');
            const holder = mon.lockHolderThread ? ` | lock held by: ${mon.lockHolderThread}` : '';
            blockedInfo.push(`${mon.waitingThreadCount} threads waiting on ${mon.monitorClass}${holder} — ${names}`);
          }
        }
        if (blockedInfo.length > 0) break; // use first dump only
      }
      if (blockedInfo.length > 0) {
        lines.push(...blockedInfo.slice(0, 5));
      }
    }
  }

  return lines;
}
