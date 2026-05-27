import { ThreadDumpSignals, StackFingerprint } from '../types/signal';

export interface ExtractedSignals {
  threadDumps: ThreadDumpSignals[];
  summary: ThreadDumpSummary;
}

/**
 * All scalar fields use the exact names that signature YAML condition `field:` keys must
 * reference. Adding a new signal means adding a property here and computing it in
 * extractSignals() — no changes to the matcher are ever needed.
 *
 * Non-scalar fields (arrays) are suffixed with a plural noun and are NOT intended to be
 * referenced in signature conditions — they exist for evidence building and Claude context.
 */
export interface ThreadDumpSummary {
  // ── Thread count signals ──────────────────────────────────────────────────
  /** Maximum thread count observed across all dumps in the case. */
  totalThreadCount: number;
  /** Average thread count across all dumps. */
  avgThreadCount: number;
  /** Maximum number of BLOCKED threads observed in any single dump. */
  blockedThreadCount: number;
  /** Maximum number of WAITING threads observed in any single dump (excludes TIMED_WAITING). */
  waitingThreadCount: number;
  /** Maximum number of TIMED_WAITING threads observed in any single dump. */
  timedWaitingThreadCount: number;
  /**
   * Thread count of the dominant TIMED_WAITING fingerprint that is NOT an idle pool pattern.
   * Idle patterns (Jetty workers polling queues, scheduler idle threads, JVM cleaner, etc.)
   * are excluded so only genuinely stuck TIMED_WAITING threads are counted.
   */
  suspiciousTimedWaitingCount: number;
  /**
   * Key frame (first non-JVM frame) of the dominant suspicious TIMED_WAITING fingerprint.
   * Empty string when suspiciousTimedWaitingCount is 0.
   */
  suspiciousTimedWaitingKeyFrame: string;
  /** Maximum number of IO-bound threads observed in any single dump. */
  ioThreadCount: number;
  /** Maximum number of JVM GC subsystem threads observed in any single dump. */
  gcThreadCount: number;

  // ── Stack fingerprint signals ─────────────────────────────────────────────
  /** Thread count of the single most-common stack fingerprint. */
  dominantFingerprintCount: number;
  /** dominantFingerprintCount / totalThreadCount — fraction of threads on the same path. */
  dominantFingerprintRatio: number;

  // ── Lock / monitor signals ────────────────────────────────────────────────
  /** Count of monitor addresses that appeared blocked in 2 or more separate dumps. */
  persistentBlockedMonitors: number;
  /** Maximum number of threads waiting on any single monitor address across all dumps. */
  maxBlockedOnSingleMonitor: number;
  /** Class name of the most-contended monitor (e.g. "com.zaxxer.hikari.pool.HikariPool"). */
  topBlockedMonitorClass: string;
  /** Maximum count of distinct monitor addresses with blocked waiters in any single dump. */
  blockedMonitorCount: number;

  // ── Anomaly flags (numeric 0 | 1 for use in signature `eq` conditions) ────
  /** 1 if totalThreadCount exceeds the configured threshold (default 500), else 0. */
  threadCountAnomaly: number;
  /** 1 if the average IO-thread ratio exceeds 15%, else 0. */
  ioSaturationDetected: number;
  /**
   * Count of distinct monitor addresses where at least one waiter is in the
   * BLOCKED state (from a "synchronized" block -- "waiting to lock" lines).
   * This is distinct from blockedMonitorCount which includes JUC park monitors
   * (WAITING/TIMED_WAITING state, "parking to wait for" lines).
   * Used by deadlock detection to avoid false positives from AQS contention.
   */
  synchronizedBlockedMonitorCount: number;
  /**
   * Thread count of the largest RUNNABLE stack fingerprint.
   * Idle pool threads (WAITING/TIMED_WAITING) are excluded.
   * Used by hot-endpoint detection to avoid false positives on idle thread pools.
   */
  dominantActiveFingerprintCount: number;
  /** dominantActiveFingerprintCount / totalThreadCount */
  dominantActiveFingerprintRatio: number;

  // ── Internal arrays — for evidence building and Claude context only ────────
  dominantFingerprints: StackFingerprint[];
  persistentBlockedMonitorAddresses: string[];
}

const THREAD_COUNT_THRESHOLD = 500;
const IO_THREAD_RATIO_THRESHOLD = 0.15;

