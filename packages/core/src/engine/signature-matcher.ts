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
    evidence: buildEvidence(signature, signals, matched),
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
  const { summary, threadDumps } = signals;
  switch (field) {
    case 'totalThreadCount':           return summary.maxThreadCount;
    case 'blockedThreadCount':         return Math.max(...threadDumps.map(d => d.stateCounts.BLOCKED ?? 0));
    case 'waitingThreadCount':         return Math.max(...threadDumps.map(d => d.stateCounts.WAITING ?? 0));
    case 'ioThreadCount':              return Math.max(...threadDumps.map(d => d.ioThreadCount));
    case 'threadCountAnomaly':         return summary.threadCountAnomaly ? 1 : 0;
    case 'ioSaturationDetected':       return summary.ioSaturationDetected ? 1 : 0;
    case 'dominantFingerprintCount':   return summary.dominantFingerprints[0]?.count ?? 0;
    case 'dominantFingerprintRatio':   return summary.maxThreadCount > 0
                                         ? (summary.dominantFingerprints[0]?.count ?? 0) / summary.maxThreadCount
                                         : 0;
    case 'persistentBlockedMonitors':  return summary.persistentBlockedMonitors.length;
    default:                           return undefined;
  }
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
    case 'matches':  return new RegExp(String(target)).test(String(value));
    default:         return false;
  }
}

function buildEvidence(signature: Signature, signals: ExtractedSignals, matched: MatchedCondition[]): string[] {
  return matched.map(c => `${c.description}: ${c.observedValue}`);
}
