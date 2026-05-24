export interface Signature {
  id: string;
  name: string;
  description: string;
  version: string;
  conditions: SignatureCondition[];
  indicators: string[];
  nextSteps: string[];
  relatedSignatures: string[];
}

export interface SignatureCondition {
  field: string;
  operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'contains' | 'matches';
  value: number | string;
  description: string;
}
