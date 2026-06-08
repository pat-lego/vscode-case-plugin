import { describe, it, expect } from 'vitest';
import { executeQuery } from '../../src/query/thread-query';
import { Thread } from '../../src/types/thread';

const THREADS: Thread[] = [
  {
    name: 'http-nio-8080-exec-1',
    state: 'BLOCKED',
    frames: [
      'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
      'com.example.dao.UserRepository.findById(UserRepository.java:45)',
    ],
    topFrame: 'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
    keyFrame: 'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
    monitorLines: [],
    lockedMonitors: [],
  },
  {
    name: 'http-nio-8080-exec-2',
    state: 'BLOCKED',
    frames: [
      'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
      'com.example.dao.OrderRepository.findByUser(OrderRepository.java:78)',
    ],
    topFrame: 'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
    keyFrame: 'com.zaxxer.hikari.pool.HikariPool.getConnection(HikariPool.java:213)',
    monitorLines: [],
    lockedMonitors: [],
  },
  {
    name: 'http-nio-8080-exec-3',
    state: 'WAITING',
    frames: [
      'java.lang.Object.wait(Native Method)',
      'com.example.queue.TaskQueue.poll(TaskQueue.java:88)',
    ],
    topFrame: 'java.lang.Object.wait(Native Method)',
    keyFrame: 'com.example.queue.TaskQueue.poll(TaskQueue.java:88)',
    monitorLines: [],
    lockedMonitors: [],
  },
  {
    name: 'scheduler-1',
    state: 'TIMED_WAITING',
    frames: [
      'java.lang.Thread.sleep(Native Method)',
      'com.example.scheduler.JobRunner.run(JobRunner.java:55)',
    ],
    topFrame: 'java.lang.Thread.sleep(Native Method)',
    keyFrame: 'com.example.scheduler.JobRunner.run(JobRunner.java:55)',
    monitorLines: [],
    lockedMonitors: [],
  },
  {
    name: 'main',
    state: 'RUNNABLE',
    frames: ['com.example.Main.main(Main.java:10)'],
    topFrame: 'com.example.Main.main(Main.java:10)',
    keyFrame: 'com.example.Main.main(Main.java:10)',
    monitorLines: [],
    lockedMonitors: [],
  },
];

describe('executeQuery — no stats', () => {
  it('returns all threads for empty query', () => {
    expect(executeQuery(THREADS, '').totalMatched).toBe(5);
  });

  it('filters by state=BLOCKED', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED');
    expect(r.totalMatched).toBe(2);
    expect(r.rows.every(row => row.state === 'BLOCKED')).toBe(true);
  });

  it('filters case-insensitively: state=blocked', () => {
    expect(executeQuery(THREADS, 'state=blocked').totalMatched).toBe(2);
  });

  it('filters by state IN (BLOCKED, WAITING)', () => {
    expect(executeQuery(THREADS, 'state IN (BLOCKED, WAITING)').totalMatched).toBe(3);
  });

  it('filters by state IN (BLOCKED, WAITING, TIMED_WAITING)', () => {
    expect(executeQuery(THREADS, 'state IN (BLOCKED, WAITING, TIMED_WAITING)').totalMatched).toBe(4);
  });

  it('glob match on thread name', () => {
    expect(executeQuery(THREADS, 'thread=*http-nio*').totalMatched).toBe(3);
  });

  it('glob match on thread with exact prefix', () => {
    expect(executeQuery(THREADS, 'thread=scheduler*').totalMatched).toBe(1);
  });

  it('glob match on any frame', () => {
    expect(executeQuery(THREADS, 'frame=*HikariPool*').totalMatched).toBe(2);
  });

  it('frame!= glob excludes threads whose stack contains the pattern', () => {
    // 2 threads have HikariPool frames; the other 3 do not
    expect(executeQuery(THREADS, 'frame!=*HikariPool*').totalMatched).toBe(3);
  });

  it('frame!= glob is the exact inverse of frame= glob', () => {
    const with_    = executeQuery(THREADS, 'frame=*HikariPool*').totalMatched;
    const without  = executeQuery(THREADS, 'frame!=*HikariPool*').totalMatched;
    expect(with_ + without).toBe(5);
  });

  it('frame!= combined with thread filter excludes matching frames', () => {
    // http-nio threads: 3 total, 2 have HikariPool — only 1 should survive
    const r = executeQuery(THREADS, 'thread=*http-nio* AND frame!=*HikariPool*');
    expect(r.totalMatched).toBe(1);
    expect(r.rows[0].thread).toContain('exec-3');
  });

  it('thread!= glob excludes threads whose name matches', () => {
    expect(executeQuery(THREADS, 'thread!=*http-nio*').totalMatched).toBe(2);
  });

  it('glob match on keyFrame', () => {
    expect(executeQuery(THREADS, 'keyFrame=*HikariPool*').totalMatched).toBe(2);
  });

  it('AND: thread glob + state', () => {
    const r = executeQuery(THREADS, 'thread=*http-nio* AND state=BLOCKED');
    expect(r.totalMatched).toBe(2);
  });

  it('OR: two states', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED OR state=RUNNABLE');
    expect(r.totalMatched).toBe(3);
  });
});

