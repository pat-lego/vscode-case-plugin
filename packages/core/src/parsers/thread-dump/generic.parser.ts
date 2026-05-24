import { ThreadDumpSignals, ThreadState, StackFingerprint, BlockedMonitor } from '../../types/signal';

export function parseGeneric(raw: string, capturedAt: Date): ThreadDumpSignals {
  const lines = raw.split('\n');
  const frames: string[] = [];
  let totalThreadCount = 0;

  // Heuristic: count thread-like blocks and collect stack frames
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('at ') || trimmed.match(/^\w[\w.$]+\([\w.$]+:\d+\)/)) {
      frames.push(trimmed.replace(/^at\s+/, ''));
    }
    // Count lines that look like thread headers
    if (trimmed.match(/^"[^"]+"/) || trimmed.match(/Thread-\d+/i)) {
      totalThreadCount++;
    }
  }

  if (totalThreadCount === 0) totalThreadCount = 1;

  const stateCounts: Record<ThreadState, number> = {
    RUNNABLE: totalThreadCount, BLOCKED: 0, WAITING: 0, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0
  };

  const fingerprint: StackFingerprint = {
    signature: frames.slice(0, 3).join('|'),
    count: totalThreadCount,
    topFrame: frames[0] ?? '',
    state: 'RUNNABLE',
    threadNames: []
  };

  return {
    capturedAt,
    totalThreadCount,
    stateCounts,
    stackFingerprints: frames.length > 0 ? [fingerprint] : [],
    blockedMonitors: [],
    ioThreadCount: frames.filter(f => f.startsWith('java.io.') || f.startsWith('sun.nio.')).length,
    format: 'generic'
  };
}
