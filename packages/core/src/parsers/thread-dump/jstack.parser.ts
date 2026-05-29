import { ThreadDumpSignals, ThreadState, StackFingerprint, BlockedMonitor } from '../../types/signal';
import { Thread } from '../../types/thread';

// Matches JVM GC thread names across HotSpot (Parallel, G1, ZGC, Shenandoah), CMS, and IBM J9
const GC_THREAD_PATTERN = /^(GC |Gang |G1 |ConcurrentMark|concurrent mark|ZWorker|ZDirector|ZStat|ZRemap|Shenandoah|VM Thread|Finalizer|Reference Handler|Signal Dispatcher)/i;

interface RawThread {
  name: string;
  state: ThreadState;
  frames: string[];
  waitingOnMonitor?: string;
  waitingOnMonitorClass?: string;
  lockedMonitors: string[];
  nid?: string;
  elapsed?: number;
}

export function parseJstack(raw: string, capturedAt: Date): ThreadDumpSignals {
  const threads = extractThreads(raw);
  return buildSignals(threads, capturedAt, 'jstack');
}

export function parseJstackThreads(raw: string): Thread[] {
  return extractThreads(raw).map(rawToThread);
}

function rawToThread(t: RawThread): Thread {
  return {
    name: t.name,
    state: t.state,
    frames: t.frames,
    topFrame: t.frames[0] ?? '',
    keyFrame: computeKeyFrame(t.frames),
    waitingOnMonitor: t.waitingOnMonitor,
    waitingOnMonitorClass: t.waitingOnMonitorClass,
    lockedMonitors: t.lockedMonitors,
    nid: t.nid,
    elapsed: t.elapsed,
  };
}

function extractThreads(raw: string): RawThread[] {
  const threads: RawThread[] = [];
  // Each thread block starts with a quoted name
  const blocks = raw.split(/\n(?=")/);

  for (const block of blocks) {
    const thread = parseThreadBlock(block);
    if (thread) threads.push(thread);
  }

  return threads;
}

function parseThreadBlock(block: string): RawThread | null {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const headerMatch = lines[0].match(/^"([^"]+)"/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  let state: ThreadState = 'RUNNABLE';
  const frames: string[] = [];
  const lockedMonitors: string[] = [];
  let waitingOnMonitor: string | undefined;
  let waitingOnMonitorClass: string | undefined;

  const nidMatch     = lines[0].match(/\bnid=(0x[0-9a-f]+|\d+)/i);
  const elapsedMatch = lines[0].match(/\belapsed=(\d+(?:\.\d+)?)/);
  const nid     = nidMatch     ? nidMatch[1]              : undefined;
  const elapsed = elapsedMatch ? parseFloat(elapsedMatch[1]) : undefined;

  for (const line of lines) {
    const stateMatch = line.match(/java\.lang\.Thread\.State:\s+(\w+)/);
    if (stateMatch) {
      state = normalizeState(stateMatch[1]);
    }

    if (line.startsWith('at ')) {
      frames.push(line.replace(/^at\s+/, ''));
    }

    // Traditional synchronized-block contention: "- waiting to lock <0xABCD> (a ClassName)"
    const lockMatch = line.match(/- waiting to lock <(0x[0-9a-f]+)>(?:\s+\(a ([^)]+)\))?/);
    if (lockMatch) {
      waitingOnMonitor = lockMatch[1];
      if (lockMatch[2]) waitingOnMonitorClass = lockMatch[2];
    }

    // java.util.concurrent lock contention: "- parking to wait for <0xABCD> (a ConditionObject)"
    // This pattern appears when threads block on ReentrantLock/Semaphore/etc. instead of
    // synchronized blocks, and carries the same semantics for analysis purposes.
    if (!waitingOnMonitor) {
      const parkMatch = line.match(/- parking to wait for\s+<(0x[0-9a-f]+)>(?:\s+\(a ([^)]+)\))?/);
      if (parkMatch) {
        waitingOnMonitor = parkMatch[1];
        if (parkMatch[2]) waitingOnMonitorClass = parkMatch[2];
      }
    }

    const heldMatch = line.match(/- locked <(0x[0-9a-f]+)>/);
    if (heldMatch) lockedMonitors.push(heldMatch[1]);
  }

  return { name, state, frames, waitingOnMonitor, waitingOnMonitorClass, lockedMonitors, nid, elapsed };
}

