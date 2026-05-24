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

  const monitorMap = new Map<string, number>();
  for (const dump of dumps) {
    for (const monitor of dump.blockedMonitors) {
      monitorMap.set(monitor.monitorAddress, (monitorMap.get(monitor.monitorAddress) ?? 0) + 1);
    }
  }
  const persistentBlockedMonitors = Array.from(monitorMap.entries())
    .filter(([, count]) => count > 1)
    .map(([addr]) => addr);

  const avgIoRatio = dumps.reduce((s, d) => s + d.ioThreadCount / d.totalThreadCount, 0) / dumps.length;

  return {
    threadDumps: dumps,
    summary: {
      maxThreadCount,
      avgThreadCount,
      dominantFingerprints,
      persistentBlockedMonitors,
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
    ioSaturationDetected: false,
    threadCountAnomaly: false
  };
}
