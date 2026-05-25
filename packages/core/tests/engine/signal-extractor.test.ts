import { describe, it, expect } from 'vitest';
import { extractSignals } from '../../src/engine/signal-extractor';
import { ThreadDumpSignals } from '../../src/types/signal';

function makeSignals(overrides: Partial<ThreadDumpSignals> = {}): ThreadDumpSignals {
  return {
    capturedAt: new Date(),
    totalThreadCount: 100,
    stateCounts: { RUNNABLE: 60, BLOCKED: 10, WAITING: 20, TIMED_WAITING: 10, NEW: 0, TERMINATED: 0 },
    stackFingerprints: [],
    blockedMonitors: [],
    ioThreadCount: 5,
    gcThreadCount: 4,
    format: 'jstack',
    ...overrides
  };
}

// ── Empty input ───────────────────────────────────────────────────────────────

describe('extractSignals — empty input', () => {
  const result = extractSignals([]);

  it('returns an empty summary for zero dumps', () => {
    expect(result.summary.totalThreadCount).toBe(0);
    expect(result.summary.blockedThreadCount).toBe(0);
    expect(result.summary.dominantFingerprintCount).toBe(0);
    expect(result.summary.persistentBlockedMonitors).toBe(0);
  });

  it('stores the empty threadDumps array', () => {
    expect(result.threadDumps).toHaveLength(0);
  });
});

// ── Single dump ───────────────────────────────────────────────────────────────

describe('extractSignals — single dump', () => {
  const dump = makeSignals();
  const result = extractSignals([dump]);

  it('totalThreadCount = max across dumps (only one dump)', () => {
    expect(result.summary.totalThreadCount).toBe(100);
  });

  it('avgThreadCount = totalThreadCount for a single dump', () => {
    expect(result.summary.avgThreadCount).toBe(100);
  });

  it('blockedThreadCount = BLOCKED state count from that dump', () => {
    expect(result.summary.blockedThreadCount).toBe(10);
  });

  it('waitingThreadCount = WAITING state count from that dump', () => {
    expect(result.summary.waitingThreadCount).toBe(20);
  });

  it('ioThreadCount = ioThreadCount from that dump', () => {
    expect(result.summary.ioThreadCount).toBe(5);
  });

  it('gcThreadCount = gcThreadCount from that dump', () => {
    expect(result.summary.gcThreadCount).toBe(4);
  });

  it('persistentBlockedMonitors = 0 with only one dump', () => {
    // Persistence requires 2+ dumps; a single dump can never have persistent monitors
    expect(result.summary.persistentBlockedMonitors).toBe(0);
  });
});

// ── Two dumps: max values ─────────────────────────────────────────────────────

describe('extractSignals — two dumps with different thread counts', () => {
  const dump1 = makeSignals({ totalThreadCount: 100, stateCounts: { RUNNABLE: 80, BLOCKED: 5, WAITING: 10, TIMED_WAITING: 5, NEW: 0, TERMINATED: 0 } });
  const dump2 = makeSignals({ totalThreadCount: 150, stateCounts: { RUNNABLE: 60, BLOCKED: 20, WAITING: 60, TIMED_WAITING: 10, NEW: 0, TERMINATED: 0 } });
  const result = extractSignals([dump1, dump2]);

  it('totalThreadCount is the max across both dumps', () => {
    expect(result.summary.totalThreadCount).toBe(150);
  });

  it('avgThreadCount is the mean', () => {
    expect(result.summary.avgThreadCount).toBe(125);
  });

  it('blockedThreadCount is the max BLOCKED count across dumps', () => {
    expect(result.summary.blockedThreadCount).toBe(20);
  });

  it('waitingThreadCount is the max WAITING count across dumps', () => {
    expect(result.summary.waitingThreadCount).toBe(60);
  });
});

// ── Persistent blocked monitors ───────────────────────────────────────────────

