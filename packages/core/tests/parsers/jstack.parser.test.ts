import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseJstack } from '../../src/parsers/thread-dump/jstack.parser';

const FIXTURES = path.join(__dirname, '../fixtures');

function load(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf-8');
}

const NOW = new Date('2024-01-15T14:32:01Z');

// ── Healthy dump ──────────────────────────────────────────────────────────────

describe('jstack parser — healthy dump', () => {
  const dump = parseJstack(load('jstack-healthy.txt'), NOW);

  it('sets format to jstack', () => {
    expect(dump.format).toBe('jstack');
  });

  it('preserves the capturedAt timestamp', () => {
    expect(dump.capturedAt).toEqual(NOW);
  });

  it('counts all threads', () => {
    // 2 exec workers + 1 waiting worker + 2 GC threads = 5
    expect(dump.totalThreadCount).toBe(5);
  });

  it('counts thread states correctly', () => {
    expect(dump.stateCounts.RUNNABLE).toBe(4);  // exec-1, exec-2, gc-0, gc-1
    expect(dump.stateCounts.WAITING).toBe(1);    // exec-3
    expect(dump.stateCounts.BLOCKED).toBe(0);
  });

  it('detects GC threads by name pattern', () => {
    // "GC task thread#0 (ParallelGC)" and "GC task thread#1 (ParallelGC)"
    expect(dump.gcThreadCount).toBe(2);
  });

  it('groups threads with the same top 3 frames into one fingerprint', () => {
    const searchFp = dump.stackFingerprints.find(fp =>
      fp.topFrame.includes('SearchController.search')
    );
    expect(searchFp).toBeDefined();
    expect(searchFp!.count).toBe(2);           // exec-1 and exec-2
    expect(searchFp!.threadNames).toContain('http-nio-8080-exec-1');
    expect(searchFp!.threadNames).toContain('http-nio-8080-exec-2');
  });

  it('creates a separate fingerprint for a distinct stack', () => {
    const waitFp = dump.stackFingerprints.find(fp =>
      fp.topFrame.includes('Object.wait')
    );
    expect(waitFp).toBeDefined();
    expect(waitFp!.count).toBe(1);
  });

  it('reports no blocked monitors in a healthy dump', () => {
    expect(dump.blockedMonitors).toHaveLength(0);
  });

  it('reports no IO threads in this dump', () => {
    expect(dump.ioThreadCount).toBe(0);
  });
});

// ── Deadlock dump ─────────────────────────────────────────────────────────────

describe('jstack parser — deadlock dump', () => {
  const dump = parseJstack(load('jstack-deadlock.txt'), NOW);

  it('counts 3 threads total', () => {
    expect(dump.totalThreadCount).toBe(3);
  });

  it('counts 2 BLOCKED threads', () => {
    expect(dump.stateCounts.BLOCKED).toBe(2);
  });

  it('counts 1 WAITING thread', () => {
    expect(dump.stateCounts.WAITING).toBe(1);
  });

  it('detects 2 distinct blocked monitors', () => {
    expect(dump.blockedMonitors).toHaveLength(2);
  });

  it('extracts the monitor class from the waiting-to-lock line', () => {
    const monitorAddresses = dump.blockedMonitors.map(m => m.monitorAddress);
    expect(monitorAddresses).toContain('0x000000076b7e2a10');
    expect(monitorAddresses).toContain('0x000000076b7e1a00');
  });

  it('associates correct monitor classes', () => {
    const addr2a10 = dump.blockedMonitors.find(m => m.monitorAddress === '0x000000076b7e2a10');
    const addr1a00 = dump.blockedMonitors.find(m => m.monitorAddress === '0x000000076b7e1a00');
    expect(addr2a10?.monitorClass).toBe('com.example.ResourceB');
    expect(addr1a00?.monitorClass).toBe('com.example.ResourceA');
  });

  it('identifies the lock holder for each monitor', () => {
    // Thread-B holds 0x000000076b7e2a10 (Thread-A is waiting on it)
    const addr2a10 = dump.blockedMonitors.find(m => m.monitorAddress === '0x000000076b7e2a10');
    expect(addr2a10?.lockHolderThread).toBe('Thread-B');

    // Thread-A holds 0x000000076b7e1a00 (Thread-B is waiting on it)
    const addr1a00 = dump.blockedMonitors.find(m => m.monitorAddress === '0x000000076b7e1a00');
    expect(addr1a00?.lockHolderThread).toBe('Thread-A');
  });

  it('each monitor has exactly 1 waiter', () => {
    for (const m of dump.blockedMonitors) {
      expect(m.waitingThreadCount).toBe(1);
    }
  });
});

// ── DB pool exhaustion dump ───────────────────────────────────────────────────

