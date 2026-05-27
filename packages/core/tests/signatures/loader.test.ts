import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { loadSignaturesFromDir } from '../../src/signatures/loader';

// ── IO: writing to disk then reading back ─────────────────────────────────────

let tempDir: string;

afterEach(() => {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  tempDir = mkdtempSync(path.join(tmpdir(), 'incident-investigator-test-'));
  return tempDir;
}

const MINIMAL_SIGNATURE = `
id: test-sig
name: Test Signature
description: A minimal signature for testing
version: "1.0"
conditions:
  - field: blockedThreadCount
    operator: gte
    value: 10
    description: 10+ BLOCKED threads
indicators:
  - "Many blocked threads"
nextSteps:
  - "Check the lock holder"
relatedSignatures:
  - db-pool-exhaustion
`;

// ── Non-existent / empty directory ────────────────────────────────────────────

describe('loadSignaturesFromDir — non-existent or empty directory', () => {
  it('returns an empty array for a path that does not exist', () => {
    const result = loadSignaturesFromDir('/this/path/does/not/exist/at/all');
    expect(result).toEqual([]);
  });

  it('returns an empty array for an existing but empty directory', () => {
    const dir = createTempDir();
    const result = loadSignaturesFromDir(dir);
    expect(result).toEqual([]);
  });
});

// ── Reading a single signature ────────────────────────────────────────────────

describe('loadSignaturesFromDir — reads a YAML file written to disk', () => {
  it('loads a valid signature YAML and returns a typed Signature object', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'test-sig.yaml'), MINIMAL_SIGNATURE, 'utf-8');

    const results = loadSignaturesFromDir(dir);

    expect(results).toHaveLength(1);
    const sig = results[0];
    expect(sig.id).toBe('test-sig');
    expect(sig.name).toBe('Test Signature');
    expect(sig.version).toBe('1.0');
  });

  it('parses conditions correctly', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'test-sig.yaml'), MINIMAL_SIGNATURE, 'utf-8');

    const [sig] = loadSignaturesFromDir(dir);

    expect(sig.conditions).toHaveLength(1);
    expect(sig.conditions[0].field).toBe('blockedThreadCount');
    expect(sig.conditions[0].operator).toBe('gte');
    expect(sig.conditions[0].value).toBe(10);
  });

  it('parses nextSteps array', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'test-sig.yaml'), MINIMAL_SIGNATURE, 'utf-8');

    const [sig] = loadSignaturesFromDir(dir);
    expect(sig.nextSteps).toContain('Check the lock holder');
  });

  it('parses relatedSignatures array', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'test-sig.yaml'), MINIMAL_SIGNATURE, 'utf-8');

    const [sig] = loadSignaturesFromDir(dir);
    expect(sig.relatedSignatures).toContain('db-pool-exhaustion');
  });
});

// ── Multiple files ────────────────────────────────────────────────────────────

describe('loadSignaturesFromDir — multiple signature files', () => {
  it('loads all .yaml and .yml files', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'sig-a.yaml'), MINIMAL_SIGNATURE.replace('test-sig', 'sig-a'), 'utf-8');
    writeFileSync(path.join(dir, 'sig-b.yml'),  MINIMAL_SIGNATURE.replace('test-sig', 'sig-b'), 'utf-8');

    const results = loadSignaturesFromDir(dir);
    const ids = results.map(s => s.id).sort();
    expect(ids).toEqual(['sig-a', 'sig-b']);
  });

  it('ignores non-YAML files in the directory', () => {
    const dir = createTempDir();
    writeFileSync(path.join(dir, 'test-sig.yaml'),  MINIMAL_SIGNATURE, 'utf-8');
    writeFileSync(path.join(dir, 'README.md'),      '# Signatures', 'utf-8');
    writeFileSync(path.join(dir, 'notes.txt'),      'some notes', 'utf-8');
    writeFileSync(path.join(dir, '.DS_Store'),      '', 'utf-8');

    const results = loadSignaturesFromDir(dir);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('test-sig');
  });
});

