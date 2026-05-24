import { Signature } from './signature';
import { ThreadDumpSignals } from './signal';

export interface Finding {
  signatureId: string;
  signatureName: string;
  confidence: 'high' | 'medium' | 'low';
  confidenceScore: number;
  matchedConditions: MatchedCondition[];
  unmatchedConditions: UnmatchedCondition[];
  evidence: string[];
  nextSteps: string[];
  relatedSignatures: string[];
}

export interface MatchedCondition {
  field: string;
  description: string;
  observedValue: string | number;
}

export interface UnmatchedCondition {
  field: string;
  description: string;
  required: boolean;
}
