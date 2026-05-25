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
  /** Maximum number of WAITING/TIMED_WAITING threads observed in any single dump. */
  waitingThreadCount: number;
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

  const blockedThreadCount = Math.max(...dumps.map(d => d.stateCounts.BLOCKED ?? 0));
  const waitingThreadCount = Math.max(...dumps.map(d => d.stateCounts.WAITING ?? 0));
  const ioThreadCount = Math.max(...dumps.map(d => d.ioThreadCount));
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

  const avgIoRatio = dumps.reduce((s, d) => s + d.ioThreadCount / d.totalThreadCount, 0) / dumps.length;
  const blockedMonitorCount = Math.max(...dumps.map(d => d.blockedMonitors.length));

  return {
    threadDumps: dumps,
    summary: {
      totalThreadCount,
      avgThreadCount,
      blockedThreadCount,
      waitingThreadCount,
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
    dominantFingerprints: [],
    persistentBlockedMonitorAddresses: []
  };
}
