export interface Case {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  status: 'open' | 'resolved';
  evidence: EvidenceItem[];
  resolution?: string;
  resolvedBy?: string;
  notes?: string;
}

export interface EvidenceItem {
  id: string;
  type: 'thread-dump' | 'log-export' | 'screenshot' | 'top-output' | 'generic';
  source: string;
  capturedAt: Date;
  filePath: string;
  rawContent?: string;
  group?: string;
  displayName?: string;
}