// ── Bundled signatures ────────────────────────────────────────────────────────
//
// Verify that the four signatures bundled with the project load and parse cleanly.

describe('loadSignaturesFromDir — bundled signatures', () => {
  // Navigate from tests/ → project root → signatures/
  const BUNDLED_DIR = path.join(__dirname, '../../../../signatures');

  it('loads all bundled signatures', () => {
    const results = loadSignaturesFromDir(BUNDLED_DIR);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it('all bundled signatures have required fields', () => {
    const results = loadSignaturesFromDir(BUNDLED_DIR);
    for (const sig of results) {
      expect(sig.id, `${sig.id} must have an id`).toBeTruthy();
      expect(sig.name, `${sig.id} must have a name`).toBeTruthy();
      expect(sig.conditions, `${sig.id} must have conditions`).toBeInstanceOf(Array);
      expect(sig.conditions.length, `${sig.id} must have at least one condition`).toBeGreaterThan(0);
      expect(sig.nextSteps, `${sig.id} must have nextSteps`).toBeInstanceOf(Array);
    }
  });

  it('each bundled signature condition has a valid operator', () => {
    const VALID_OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'eq', 'contains', 'matches']);
    const results = loadSignaturesFromDir(BUNDLED_DIR);
    for (const sig of results) {
      for (const cond of sig.conditions) {
        expect(
          VALID_OPERATORS.has(cond.operator),
          `${sig.id}.${cond.field} has invalid operator '${cond.operator}'`
        ).toBe(true);
      }
    }
  });

  it('bundled signature IDs match expected names', () => {
    const results = loadSignaturesFromDir(BUNDLED_DIR);
    const ids = results.map(s => s.id);
    expect(ids).toContain('thread-lock-contention');
    expect(ids).toContain('gc-pressure');
    expect(ids).toContain('servlet-pool-saturation');
  });
});

// ── Round-trip: write a signature, load it, run it through the matcher ────────

describe('loadSignaturesFromDir — round-trip: write then match', () => {
  it('a signature written to disk and loaded back produces a finding when signals match', async () => {
    const { matchSignatures } = await import('../../src/engine/signature-matcher');
    const { extractSignals } = await import('../../src/engine/signal-extractor');
    const { ThreadDumpSignals } = await import('../../src/types/signal') as any;

    const dir = createTempDir();

    const yamlContent = `
id: round-trip-test
name: Round Trip Test
description: Verifies write-then-load-then-match flow
version: "1.0"
conditions:
  - field: blockedThreadCount
    operator: gte
    value: 5
    description: "5+ BLOCKED threads"
  - field: totalThreadCount
    operator: gte
    value: 50
    description: "50+ threads total"
indicators:
  - "High blocked thread count"
nextSteps:
  - "Investigate lock contention"
relatedSignatures: []
`;
    writeFileSync(path.join(dir, 'round-trip-test.yaml'), yamlContent, 'utf-8');

    const [sig] = loadSignaturesFromDir(dir);
    expect(sig.id).toBe('round-trip-test');

    const rawDump: ThreadDumpSignals = {
      capturedAt: new Date(),
      totalThreadCount: 100,
      stateCounts: { RUNNABLE: 85, BLOCKED: 10, WAITING: 5, TIMED_WAITING: 0, NEW: 0, TERMINATED: 0 },
      stackFingerprints: [],
      blockedMonitors: [],
      ioThreadCount: 0,
      gcThreadCount: 0,
      format: 'jstack' as const
    };

    const signals = extractSignals([rawDump]);
    const findings = matchSignatures(signals, [sig]);

    expect(findings).toHaveLength(1);
    expect(findings[0].signatureId).toBe('round-trip-test');
    expect(findings[0].confidence).toBe('high');
  });
});
