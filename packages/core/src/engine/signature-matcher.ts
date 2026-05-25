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
    evidence: buildEvidence(matched),
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

/**
 * Resolves a signal field name to its current value by direct property lookup on the
 * summary. No switch/case — any primitive field added to ThreadDumpSummary is
 * automatically available to signature YAML without touching this file.
 */
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
      // Support (?i) inline flag prefix (PCRE syntax used in YAML signatures).
      // JavaScript uses RegExp constructor flags instead, so convert before compiling.
      let pattern = String(target);
      let flags = '';
      const inlineFlag = pattern.match(/^\(\?([a-z]+)\)([\s\S]*)/);
      if (inlineFlag) { flags = inlineFlag[1]; pattern = inlineFlag[2]; }
      return new RegExp(pattern, flags).test(String(value));
    }
    default:         return false;
  }
}

function buildEvidence(matched: MatchedCondition[]): string[] {
  return matched.map(c => `${c.description}: ${c.observedValue}`);
}