describe('extractSignals — persistent blocked monitors', () => {
  const monitor = {
    monitorAddress: '0xdeadbeef',
    monitorClass: 'com.example.Lock',
    waitingThreadCount: 3,
    lockHolderThread: 'holder-1',
    lockHolderStack: []
  };

  it('is 0 when the monitor appears in only 1 dump', () => {
    const d1 = makeSignals({ blockedMonitors: [monitor] });
    const d2 = makeSignals({ blockedMonitors: [] });
    const result = extractSignals([d1, d2]);
    expect(result.summary.persistentBlockedMonitors).toBe(0);
  });

  it('is 1 when the same monitor address appears in both dumps', () => {
    const d1 = makeSignals({ blockedMonitors: [monitor] });
    const d2 = makeSignals({ blockedMonitors: [{ ...monitor, waitingThreadCount: 4 }] });
    const result = extractSignals([d1, d2]);
    expect(result.summary.persistentBlockedMonitors).toBe(1);
  });

  it('tracks multiple persistent monitors independently', () => {
    const m2 = { ...monitor, monitorAddress: '0xcafebabe', monitorClass: 'com.example.OtherLock' };
    const d1 = makeSignals({ blockedMonitors: [monitor, m2] });
    const d2 = makeSignals({ blockedMonitors: [monitor, m2] });
    const result = extractSignals([d1, d2]);
    expect(result.summary.persistentBlockedMonitors).toBe(2);
  });
});

// ── maxBlockedOnSingleMonitor ─────────────────────────────────────────────────

describe('extractSignals — maxBlockedOnSingleMonitor', () => {
  it('picks the monitor with the highest waiter count across all dumps', () => {
    const d1 = makeSignals({
      blockedMonitors: [
        { monitorAddress: '0xaaaa', monitorClass: 'com.example.A', waitingThreadCount: 3, lockHolderStack: [] },
        { monitorAddress: '0xbbbb', monitorClass: 'com.example.B', waitingThreadCount: 8, lockHolderStack: [] }
      ]
    });
    const d2 = makeSignals({
      blockedMonitors: [
        { monitorAddress: '0xaaaa', monitorClass: 'com.example.A', waitingThreadCount: 5, lockHolderStack: [] }
      ]
    });
    const result = extractSignals([d1, d2]);
    expect(result.summary.maxBlockedOnSingleMonitor).toBe(8);
    expect(result.summary.topBlockedMonitorClass).toBe('com.example.B');
  });
});

// ── dominantFingerprintRatio ──────────────────────────────────────────────────

describe('extractSignals — dominantFingerprintRatio', () => {
  it('is 0 when there are no fingerprints', () => {
    const result = extractSignals([makeSignals({ stackFingerprints: [] })]);
    expect(result.summary.dominantFingerprintRatio).toBe(0);
  });

  it('computes ratio correctly when a large fingerprint is present', () => {
    const dump = makeSignals({
      totalThreadCount: 80,
      stackFingerprints: [
        { signature: 'a|b|c', count: 60, topFrame: 'a', state: 'RUNNABLE', threadNames: [] },
        { signature: 'd|e|f', count: 20, topFrame: 'd', state: 'WAITING',  threadNames: [] }
      ]
    });
    const result = extractSignals([dump]);
    // But note: the extractor only picks fingerprints that appear in 2+ dumps OR count > 50.
    // count=60 > 50, so it qualifies.
    expect(result.summary.dominantFingerprintCount).toBe(60);
    expect(result.summary.dominantFingerprintRatio).toBeCloseTo(60 / 80, 5);
  });
});

// ── Anomaly flags ─────────────────────────────────────────────────────────────

describe('extractSignals — anomaly flags', () => {
  it('threadCountAnomaly is 0 below the 500-thread threshold', () => {
    const result = extractSignals([makeSignals({ totalThreadCount: 499 })]);
    expect(result.summary.threadCountAnomaly).toBe(0);
  });

  it('threadCountAnomaly is 1 above the 500-thread threshold', () => {
    // Threshold is strictly greater-than (> 500), so 501 triggers it; 500 does not.
    const result = extractSignals([makeSignals({ totalThreadCount: 501 })]);
    expect(result.summary.threadCountAnomaly).toBe(1);
  });

  it('ioSaturationDetected is 0 when IO ratio is below 15%', () => {
    // 10 IO threads out of 100 = 10%
    const result = extractSignals([makeSignals({ totalThreadCount: 100, ioThreadCount: 10 })]);
    expect(result.summary.ioSaturationDetected).toBe(0);
  });

  it('ioSaturationDetected is 1 when IO ratio exceeds 15%', () => {
    // 20 IO threads out of 100 = 20%
    const result = extractSignals([makeSignals({ totalThreadCount: 100, ioThreadCount: 20 })]);
    expect(result.summary.ioSaturationDetected).toBe(1);
  });
});
