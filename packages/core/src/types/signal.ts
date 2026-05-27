export interface ThreadDumpSignals {
  capturedAt: Date;
  totalThreadCount: number;
  stateCounts: Record<ThreadState, number>;
  stackFingerprints: StackFingerprint[];
  blockedMonitors: BlockedMonitor[];
  ioThreadCount: number;
  // Threads whose names match JVM GC patterns (e.g. "GC task thread#0", "G1 Conc#0").
  // These are always present — a non-zero count doesn't mean a pause is active.
  // A very high count relative to the app can indicate heavy GC activity.
  gcThreadCount: number;
  format: ThreadDumpFormat;
}

export type ThreadState = 'RUNNABLE' | 'BLOCKED' | 'WAITING' | 'TIMED_WAITING' | 'NEW' | 'TERMINATED';

export type ThreadDumpFormat = 'jstack' | 'ibm-j9' | 'generic';

export interface StackFingerprint {
  signature: string;
  count: number;
  urlPattern?: string;
  /** Raw top-of-stack frame (often a JVM internal like Unsafe.park — rarely useful alone). */
  topFrame: string;
  /**
   * First non-JVM frame in the stack — the real entry point.
   * e.g. "org.apache.http.pool.AbstractConnPool.getPoolEntryBlocking" instead of "Unsafe.park".
   */
  keyFrame: string;
  /** Top 8 frames kept for snippet display in the UI. */
  frames: string[];
  state: ThreadState;
  threadNames: string[];
}

export interface BlockedMonitor {
  monitorAddress: string;
  monitorClass: string;
  waitingThreadCount: number;
  lockHolderThread?: string;
  lockHolderStack: string[];
  waitingThreadNames: string[];
}