export function extractSignals(dumps: ThreadDumpSignals[]): ExtractedSignals {
  if (dumps.length === 0) {
    return { threadDumps: dumps, summary: emptySummary() };
  }

  const totalThreadCount = Math.max(...dumps.map(d => d.totalThreadCount));
  const avgThreadCount = dumps.reduce((s, d) => s + d.totalThreadCount, 0) / dumps.length;

  const blockedThreadCount    = Math.max(...dumps.map(d => d.stateCounts.BLOCKED       ?? 0));
  const waitingThreadCount    = Math.max(...dumps.map(d => d.stateCounts.WAITING       ?? 0));
  const timedWaitingThreadCount = Math.max(...dumps.map(d => d.stateCounts.TIMED_WAITING ?? 0));
  const ioThreadCount         = Math.max(...dumps.map(d => d.ioThreadCount));
  const gcThreadCount = Math.max(...dumps.map(d => d.gcThreadCount));

  const fingerprintMap = new Map<string, StackFingerprint[]>();
  for (const dump of dumps) {
    for (const fp of dump.stackFingerprints) {
      const existing = fingerprintMap.get(fp.signature) ?? [];
      existing.push(fp);
      fingerprintMap.set(fp.signature, existing);
    }
  }

  // Fingerprints that appear across multiple dumps are more significant
  const dominantFingerprints = Array.from(fingerprintMap.values())
    .filter(group => group.length > 1 || group[0].count > 50)
    .map(group => group.reduce((a, b) => a.count > b.count ? a : b))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const dominantFingerprintCount = dominantFingerprints[0]?.count ?? 0;
  const dominantFingerprintRatio = totalThreadCount > 0
    ? dominantFingerprintCount / totalThreadCount
    : 0;

  // Track how many dumps each monitor address appears in (persistence)
  // and the max waiters on any single monitor across all dumps (single-dump signal)
  const monitorDumpCount = new Map<string, number>();
  const monitorMaxWaiters = new Map<string, number>();
  const monitorClass = new Map<string, string>();

  for (const dump of dumps) {
    for (const monitor of dump.blockedMonitors) {
      monitorDumpCount.set(monitor.monitorAddress, (monitorDumpCount.get(monitor.monitorAddress) ?? 0) + 1);
      const prev = monitorMaxWaiters.get(monitor.monitorAddress) ?? 0;
      if (monitor.waitingThreadCount > prev) {
        monitorMaxWaiters.set(monitor.monitorAddress, monitor.waitingThreadCount);
        monitorClass.set(monitor.monitorAddress, monitor.monitorClass);
      }
    }
  }

  const persistentBlockedMonitorAddresses = Array.from(monitorDumpCount.entries())
    .filter(([, count]) => count > 1)
    .map(([addr]) => addr);

  // Find the monitor with the most waiters across all dumps
  let maxBlockedOnSingleMonitor = 0;
  let topBlockedMonitorClass = '';
  for (const [addr, waiters] of monitorMaxWaiters) {
    if (waiters > maxBlockedOnSingleMonitor) {
      maxBlockedOnSingleMonitor = waiters;
      topBlockedMonitorClass = monitorClass.get(addr) ?? '';
    }
  }

  // Identify TIMED_WAITING fingerprints that are NOT idle-pool patterns.
  // Known idle patterns: Jetty workers polling for jobs, scheduled-task executors waiting
  // for the next fire time, JVM cleaner/reference threads, OSGi framework gates, etc.
  const IDLE_TIMED_WAITING_KEY_FRAMES = [
    'BlockingArrayQueue',            // Jetty QueuedThreadPool idle worker
    'DelayedWorkQueue',              // ScheduledThreadPoolExecutor idle
    'LinkedBlockingQueue.take',      // ThreadPoolExecutor idle worker
    'ThreadGate.await',              // Apache Felix OSGi framework wait
    'ReferenceQueue',                // JVM reference-processing
    'CleanerImpl',                   // JVM Cleaner thread
    'ForkJoinPool.awaitWork',        // ForkJoinPool idle worker
    'AbstractEventExecutor',         // Netty event loop idle
    'NioEventLoop',                  // Netty NIO idle
    'EventDispatcher',               // Felix event dispatcher idle
    'ThreadPoolExecutor.getTask',    // Generic thread-pool worker waiting for work
  ];

  let suspiciousTimedWaitingCount = 0;
  let suspiciousTimedWaitingKeyFrame = '';
  for (const dump of dumps) {
    for (const fp of dump.stackFingerprints) {
      if (fp.state !== 'TIMED_WAITING') continue;
      const kf = fp.keyFrame ?? fp.topFrame;
      // Check keyFrame AND all stored frames — idle-pool threads (ScheduledThreadPoolExecutor,
      // Jetty, etc.) often have all-JDK stacks so keyFrame falls back to Unsafe.park, but the
      // idle pattern is still visible deeper in the frames array.
      const allFrameText = [kf, ...fp.frames].join('\n');
      if (IDLE_TIMED_WAITING_KEY_FRAMES.some(p => allFrameText.includes(p))) continue;
      if (fp.count > suspiciousTimedWaitingCount) {
        suspiciousTimedWaitingCount = fp.count;
        suspiciousTimedWaitingKeyFrame = kf;
      }
    }
  }

  const avgIoRatio = dumps.reduce((s, d) => s + d.ioThreadCount / d.totalThreadCount, 0) / dumps.length;
  const blockedMonitorCount = Math.max(...dumps.map(d => d.blockedMonitors.length));

  // synchronizedBlockedMonitorCount: monitors where waiters are in BLOCKED state
  // (synchronized block contention, not JUC park waits)
  const synchronizedBlockedMonitorCount = (() => {
    let count = 0;
    for (const dump of dumps) {
      const addrs = new Set<string>();
      for (const monitor of dump.blockedMonitors) {
        // A monitor with waiter thread names not yet known to be from parking --
        // we infer BLOCKED state by checking if the monitor address appears in
        // any fingerprint whose threads are in BLOCKED state.
        const isFromBlocked = dump.stackFingerprints.some(
          fp => fp.state === 'BLOCKED' && fp.threadNames.some(
            name => monitor.waitingThreadNames.includes(name)
          )
        );
        if (isFromBlocked) addrs.add(monitor.monitorAddress);
      }
      if (addrs.size > count) count = addrs.size;
    }
    return count;
  })();

  // dominantActiveFingerprintCount / Ratio: only RUNNABLE fingerprints
  const runnableFingerprints = Array.from(fingerprintMap.values())
    .map(group => group.reduce((a, b) => a.count > b.count ? a : b))
    .filter(fp => fp.state === 'RUNNABLE')
    .sort((a, b) => b.count - a.count);
  const dominantActiveFingerprintCount = runnableFingerprints[0]?.count ?? 0;
  const dominantActiveFingerprintRatio = totalThreadCount > 0
    ? dominantActiveFingerprintCount / totalThreadCount
    : 0;

  return {
    threadDumps: dumps,
    summary: {
      totalThreadCount,
      avgThreadCount,
      blockedThreadCount,
      waitingThreadCount,
      timedWaitingThreadCount,
      suspiciousTimedWaitingCount,
      suspiciousTimedWaitingKeyFrame,
      ioThreadCount,
      gcThreadCount,
      dominantFingerprintCount,
      dominantFingerprintRatio,
      persistentBlockedMonitors: persistentBlockedMonitorAddresses.length,
      maxBlockedOnSingleMonitor,
      topBlockedMonitorClass,
      blockedMonitorCount,
      threadCountAnomaly: totalThreadCount > THREAD_COUNT_THRESHOLD ? 1 : 0,
      ioSaturationDetected: avgIoRatio > IO_THREAD_RATIO_THRESHOLD ? 1 : 0,
      synchronizedBlockedMonitorCount,
      dominantActiveFingerprintCount,
      dominantActiveFingerprintRatio,
      dominantFingerprints,
      persistentBlockedMonitorAddresses
    }
  };
}

function emptySummary(): ThreadDumpSummary {
  return {
    totalThreadCount: 0,
    avgThreadCount: 0,
    blockedThreadCount: 0,
    waitingThreadCount: 0,
    timedWaitingThreadCount: 0,
    suspiciousTimedWaitingCount: 0,
    suspiciousTimedWaitingKeyFrame: '',
    ioThreadCount: 0,
    gcThreadCount: 0,
    dominantFingerprintCount: 0,
    dominantFingerprintRatio: 0,
    persistentBlockedMonitors: 0,
    maxBlockedOnSingleMonitor: 0,
    topBlockedMonitorClass: '',
    blockedMonitorCount: 0,
    threadCountAnomaly: 0,
    ioSaturationDetected: 0,
    synchronizedBlockedMonitorCount: 0,
    dominantActiveFingerprintCount: 0,
    dominantActiveFingerprintRatio: 0,
    dominantFingerprints: [],
    persistentBlockedMonitorAddresses: []
  };
}
