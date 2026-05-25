import { describe, it, expect } from 'vitest';
import { matchSignatures } from '../../src/engine/signature-matcher';
import { extractSignals } from '../../src/engine/signal-extractor';
import { Signature } from '../../src/types/signature';
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

function makeSig(conditions: Signature['conditions']): Signature {
  return {
    id: 'test',
    name: 'Test Signature',
    description: 'Test',
    version: '1.0',
    conditions,
    indicators: [],
    nextSteps: ['Check something'],
    relatedSignatures: []
  };
}

// ── Operator: gt / gte / lt / lte ────────────────────────────────────────────

describe('signature-matcher — numeric operators', () => {
  const signals = extractSignals([makeSignals({ totalThreadCount: 100 })]);

  it('gt: fires when value is strictly greater', () => {
    const sig = makeSig([{ field: 'totalThreadCount', operator: 'gt', value: 99, description: 'test' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('gt: does not fire when value equals threshold', () => {
    const sig = makeSig([{ field: 'totalThreadCount', operator: 'gt', value: 100, description: 'test' }]);
    const findings = matchSignatures(signals, [sig]);
    expect(findings).toHaveLength(0);
  });

  it('gte: fires when value equals threshold', () => {
    const sig = makeSig([{ field: 'totalThreadCount', operator: 'gte', value: 100, description: 'test' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('lt: fires when value is strictly less', () => {
    const sig = makeSig([{ field: 'totalThreadCount', operator: 'lt', value: 101, description: 'test' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('lte: fires when value equals threshold', () => {
    const sig = makeSig([{ field: 'totalThreadCount', operator: 'lte', value: 100, description: 'test' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });
});

// ── Operator: eq ─────────────────────────────────────────────────────────────

describe('signature-matcher — eq operator', () => {
  it('fires for a numeric flag that is exactly 1', () => {
    // threadCountAnomaly = 1 when totalThreadCount >= 500
    const signals = extractSignals([makeSignals({ totalThreadCount: 600 })]);
    const sig = makeSig([{ field: 'threadCountAnomaly', operator: 'eq', value: 1, description: 'flag set' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('does not fire when the flag is 0', () => {
    const signals = extractSignals([makeSignals({ totalThreadCount: 100 })]);
    const sig = makeSig([{ field: 'threadCountAnomaly', operator: 'eq', value: 1, description: 'flag set' }]);
    expect(matchSignatures(signals, [sig])).toHaveLength(0);
  });
});

// ── Operator: contains / matches ─────────────────────────────────────────────

describe('signature-matcher — string operators', () => {
  const signals = extractSignals([makeSignals({
    blockedMonitors: [{
      monitorAddress: '0xc0ffee',
      monitorClass: 'com.zaxxer.hikari.pool.HikariPool',
      waitingThreadCount: 7,
      lockHolderStack: []
    }]
  })]);

  it('contains: fires when the string includes the substring', () => {
    const sig = makeSig([{ field: 'topBlockedMonitorClass', operator: 'contains', value: 'hikari', description: 'pool class' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('contains: is case-sensitive — substring absent from the string does not match', () => {
    // 'com.zaxxer.hikari.pool.HikariPool' does not contain 'HIKARI' (all caps)
    const sig = makeSig([{ field: 'topBlockedMonitorClass', operator: 'contains', value: 'HIKARI', description: 'pool class' }]);
    expect(matchSignatures(signals, [sig])).toHaveLength(0);
  });

  it('matches: fires when regex matches the class name', () => {
    const sig = makeSig([{ field: 'topBlockedMonitorClass', operator: 'matches', value: '(?i)(hikari|c3p0|dbcp)', description: 'pool class' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('matches: does not fire when regex has no match', () => {
    const sig = makeSig([{ field: 'topBlockedMonitorClass', operator: 'matches', value: 'redis|memcached', description: 'pool class' }]);
    expect(matchSignatures(signals, [sig])).toHaveLength(0);
  });
});

// ── Confidence scoring ────────────────────────────────────────────────────────

describe('signature-matcher — confidence scoring', () => {
  const signals = extractSignals([makeSignals({ totalThreadCount: 100 })]);

  it('assigns high confidence when all conditions match', () => {
    // Two conditions, both matching → score = 1.0 → 'high'
    const sig = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 50,  description: 'many threads' },
      { field: 'totalThreadCount', operator: 'lte', value: 200, description: 'not too many' }
    ]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidence).toBe('high');
    expect(finding.confidenceScore).toBe(1);
  });

  it('assigns medium confidence for a partial match (50%+)', () => {
    // 2-of-4 conditions match → score = 0.5 → 'medium'
    const sig = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 50,   description: 'ok' },     // match
      { field: 'totalThreadCount', operator: 'lte', value: 200,  description: 'ok' },     // match
      { field: 'blockedThreadCount', operator: 'gte', value: 50, description: 'fail' },   // no match (only 10)
      { field: 'waitingThreadCount', operator: 'gte', value: 50, description: 'fail' }    // no match (only 20)
    ]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidence).toBe('medium');
    expect(finding.confidenceScore).toBe(0.5);
  });

  it('filters out findings where no conditions matched', () => {
    const sig = makeSig([
      { field: 'blockedThreadCount', operator: 'gte', value: 9999, description: 'impossible' }
    ]);
    expect(matchSignatures(signals, [sig])).toHaveLength(0);
  });

  it('sorts findings by confidenceScore descending', () => {
    const sigFull = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 50, description: 'ok' }
    ]);
    sigFull.id = 'full';

    const sigPartial = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 50, description: 'ok' },
      { field: 'blockedThreadCount', operator: 'gte', value: 9999, description: 'fail' }
    ]);
    sigPartial.id = 'partial';

    const findings = matchSignatures(signals, [sigPartial, sigFull]);
    expect(findings[0].confidenceScore).toBeGreaterThanOrEqual(findings[1].confidenceScore);
  });
});

// ── Unknown fields ────────────────────────────────────────────────────────────

describe('signature-matcher — unknown field handling', () => {
  it('treats a completely unknown field as unmatched (does not throw)', () => {
    const signals = extractSignals([makeSignals()]);
    const sig = makeSig([{ field: 'nonExistentSignalField', operator: 'gte', value: 1, description: 'unknown' }]);
    // Should not throw — unknown fields silently fail to match
    expect(() => matchSignatures(signals, [sig])).not.toThrow();
    expect(matchSignatures(signals, [sig])).toHaveLength(0);
  });

  it('matched conditions are reported in the finding', () => {
    const signals = extractSignals([makeSignals({ totalThreadCount: 200 })]);
    const sig = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 100, description: 'high thread count' }
    ]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.matchedConditions).toHaveLength(1);
    expect(finding.matchedConditions[0].field).toBe('totalThreadCount');
    expect(finding.matchedConditions[0].observedValue).toBe(200);
  });

  it('unmatched conditions are reported in the finding', () => {
    const signals = extractSignals([makeSignals({ totalThreadCount: 50 })]);
    const sig = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 100, description: 'needs 100+' }
    ]);
    const findings = matchSignatures(signals, [sig]);
    // Score is 0, so this finding is filtered out — but let's verify with a partial match
    const sig2 = makeSig([
      { field: 'totalThreadCount', operator: 'gte', value: 10,  description: 'match'  },
      { field: 'totalThreadCount', operator: 'gte', value: 999, description: 'no match' }
    ]);
    const [finding] = matchSignatures(signals, [sig2]);
    expect(finding.unmatchedConditions).toHaveLength(1);
    expect(finding.unmatchedConditions[0].field).toBe('totalThreadCount');
  });
});

// ── Architecture: data-driven field resolution ────────────────────────────────
//
// This is the key architectural guarantee: any primitive field added to
// ThreadDumpSummary in signal-extractor.ts is automatically resolvable by
// any signature YAML. No changes to signature-matcher.ts are needed.

describe('signature-matcher — data-driven field resolution', () => {
  it('resolves all documented scalar fields without a switch statement', () => {
    const signals = extractSignals([makeSignals({
      totalThreadCount: 300,
      stateCounts: { RUNNABLE: 200, BLOCKED: 30, WAITING: 60, TIMED_WAITING: 10, NEW: 0, TERMINATED: 0 },
      ioThreadCount: 50,
      gcThreadCount: 6,
      blockedMonitors: [
        { monitorAddress: '0x1234', monitorClass: 'com.example.Pool', waitingThreadCount: 8, lockHolderStack: [] }
      ]
    })]);

    const fieldAssertions: Array<[string, Signature['conditions'][0]['operator'], number | string]> = [
      ['totalThreadCount',        'gte', 300],
      ['blockedThreadCount',      'gte', 30],
      ['waitingThreadCount',      'gte', 60],
      ['ioThreadCount',           'gte', 50],
      ['gcThreadCount',           'gte', 6],
      ['maxBlockedOnSingleMonitor','gte', 8],
      ['topBlockedMonitorClass',  'contains', 'Pool'],
      ['blockedMonitorCount',     'gte', 1],
    ];

    for (const [field, operator, value] of fieldAssertions) {
      const sig = makeSig([{ field, operator, value, description: `${field} test` }]);
      const findings = matchSignatures(signals, [sig]);
      expect(findings.length, `field '${field}' with operator '${operator}' should resolve and match`).toBeGreaterThan(0);
    }
  });

  it('resolves ioSaturationDetected (numeric flag)', () => {
    const signals = extractSignals([makeSignals({ totalThreadCount: 100, ioThreadCount: 20 })]);
    const sig = makeSig([{ field: 'ioSaturationDetected', operator: 'eq', value: 1, description: 'io sat' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });

  it('resolves threadCountAnomaly (numeric flag)', () => {
    const signals = extractSignals([makeSignals({ totalThreadCount: 600 })]);
    const sig = makeSig([{ field: 'threadCountAnomaly', operator: 'eq', value: 1, description: 'anomaly' }]);
    const [finding] = matchSignatures(signals, [sig]);
    expect(finding.confidenceScore).toBe(1);
  });
});

// ── Bundled signature scenarios ───────────────────────────────────────────────

describe('signature-matcher — bundled signature scenarios', () => {

  it('detects a deadlock: 2+ blocked monitors and 2+ BLOCKED threads', () => {
    const signals = extractSignals([makeSignals({
      stateCounts: { RUNNABLE: 10, BLOCKED: 3, WAITING: 5, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0 },
      blockedMonitors: [
        { monitorAddress: '0xaaaa', monitorClass: 'com.example.ResourceA', waitingThreadCount: 1, lockHolderStack: [] },
        { monitorAddress: '0xbbbb', monitorClass: 'com.example.ResourceB', waitingThreadCount: 2, lockHolderStack: [] }
      ]
    })]);

    const deadlockSig: Signature = {
      id: 'deadlock',
      name: 'Thread Deadlock',
      description: '',
      version: '1.1',
      conditions: [
        { field: 'blockedMonitorCount', operator: 'gte', value: 2, description: '2+ distinct blocked monitors' },
        { field: 'blockedThreadCount',  operator: 'gte', value: 2, description: '2+ BLOCKED threads' }
      ],
      indicators: [],
      nextSteps: [],
      relatedSignatures: []
    };

    const [finding] = matchSignatures(signals, [deadlockSig]);
    expect(finding.confidenceScore).toBe(1);
    expect(finding.confidence).toBe('high');
  });

  it('detects DB pool exhaustion: 5+ threads on one monitor matching a pool class', () => {
    const signals = extractSignals([makeSignals({
      stateCounts: { RUNNABLE: 5, BLOCKED: 7, WAITING: 10, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0 },
      blockedMonitors: [
        { monitorAddress: '0xpool', monitorClass: 'com.zaxxer.hikari.pool.HikariPool', waitingThreadCount: 7, lockHolderStack: [] }
      ]
    })]);

    const dbSig: Signature = {
      id: 'db-pool-exhaustion',
      name: 'DB Pool Exhaustion',
      description: '',
      version: '1.1',
      conditions: [
        { field: 'maxBlockedOnSingleMonitor', operator: 'gte', value: 5, description: '5+ threads on one monitor' },
        { field: 'topBlockedMonitorClass', operator: 'matches', value: '(?i)(hikari|c3p0|dbcp)', description: 'pool class' }
      ],
      indicators: [],
      nextSteps: [],
      relatedSignatures: []
    };

    const [finding] = matchSignatures(signals, [dbSig]);
    expect(finding.confidenceScore).toBe(1);
    expect(finding.confidence).toBe('high');
  });

  it('detects a hot endpoint: 50+ threads on one fingerprint, 25%+ ratio', () => {
    const signals = extractSignals([makeSignals({
      totalThreadCount: 80,
      stackFingerprints: [
        { signature: 'a|b|c', count: 60, topFrame: 'com.example.ProductController.get', state: 'RUNNABLE', threadNames: [] },
        { signature: 'd|e|f', count: 20, topFrame: 'other', state: 'WAITING', threadNames: [] }
      ]
    })]);

    const hotSig: Signature = {
      id: 'hot-endpoint',
      name: 'Hot Endpoint',
      description: '',
      version: '1.1',
      conditions: [
        { field: 'dominantFingerprintCount', operator: 'gte', value: 50,   description: '50+ on same stack' },
        { field: 'dominantFingerprintRatio', operator: 'gte', value: 0.25, description: '25%+ ratio' }
      ],
      indicators: [],
      nextSteps: [],
      relatedSignatures: []
    };

    const [finding] = matchSignatures(signals, [hotSig]);
    expect(finding.confidenceScore).toBe(1);
  });
});
