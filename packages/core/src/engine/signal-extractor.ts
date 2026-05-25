import { ThreadDumpSignals, StackFingerprint } from '../types/signal';

export interface ExtractedSignals {
  threadDumps: ThreadDumpSignals[];
  summary: ThreadDumpSummary;
}

export interface ThreadDumpSummary {
  maxThreadCount: number;
  avgThreadCount: number;
  dominantFingerprints: StackFingerprint[];
  persistentBlockedMonitors: string[];
  // Max threads waiting on a single monitor address across all dumps.
  // Useful for single-dump analysis — no second dump required.
  maxBlockedOnSingleMonitor: number;
  // Class name of the most-contended monitor (e.g. "com.zaxxer.hikari.pool.HikariPool")
  topBlockedMonitorClass: string;
  // Max number of distinct monitor addresses with blocked waiters in any single dump.
  // 2+ distinct blocked monitors in one dump is a deadlock indicator.
  blockedMonitorCount: number;
  // Max GC thread count across all dumps (threads named after JVM GC subsystems).
  gcThreadCount: number;
  ioSaturationDetected: boolean;
  threadCountAnomaly: boolean;
}

const THREAD_COUNT_THRESHOLD = 500;
const IO_THREAD_RATIO_THRESHOLD = 0.15;

export function extractSignals(dumps: ThreadDumpSignals[]): ExtractedSignals {
  if (dumps.length === 0) {
    return { threadDumps: dumps, summary: emptySummary() };
  }

  const maxThreadCount = Math.max(...dumps.map(d => d.totalThreadCount));
  const avgThreadCount = dumps.reduce((s, d) => s + d.totalThreadCount, 0) / dumps.length;

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

  const persistentBlockedMonitors = Array.from(monitorDumpCount.entries())
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
  const gcThreadCount = Math.max(...dumps.map(d => d.gcThreadCount));

  return {
    threadDumps: dumps,
    summary: {
      maxThreadCount,
      avgThreadCount,
      dominantFingerprints,
      persistentBlockedMonitors,
      maxBlockedOnSingleMonitor,
      topBlockedMonitorClass,
      blockedMonitorCount,
      gcThreadCount,
      ioSaturationDetected: avgIoRatio > IO_THREAD_RATIO_THRESHOLD,
      threadCountAnomaly: maxThreadCount > THREAD_COUNT_THRESHOLD
    }
  };
}

function emptySummary(): ThreadDumpSummary {
  return {
    maxThreadCount: 0,
    avgThreadCount: 0,
    dominantFingerprints: [],
    persistentBlockedMonitors: [],
    maxBlockedOnSingleMonitor: 0,
    topBlockedMonitorClass: '',
    blockedMonitorCount: 0,
    gcThreadCount: 0,
    ioSaturationDetected: false,
    threadCountAnomaly: false
  };
}
