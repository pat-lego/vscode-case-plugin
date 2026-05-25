import { ThreadDumpSignals, ThreadState, StackFingerprint, BlockedMonitor } from '../../types/signal';

// Matches JVM GC thread names across HotSpot (Parallel, G1, ZGC, Shenandoah), CMS, and IBM J9
const GC_THREAD_PATTERN = /^(GC |Gang |G1 |ConcurrentMark|concurrent mark|ZWorker|ZDirector|ZStat|ZRemap|Shenandoah|VM Thread|Finalizer|Reference Handler|Signal Dispatcher)/i;

interface RawThread {
  name: string;
  state: ThreadState;
  frames: string[];
  waitingOnMonitor?: string;
  waitingOnMonitorClass?: string;
  lockedMonitors: string[];
}

export function parseJstack(raw: string, capturedAt: Date): ThreadDumpSignals {
  const threads = extractThreads(raw);
  return buildSignals(threads, capturedAt, 'jstack');
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

  for (const line of lines) {
    const stateMatch = line.match(/java\.lang\.Thread\.State:\s+(\w+)/);
    if (stateMatch) {
      state = normalizeState(stateMatch[1]);
    }

    if (line.startsWith('at ')) {
      frames.push(line.replace(/^at\s+/, ''));
    }

    // Capture both the monitor address and the class name from the same lock line:
    //   - waiting to lock <0xABCD> (a com.example.SomeClass)
    const lockMatch = line.match(/- waiting to lock <(0x[0-9a-f]+)>(?:\s+\(a ([^)]+)\))?/);
    if (lockMatch) {
      waitingOnMonitor = lockMatch[1];
      if (lockMatch[2]) waitingOnMonitorClass = lockMatch[2];
    }

    const heldMatch = line.match(/- locked <(0x[0-9a-f]+)>/);
    if (heldMatch) lockedMonitors.push(heldMatch[1]);
  }

  return { name, state, frames, waitingOnMonitor, waitingOnMonitorClass, lockedMonitors };
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

  return {
    capturedAt,
    totalThreadCount: threads.length,
    stateCounts,
    stackFingerprints: fingerprints,
    blockedMonitors,
    ioThreadCount,
    gcThreadCount,
    format
  };
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
      urlPattern: extractUrlPattern(group[0].frames),
      topFrame: group[0].frames[0] ?? '',
      state: group[0].state,
      threadNames: group.map(t => t.name)
    }))
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
      lockHolderStack: holder?.frames ?? []
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