describe('jstack parser — DB pool exhaustion dump', () => {
  const dump = parseJstack(load('jstack-db-pool-exhaustion.txt'), NOW);

  it('counts 8 threads total (1 holder + 7 waiters)', () => {
    expect(dump.totalThreadCount).toBe(8);
  });

  it('counts 7 BLOCKED threads', () => {
    expect(dump.stateCounts.BLOCKED).toBe(7);
  });

  it('detects exactly 1 blocked monitor', () => {
    // All waiters are on the same HikariPool monitor
    expect(dump.blockedMonitors).toHaveLength(1);
  });

  it('records 7 waiters on the single monitor', () => {
    expect(dump.blockedMonitors[0].waitingThreadCount).toBe(7);
  });

  it('extracts HikariPool as the monitor class', () => {
    expect(dump.blockedMonitors[0].monitorClass).toBe('com.zaxxer.hikari.pool.HikariPool');
  });

  it('identifies the lock holder thread', () => {
    expect(dump.blockedMonitors[0].lockHolderThread).toBe('HikariPool-1 connection adder');
  });
});

// ── Hot endpoint: programmatic fixture ───────────────────────────────────────

function buildHotEndpointDump(hotCount: number, otherCount: number): string {
  const blocks: string[] = [];

  for (let i = 0; i < hotCount; i++) {
    blocks.push(
      `"http-exec-${i}" #${10 + i} prio=5 os_prio=0 tid=0x${i.toString(16).padStart(8, '0')} nid=0x${i.toString(16)} runnable [0x...]
   java.lang.Thread.State: RUNNABLE
\tat com.example.controller.ProductController.getProduct(ProductController.java:42)
\tat org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1000)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)`
    );
  }

  for (let i = 0; i < otherCount; i++) {
    blocks.push(
      `"worker-${i}" #${200 + i} prio=5 os_prio=0 tid=0x${(200 + i).toString(16).padStart(8, '0')} nid=0x${(200 + i).toString(16)} in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(Native Method)
\tat com.example.worker.BackgroundWorker.run(BackgroundWorker.java:55)
\tat java.lang.Thread.run(Thread.java:834)`
    );
  }

  return blocks.join('\n');
}

describe('jstack parser — hot endpoint (programmatic fixture)', () => {
  // 60 threads on ProductController, 15 unrelated workers = 75 total
  const raw = buildHotEndpointDump(60, 15);
  const dump = parseJstack(raw, NOW);

  it('counts all 75 threads', () => {
    expect(dump.totalThreadCount).toBe(75);
  });

  it('groups 60 threads under the dominant fingerprint', () => {
    const dominant = dump.stackFingerprints[0];
    expect(dominant.topFrame).toContain('ProductController.getProduct');
    expect(dominant.count).toBe(60);
  });

  it('fingerprints are sorted descending by count', () => {
    for (let i = 0; i < dump.stackFingerprints.length - 1; i++) {
      expect(dump.stackFingerprints[i].count).toBeGreaterThanOrEqual(dump.stackFingerprints[i + 1].count);
    }
  });
});

// ── GC pressure: programmatic fixture ────────────────────────────────────────

function buildGcPressureDump(gcCount: number, waitingCount: number): string {
  const blocks: string[] = [];

  for (let i = 0; i < gcCount; i++) {
    blocks.push(
      `"GC task thread#${i} (ParallelGC)" os_prio=0 tid=0x${i.toString(16).padStart(8, '0')} nid=0x${i.toString(16)} runnable
   java.lang.Thread.State: RUNNABLE`
    );
  }

  for (let i = 0; i < waitingCount; i++) {
    blocks.push(
      `"pool-thread-${i}" #${100 + i} prio=5 os_prio=0 tid=0x${(100 + i).toString(16).padStart(8, '0')} nid=0x${(100 + i).toString(16)} waiting on condition [0x...]
   java.lang.Thread.State: TIMED_WAITING (parking)
\tat sun.misc.Unsafe.park(Native Method)
\tat java.util.concurrent.locks.LockSupport.parkNanos(LockSupport.java:215)
\tat java.util.concurrent.SynchronousQueue.poll(SynchronousQueue.java:941)`
    );
  }

  return blocks.join('\n');
}

describe('jstack parser — GC pressure (programmatic fixture)', () => {
  // 6 GC threads + 55 waiting application threads
  const raw = buildGcPressureDump(6, 55);
  const dump = parseJstack(raw, NOW);

  it('counts 6 GC threads', () => {
    expect(dump.gcThreadCount).toBe(6);
  });

  it('counts 55 TIMED_WAITING threads', () => {
    expect(dump.stateCounts.TIMED_WAITING).toBe(55);
  });

  it('counts 61 total threads', () => {
    expect(dump.totalThreadCount).toBe(61);
  });
});
