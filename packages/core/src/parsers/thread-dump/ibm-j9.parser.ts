import { ThreadDumpSignals, ThreadState, StackFingerprint, BlockedMonitor } from '../../types/signal';

interface RawThread {
  name: string;
  state: ThreadState;
  frames: string[];
}

export function parseIbmJ9(raw: string, capturedAt: Date): ThreadDumpSignals {
  const threads = extractThreads(raw);

  const stateCounts: Record<ThreadState, number> = {
    RUNNABLE: 0, BLOCKED: 0, WAITING: 0, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0
  };
  for (const t of threads) stateCounts[t.state]++;

  const fingerprints = buildFingerprints(threads);
  const ioThreadCount = threads.filter(t =>
    t.frames.some(f => f.includes('java/io/') || f.includes('java/net/'))
  ).length;

  return {
    capturedAt,
    totalThreadCount: threads.length,
    stateCounts,
    stackFingerprints: fingerprints,
    blockedMonitors: [],
    ioThreadCount,
    format: 'ibm-j9'
  };
}

function extractThreads(raw: string): RawThread[] {
  const threads: RawThread[] = [];
  const lines = raw.split('\n');
  let current: RawThread | null = null;

  for (const line of lines) {
    // IBM J9 thread header: 3XMTHREADINFO "thread-name" ...
    const headerMatch = line.match(/^3XMTHREADINFO\s+"([^"]+)"/);
    if (headerMatch) {
      if (current) threads.push(current);
      current = { name: headerMatch[1], state: 'RUNNABLE', frames: [] };
      continue;
    }

    if (!current) continue;

    // State line: 3XMTHREADINFO3 ... state:R
    const stateMatch = line.match(/3XMTHREADINFO3.*state:(\w)/);
    if (stateMatch) {
      current.state = ibmStateToThreadState(stateMatch[1]);
    }

    // Stack frame: 4XESTACKTRACE at java/lang/Thread.run(Thread.java:834)
    const frameMatch = line.match(/4XESTACKTRACE\s+at\s+(.+)/);
    if (frameMatch) {
      current.frames.push(frameMatch[1].trim());
    }
  }

  if (current) threads.push(current);
  return threads;
}

function ibmStateToThreadState(ibmState: string): ThreadState {
  switch (ibmState) {
    case 'R': return 'RUNNABLE';
    case 'B': return 'BLOCKED';
    case 'W': return 'WAITING';
    case 'T': return 'TIMED_WAITING';
    default:  return 'RUNNABLE';
  }
}

function buildFingerprints(threads: RawThread[]): StackFingerprint[] {
  const map = new Map<string, RawThread[]>();

  for (const t of threads) {
    if (t.frames.length === 0) continue;
    const key = t.frames.slice(0, 3).join('|');
    const existing = map.get(key) ?? [];
    existing.push(t);
    map.set(key, existing);
  }

  return Array.from(map.entries())
    .map(([key, group]) => ({
      signature: key,
      count: group.length,
      topFrame: group[0].frames[0] ?? '',
      state: group[0].state,
      threadNames: group.map(t => t.name)
    }))
    .sort((a, b) => b.count - a.count);
}
