import { ThreadDumpSignals, ThreadState, StackFingerprint } from '../../types/signal';

const GC_THREAD_PATTERN = /^(GC |Gang |G1 |ConcurrentMark|concurrent mark|ZWorker|Shenandoah|MM |GCWorker)/i;

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
    keyFrame: frames[0] ?? '',
    frames: frames.slice(0, 8),
    state: 'RUNNABLE',
    threadNames: []
  };

  // Best-effort GC thread count from raw text lines that look like GC thread headers
  const gcThreadCount = raw.split('\n')
    .filter(line => GC_THREAD_PATTERN.test(line.trim()))
    .length;

  const HTTP_REQUEST_PATTERN = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//;
  const activeRequestThreadCount = raw.split('\n')
    .filter(line => HTTP_REQUEST_PATTERN.test(line))
    .length;

  return {
    capturedAt,
    totalThreadCount,
    stateCounts,
    stackFingerprints: frames.length > 0 ? [fingerprint] : [],
    blockedMonitors: [],
    ioThreadCount: frames.filter(f => f.startsWith('java.io.') || f.startsWith('sun.nio.')).length,
    gcThreadCount,
    activeRequestThreadCount,
    format: 'generic'
  };
}