function normalizeState(raw: string): ThreadState {
  switch (raw.toUpperCase()) {
    case 'RUNNABLE':       return 'RUNNABLE';
    case 'BLOCKED':        return 'BLOCKED';
    case 'WAITING':        return 'WAITING';
    case 'TIMED_WAITING':  return 'TIMED_WAITING';
    case 'NEW':            return 'NEW';
    case 'TERMINATED':     return 'TERMINATED';
    default:               return 'RUNNABLE';
  }
}

function buildSignals(threads: RawThread[], capturedAt: Date, format: 'jstack'): ThreadDumpSignals {
  const stateCounts: Record<ThreadState, number> = {
    RUNNABLE: 0, BLOCKED: 0, WAITING: 0, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0
  };

  for (const t of threads) stateCounts[t.state]++;

  const fingerprints = buildFingerprints(threads);
  const blockedMonitors = buildBlockedMonitors(threads);
  const ioThreadCount = threads.filter(t =>
    t.frames.some(f => f.startsWith('java.io.') || f.startsWith('sun.nio.') || f.startsWith('java.net.'))
  ).length;

  const gcThreadCount = threads.filter(t => GC_THREAD_PATTERN.test(t.name)).length;

  // Threads actively handling an HTTP request. Detects several naming conventions:
  //   Jetty/AEM:  "1.2.3.4 [timestamp] GET /path ..."
  //   WildFly/AS: "default task-N" (by frame pattern below is secondary; name alone is ambiguous)
  //   Spring Boot embedded Tomcat: "http-nio-NNNN-exec-N" with request URL in frames
  // Primary check: HTTP method token immediately followed by a path in the thread name.
  const HTTP_REQUEST_PATTERN = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\//;
  const activeRequestThreadCount = threads.filter(t => HTTP_REQUEST_PATTERN.test(t.name)).length;

  return {
    capturedAt,
    totalThreadCount: threads.length,
    stateCounts,
    stackFingerprints: fingerprints,
    blockedMonitors,
    ioThreadCount,
    gcThreadCount,
    activeRequestThreadCount,
    format
  };
}

// JVM and standard-library frame prefixes that are not meaningful for diagnosis.
// The first frame NOT matching these is the "key frame" — the real call site.
const JVM_PREFIXES = [
  'java.', 'jdk.', 'sun.', 'com.sun.', 'javax.',
  '[Ljava.', 'jdk.internal.',
];

function computeKeyFrame(frames: string[]): string {
  for (const frame of frames) {
    if (!JVM_PREFIXES.some(p => frame.startsWith(p))) return frame;
  }
  return frames[0] ?? '';
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
        urlPattern: extractUrlPattern(frames),
        topFrame: frames[0] ?? '',
        keyFrame: computeKeyFrame(frames),
        frames: frames.slice(0, 8),
        state: group[0].state,
        threadNames: group.map(t => t.name)
      };
    })
    .sort((a, b) => b.count - a.count);
}

function buildBlockedMonitors(threads: RawThread[]): BlockedMonitor[] {
  const waitMap = new Map<string, RawThread[]>();

  for (const t of threads) {
    if (t.waitingOnMonitor) {
      const existing = waitMap.get(t.waitingOnMonitor) ?? [];
      existing.push(t);
      waitMap.set(t.waitingOnMonitor, existing);
    }
  }

  return Array.from(waitMap.entries()).map(([addr, waiters]) => {
    const holder = threads.find(t => t.lockedMonitors.includes(addr));
    // Use the class captured directly from the "- waiting to lock <addr> (a ClassName)" line.
    // Falling back to 'unknown' if the class was not present in the dump.
    const monitorClass = waiters[0]?.waitingOnMonitorClass ?? 'unknown';

    return {
      monitorAddress: addr,
      monitorClass,
      waitingThreadCount: waiters.length,
      lockHolderThread: holder?.name,
      lockHolderStack: holder?.frames ?? [],
      waitingThreadNames: waiters.slice(0, 20).map(t => t.name)
    };
  });
}

function extractUrlPattern(frames: string[]): string | undefined {
  for (const frame of frames) {
    const match = frame.match(/([A-Z]+)\s+(\/[^\s]+)/);
    if (match) return `${match[1]} ${match[2]}`;
  }
  return undefined;
}
