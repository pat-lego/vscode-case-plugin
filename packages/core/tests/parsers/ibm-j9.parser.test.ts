import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseIbmJ9 } from '../../src/parsers/thread-dump/ibm-j9.parser';

const FIXTURES = path.join(__dirname, '../fixtures');
const NOW = new Date('2024-01-15T14:32:01Z');

describe('IBM J9 parser — sample dump', () => {
  const raw = readFileSync(path.join(FIXTURES, 'ibm-j9-sample.txt'), 'utf-8');
  const dump = parseIbmJ9(raw, NOW);

  it('sets format to ibm-j9', () => {
    expect(dump.format).toBe('ibm-j9');
  });

  it('preserves the capturedAt timestamp', () => {
    expect(dump.capturedAt).toEqual(NOW);
  });

  it('counts all 5 threads (including GC worker)', () => {
    expect(dump.totalThreadCount).toBe(5);
  });

  it('maps IBM state R to RUNNABLE', () => {
    // http-worker-1, http-worker-2, GC Worker Thread are state:R
    expect(dump.stateCounts.RUNNABLE).toBe(3);
  });

  it('maps IBM state W to WAITING', () => {
    // background-scheduler is state:W
    expect(dump.stateCounts.WAITING).toBe(1);
  });

  it('maps IBM state B to BLOCKED', () => {
    // blocked-worker is state:B
    expect(dump.stateCounts.BLOCKED).toBe(1);
  });

  it('groups threads with identical top 3 frames into one fingerprint', () => {
    // http-worker-1 and http-worker-2 share ApiController.handle as top frame
    const apiFingerprint = dump.stackFingerprints.find(fp =>
      fp.topFrame.includes('ApiController.handle')
    );
    expect(apiFingerprint).toBeDefined();
    expect(apiFingerprint!.count).toBe(2);
  });

  it('detects GC threads by IBM naming pattern', () => {
    // "GC Worker Thread" matches ^(GC ) pattern
    expect(dump.gcThreadCount).toBe(1);
  });

  it('reports no blocked monitors (IBM J9 parser does not track monitors)', () => {
    expect(dump.blockedMonitors).toHaveLength(0);
  });
});

// ── IBM state code mapping edge cases ────────────────────────────────────────

describe('IBM J9 parser — state code edge cases', () => {
  function buildDump(state: string): string {
    return `3XMTHREADINFO      "test-thread" J9VMThread:0x0000000000F00001, omrthread_t:0x00007F0000001001, java/lang/Thread:0x00000000FFF1C001, state:${state}, prio=5
3XMTHREADINFO3           Java callstack:
4XESTACKTRACE                at com/example/Foo.bar(Foo.java:1)
NULL`;
  }

  it('maps T to TIMED_WAITING', () => {
    const dump = parseIbmJ9(buildDump('T'), NOW);
    expect(dump.stateCounts.TIMED_WAITING).toBe(1);
  });

  it('defaults unknown state codes to RUNNABLE', () => {
    const dump = parseIbmJ9(buildDump('X'), NOW);
    expect(dump.stateCounts.RUNNABLE).toBe(1);
  });
});
