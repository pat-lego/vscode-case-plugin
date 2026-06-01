import { ThreadDumpSignals, ThreadState, StackFingerprint } from '../../types/signal';
import { Thread } from '../../types/thread';

const GC_THREAD_PATTERN = /^(GC |MM |Finaliz|J9VMGCCompact|MemoryAlarm|GCWorker)/i;

const JVM_PREFIXES = [
  'java/', 'jdk/', 'sun/', 'com/sun/', 'javax/',
  'java.', 'jdk.', 'sun.', 'com.sun.', 'javax.',
];

function computeKeyFrame(frames: string[]): string {
  for (const frame of frames) {
    if (!JVM_PREFIXES.some(p => frame.startsWith(p))) return frame;
  }
  return frames[0] ?? '';
}

interface RawThread {
  name: string;
  state: ThreadState;
  frames: string[];
}

export function parseIbmJ9Threads(raw: string): Thread[] {
  return extractThreads(raw).map(t => ({
    name: t.name,
    state: t.state,
    // IBM J9 uses slash notation (java/lang/Thread); normalize to dots for consistent querying.
    frames: t.frames.map(f => f.replace(/\//g, '.')),
    topFrame: (t.frames[0] ?? '').replace(/\//g, '.'),
    keyFrame: computeKeyFrame(t.frames).replace(/\//g, '.'),
    monitorLines: [],
    lockedMonitors: [],
  }));
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
  const gcThreadCount = threads.filter(t => GC_THREAD_PATTERN.test(t.name)).length;
  const HTTP_REQUEST_PATTERN = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//;
  const activeRequestThreadCount = threads.filter(t => HTTP_REQUEST_PATTERN.test(t.name)).length;

  return {
    capturedAt,
    totalThreadCount: threads.length,
    stateCounts,
    stackFingerprints: fingerprints,
    blockedMonitors: [],
    ioThreadCount,
    gcThreadCount,
    activeRequestThreadCount,
    format: 'ibm-j9'
  };
}

function extractThreads(raw: string): RawThread[] {
  const threads: RawThread[] = [];
  const lines = raw.split('\n');
  let current: RawThread | null = null;

  for (const line of lines) {
    // IBM J9 thread header: 3XMTHREADINFO "thread-name" J9VMThread:... state:R ...
    const headerMatch = line.match(/^3XMTHREADINFO\s+"([^"]+)"/);
    if (headerMatch) {
      if (current) threads.push(current);
      current = { name: headerMatch[1], state: 'RUNNABLE', frames: [] };
      // State appears on the same header line: ... state:B ...
      const stateOnHeader = line.match(/state:(\w)/);
      if (stateOnHeader) current.state = ibmStateToThreadState(stateOnHeader[1]);
      continue;
    }

    if (!current) continue;

    // Some IBM J9 variants put state on a separate 3XMTHREADINFO3 continuation line.
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
    .map(([key, group]) => {
      const frames = group[0].frames;
      return {
        signature: key,
        count: group.length,
        topFrame: frames[0] ?? '',
        keyFrame: computeKeyFrame(frames),
        frames: frames.slice(0, 8),
        state: group[0].state,
        threadNames: group.map(t => t.name)
      };
    })
    .sort((a, b) => b.count - a.count);
}