describe('executeQuery — stats count by', () => {
  it('stats count by state — all threads', () => {
    const r = executeQuery(THREADS, '| stats count by state');
    expect(r.rows.find(row => row.state === 'BLOCKED')?.count).toBe(2);
    expect(r.rows.find(row => row.state === 'RUNNABLE')?.count).toBe(1);
    // sorted by count desc
    expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(Number(r.rows[r.rows.length - 1].count));
  });

  it('state=BLOCKED | stats count by keyFrame', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED | stats count by keyFrame');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].count).toBe(2);
  });

  it('stats count by class', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED | stats count by class');
    expect(r.rows[0].class).toBe('com.zaxxer.hikari.pool.HikariPool');
    expect(r.rows[0].count).toBe(2);
  });

  it('stats count by package', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED | stats count by package');
    expect(r.rows[0].package).toBe('com.zaxxer.hikari.pool');
  });

  it('stats count by method', () => {
    const r = executeQuery(THREADS, 'state=BLOCKED | stats count by method');
    expect(r.rows[0].method).toBe('getConnection');
    expect(r.rows[0].count).toBe(2);
  });

  it('stats count by thread', () => {
    const r = executeQuery(THREADS, '| stats count by thread');
    expect(r.rows).toHaveLength(5);
    expect(r.rows.every(row => row.count === 1)).toBe(true);
  });

  it('multi-field: stats count by state, method', () => {
    const r = executeQuery(THREADS, '| stats count by state, method');
    const blockedRow = r.rows.find(row => row.state === 'BLOCKED');
    expect(blockedRow?.method).toBe('getConnection');
    expect(blockedRow?.count).toBe(2);
  });
});

describe('executeQuery — top N', () => {
  it('top 2 limits results after stats', () => {
    const r = executeQuery(THREADS, '| stats count by state | top 2');
    expect(r.rows).toHaveLength(2);
  });

  it('top 1 returns the highest count row', () => {
    const r = executeQuery(THREADS, '| stats count by state | top 1');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].state).toBe('BLOCKED');
  });
});

describe('executeQuery — error handling', () => {
  it('returns error for unparseable predicate', () => {
    const r = executeQuery(THREADS, 'badfield%%%');
    expect(r.error).toBeDefined();
    expect(r.rows).toHaveLength(0);
  });

  it('returns error for unknown command', () => {
    const r = executeQuery(THREADS, '| sort by foo');
    expect(r.error).toBeDefined();
  });
});

describe('executeQuery — field extraction', () => {
  it('extracts class from a standard JVM frame', () => {
    const t: Thread = {
      name: 't', state: 'RUNNABLE',
      frames: ['com.example.service.MyService.doWork(MyService.java:100)'],
      topFrame: 'com.example.service.MyService.doWork(MyService.java:100)',
      keyFrame: 'com.example.service.MyService.doWork(MyService.java:100)',
      monitorLines: [],
      lockedMonitors: [],
    };
    const r = executeQuery([t], '| stats count by class');
    expect(r.rows[0].class).toBe('com.example.service.MyService');
  });

  it('extracts package from a standard JVM frame', () => {
    const t: Thread = {
      name: 't', state: 'RUNNABLE',
      frames: ['com.example.service.MyService.doWork(MyService.java:100)'],
      topFrame: 'com.example.service.MyService.doWork(MyService.java:100)',
      keyFrame: 'com.example.service.MyService.doWork(MyService.java:100)',
      monitorLines: [],
      lockedMonitors: [],
    };
    const r = executeQuery([t], '| stats count by package');
    expect(r.rows[0].package).toBe('com.example.service');
  });

  it('handles thread with no frames gracefully', () => {
    const t: Thread = {
      name: 'empty-thread', state: 'RUNNABLE',
      frames: [], topFrame: '', keyFrame: '',
      monitorLines: [],
      lockedMonitors: [],
    };
    const r = executeQuery([t], '| stats count by state');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].state).toBe('RUNNABLE');
  });
});

describe('executeQuery — OR in where clause', () => {
  const mkThread = (name: string, state: Thread['state']): Thread => ({
    name, state, frames: [], topFrame: '', keyFrame: '', monitorLines: [], lockedMonitors: [],
  });

  it('OR in where includes threads matching either branch', () => {
    const threads = [
      mkThread('qtp12345-worker', 'BLOCKED'),
      mkThread('servlet-/graphql/execute.json', 'TIMED_WAITING'),
      mkThread('background-worker', 'BLOCKED'),
    ];
    const r1 = executeQuery(threads, 'state=BLOCKED OR state=TIMED_WAITING | where thread=*/graphql/execute.json*');
    expect(r1.totalMatched).toBe(1);

    const r2 = executeQuery(threads, 'state=BLOCKED OR state=TIMED_WAITING | where thread=*qtp* OR thread=*/graphql/execute.json*');
    expect(r2.totalMatched).toBe(2);
  });

  it('OR in where does not drop threads that only match the second branch', () => {
    const threads = [
      mkThread('qtp12345-worker', 'BLOCKED'),
      mkThread('sling-/graphql/execute.json-handler', 'TIMED_WAITING'),
    ];
    const r = executeQuery(threads, 'state=BLOCKED OR state=TIMED_WAITING | where thread=*qtp* OR thread=*/graphql/execute.json*');
    expect(r.totalMatched).toBe(2);
    const names = r.rows.map(row => row.thread);
    expect(names).toContain('sling-/graphql/execute.json-handler');
  });
});
