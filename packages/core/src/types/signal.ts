export interface ThreadDumpSignals {
  capturedAt: Date;
  totalThreadCount: number;
  stateCounts: Record<ThreadState, number>;
  stackFingerprints: StackFingerprint[];
  blockedMonitors: BlockedMonitor[];
  ioThreadCount: number;
  format: ThreadDumpFormat;
}

export type ThreadState = 'RUNNABLE' | 'BLOCKED' | 'WAITING' | 'TIMED_WAITING' | 'NEW' | 'TERMINATED';

export type ThreadDumpFormat = 'jstack' | 'ibm-j9' | 'generic';

export interface StackFingerprint {
  signature: string;
  count: number;
  urlPattern?: string;
  topFrame: string;
  state: ThreadState;
  threadNames: string[];
}

export interface BlockedMonitor {
  monitorAddress: string;
  monitorClass: string;
  waitingThreadCount: number;
  lockHolderThread?: string;
  lockHolderStack: string[];
}
