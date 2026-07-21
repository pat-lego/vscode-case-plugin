import { describe, it, expect } from 'vitest';
import { computeCdnMetrics, disposition, CdnAggregator } from '../../src/cdn/metrics';
import {
  makeEntry,
  uniqueUrlBurstEntries,
  staleContentEntries,
  popFragmentationEntries,
  botColdPopEntries,
  baselineWithColdPop,
  cloudBurstEntries
} from './helpers';

// ── Disposition + PASS handling ─────────────────────────────────────────────────

describe('disposition', () => {
  it('prioritises cache_status over x-cache (PASS is not a MISS even if x-cache says MISS)', () => {
    expect(disposition(makeEntry({ cacheStatus: 'PASS', xCache: 'MISS' }))).toBe('PASS');
  });
  it('treats HITPASS as PASS', () => {
    expect(disposition(makeEntry({ cacheStatus: 'HITPASS' }))).toBe('PASS');
  });
  it('falls back to fastly state then x-cache', () => {
    expect(disposition(makeEntry({ cacheStatus: '', fastlyState: 'HIT', xCache: 'MISS' }))).toBe('HIT');
    expect(disposition(makeEntry({ cacheStatus: '', fastlyState: '', xCache: 'MISS' }))).toBe('MISS');
  });
});

describe('computeCdnMetrics — volume + PASS/429 accounting', () => {
  const entries = [
    makeEntry({ url: '/a', cacheStatus: 'MISS', status: 200 }),
    makeEntry({ url: '/b', cacheStatus: 'MISS', status: 200 }),
    makeEntry({ url: '/c', cacheStatus: 'MISS', status: 429 }),
    makeEntry({ url: '/d', cacheStatus: 'HIT', status: 200 }),
    makeEntry({ url: '/e', cacheStatus: 'PASS', status: 200 }),
    makeEntry({ url: '/f', cacheStatus: 'PASS', status: 500, originStatus: 500 })
  ];
  const m = computeCdnMetrics(entries);

  it('counts dispositions', () => {
    expect(m.missCount).toBe(3);
    expect(m.hitCount).toBe(1);
    expect(m.passCount).toBe(2);
  });

  it('excludes PASS from the miss ratio (miss / miss+hit)', () => {
    expect(m.missRatio).toBeCloseTo(3 / 4, 5);
  });

  it('splits PASS by status 200 vs non-200', () => {
    expect(m.passWith200Count).toBe(1);
    expect(m.passNon200Count).toBe(1);
  });

  it('correlates 429s with MISSes', () => {
    expect(m.error429Count).toBe(1);
    expect(m.missWith429Count).toBe(1);
    expect(m.missShareOf429).toBe(1);
    expect(m.originError5xxCount).toBe(1);
  });
});

describe('computeCdnMetrics — PASS breakdown', () => {
  it('splits PASS by 200 / non-200 / 429 and the 200 bypass reason', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', cacheStatus: 'PASS', status: 200, fetchAction: 'pass_noheaders' }),
      makeEntry({ url: '/b', cacheStatus: 'PASS', status: 200, fetchAction: 'pass_private' }),
      makeEntry({ url: '/c', cacheStatus: 'PASS', status: 301 }),
      makeEntry({ url: '/d', cacheStatus: 'PASS', status: 429 })
    ]);
    expect(m.passCount).toBe(4);
    expect(m.passWith200Count).toBe(2);
    expect(m.passWith200Share).toBeCloseTo(0.5, 5);
    expect(m.pass429Count).toBe(1);
    expect(m.passNon200Non429Count).toBe(1);
    expect(m.pass200NoHeadersShare).toBeCloseTo(0.5, 5);
    expect(m.pass200PrivateShare).toBeCloseTo(0.5, 5);
  });
});

describe('computeCdnMetrics — no MISS events', () => {
  it('reports zero MISSes and a warning when only PASS/HIT are present', () => {
    const m = computeCdnMetrics([makeEntry({ cacheStatus: 'PASS' }), makeEntry({ cacheStatus: 'HIT' })]);
    expect(m.missCount).toBe(0);
    expect(m.totalRequests).toBe(2);
    expect(m.warnings.join(' ')).toMatch(/No cache MISS/i);
  });
});

// ── URL cardinality ─────────────────────────────────────────────────────────────

describe('computeCdnMetrics — unique-URL burst', () => {
  const m = computeCdnMetrics(uniqueUrlBurstEntries(100));
  it('has ~1.0 unique ratio and all single-request', () => {
    expect(m.distinctMissUrlCount).toBe(100);
    expect(m.uniqueMissUrlRatio).toBe(1);
    expect(m.singleRequestMissUrlShare).toBe(1);
    expect(m.repeatedMissUrlCount).toBe(0);
  });
});

// ── Staleness ────────────────────────────────────────────────────────────────────

describe('computeCdnMetrics — stale content (same POP, short TTL)', () => {
  const m = computeCdnMetrics(staleContentEntries(30, 10));
  it('sees repeated URLs on one POP with short TTLs', () => {
    expect(m.missCount).toBe(300);
    expect(m.repeatedMissUrlCount).toBe(30);
    expect(m.maxRequestsForSingleMissUrl).toBe(10);
    expect(m.repeatedUrlMultiPopShare).toBe(0);
    expect(m.shortTtlMissShare).toBe(1);
    expect(m.avgMissTtlSeconds).toBeCloseTo(30, 5);
  });
});

describe('computeCdnMetrics — refetch within TTL timing', () => {
  it('counts same-URL/same-POP re-fetches inside the TTL window', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const within = computeCdnMetrics([
      makeEntry({ url: '/x', pop: 'BMA', responseTtl: 3600, timeStart: new Date(base) }),
      makeEntry({ url: '/x', pop: 'BMA', responseTtl: 3600, timeStart: new Date(base + 10_000) })
    ]);
    expect(within.refetchWithinTtlCount).toBe(1);

    const beyond = computeCdnMetrics([
      makeEntry({ url: '/x', pop: 'BMA', responseTtl: 5, timeStart: new Date(base) }),
      makeEntry({ url: '/x', pop: 'BMA', responseTtl: 5, timeStart: new Date(base + 60_000) })
    ]);
    expect(beyond.refetchWithinTtlCount).toBe(0);
  });
});

describe('computeCdnMetrics — Vary header fragmentation', () => {
  it('reports the Vary share and top values, distinguishing high- from low-cardinality dimensions', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', responseVary: 'Accept-Encoding' }),
      makeEntry({ url: '/b', responseVary: 'Accept-Encoding' }),
      makeEntry({ url: '/c', responseVary: 'Accept-Encoding, User-Agent' }),
      makeEntry({ url: '/d', responseVary: '' })
    ]);
    expect(m.missVaryShare).toBeCloseTo(0.75, 5); // 3 of 4 carry a Vary header
    expect(m.highCardinalityVaryMissShare).toBeCloseTo(0.25, 5); // only the User-Agent one
    expect(m.topMissVaryValues[0]).toEqual({ value: 'Accept-Encoding', count: 2 });
  });

  it('is all zero/empty when no MISS carries a Vary header', () => {
    const m = computeCdnMetrics(uniqueUrlBurstEntries(10));
    expect(m.missVaryShare).toBe(0);
    expect(m.highCardinalityVaryMissShare).toBe(0);
    expect(m.topMissVaryValues).toEqual([]);
  });

  it('does not flag Accept-Encoding alone as high-cardinality', () => {
    const m = computeCdnMetrics(uniqueUrlBurstEntries(10).map(e => ({ ...e, responseVary: 'Accept-Encoding' })));
    expect(m.missVaryShare).toBe(1);
    expect(m.highCardinalityVaryMissShare).toBe(0);
  });
});

// ── POP fragmentation ─────────────────────────────────────────────────────────────

describe('computeCdnMetrics — POP fragmentation', () => {
  const m = computeCdnMetrics(popFragmentationEntries(30, ['BMA', 'FRA', 'LHR', 'AMS']));
  it('sees the same URLs MISSing across many POPs', () => {
    expect(m.distinctPopCount).toBe(4);
    expect(m.avgPopsPerRepeatedMissUrl).toBeCloseTo(4, 5);
    expect(m.repeatedUrlMultiPopShare).toBe(1);
    expect(m.topPopMissShare).toBeCloseTo(0.25, 5);
  });
});

describe('computeCdnMetrics — coldFetchBurstRatio (invalidation vs organic diversity)', () => {
  it('is high when every cold-POP first-fetch lands in the same instant (a synchronized invalidation)', () => {
    const t0 = Date.parse('2026-07-16T03:40:00Z');
    const pops = ['BMA', 'FRA', 'LHR'];
    const entries = [];
    // 60 distinct (url,pop) first-fetches, all at t0.
    for (let u = 0; u < 20; u++) {
      for (const pop of pops) {
        entries.push(makeEntry({ url: `/article/${u}`, pop, cacheStatus: 'MISS', timeStart: new Date(t0) }));
      }
    }
    // One more request 60s later to establish a window (and a low mean rate by comparison).
    entries.push(makeEntry({ url: '/article/0', pop: 'BMA', cacheStatus: 'MISS', timeStart: new Date(t0 + 60000) }));
    const m = computeCdnMetrics(entries);
    expect(m.coldFetchBurstRatio).toBeGreaterThan(10);
  });

  it('is ~1 when cold-POP first-fetches are spread evenly through the window (organic diversity)', () => {
    const t0 = Date.parse('2026-07-16T03:40:00Z');
    const pops = ['BMA', 'FRA', 'LHR'];
    const entries = [];
    let i = 0;
    for (let u = 0; u < 20; u++) {
      for (const pop of pops) {
        entries.push(makeEntry({ url: `/article/${u}`, pop, cacheStatus: 'MISS', timeStart: new Date(t0 + i * 1000) }));
        i++;
      }
    }
    const m = computeCdnMetrics(entries);
    expect(m.coldFetchBurstRatio).toBeLessThan(2);
  });
});

// ── Bots + rare POP (baseline vs in-window) ───────────────────────────────────────

describe('computeCdnMetrics — bot cold POP with baseline', () => {
  const m = computeCdnMetrics(botColdPopEntries(50, 3, 'XYZ'), baselineWithColdPop('XYZ'));
  it('flags bot traffic concentrated on a rare POP and ASN', () => {
    expect(m.botMissShare).toBe(1);
    expect(m.rarePopMissShare).toBe(1);
    expect(m.botOnRarePopMissShare).toBe(1);
    expect(m.topAsnMissShare).toBe(1);
    expect(m.baselineUsed).toBe(1);
    expect(m.topBotName).toBe('Generic Bot');
  });
});

describe('computeCdnMetrics — rare POP without baseline', () => {
  it('uses the in-window heuristic (baselineUsed = 0)', () => {
    const common = Array.from({ length: 99 }, (_, i) => makeEntry({ url: `/p${i}`, pop: 'BMA' }));
    const rare = [makeEntry({ url: '/rare', pop: 'ZZZ' })];
    const m = computeCdnMetrics([...common, ...rare]);
    expect(m.baselineUsed).toBe(0);
    expect(m.rarePopMissShare).toBeCloseTo(0.01, 5); // ZZZ is 1/100 of in-window traffic
  });
});

describe('CdnAggregator — streaming matches batch', () => {
  it('produces identical metrics whether fed incrementally or as a batch', () => {
    const entries = [
      ...popFragmentationEntries(20, ['BMA', 'FRA', 'LHR']),
      ...botColdPopEntries(15, 3, 'XYZ'),
      ...uniqueUrlBurstEntries(40)
    ];
    const baseline = baselineWithColdPop('XYZ');

    const agg = new CdnAggregator();
    for (const e of entries) agg.add(e);

    expect(agg.finalize(baseline)).toEqual(computeCdnMetrics(entries, baseline));
  });
});

describe('computeCdnMetrics — per-MISS reason (cold POP vs same-POP repeat)', () => {
  it('classifies one fetch per POP as cold-first-fetch, not a repeat', () => {
    // Same URL, 5 distinct POPs, once each — the /apac/.../supplier-relations case.
    const pops = ['BMA', 'FRA', 'LHR', 'AMS', 'CDG'];
    const m = computeCdnMetrics(pops.map(p => makeEntry({ url: '/apac/x', pop: p })));
    expect(m.distinctUrlPopPairs).toBe(5);
    expect(m.firstFetchPerPopMissCount).toBe(5);
    expect(m.repeatSamePopMissCount).toBe(0);
    expect(m.coldPopFirstFetchShare).toBe(1);
    expect(m.repeatSamePopShare).toBe(0);
  });

  it('classifies repeats on one POP as should-have-HIT', () => {
    const m = computeCdnMetrics(Array.from({ length: 5 }, () => makeEntry({ url: '/apac/x', pop: 'BMA' })));
    expect(m.firstFetchPerPopMissCount).toBe(1);
    expect(m.repeatSamePopMissCount).toBe(4);
    expect(m.coldPopFirstFetchShare).toBeCloseTo(0.2, 5);
    expect(m.repeatSamePopShare).toBeCloseTo(0.8, 5);
  });
});

describe('computeCdnMetrics — why uncacheable (cache directives)', () => {
  it('flags no positive max-age (SWR/SIE only) and captures a sample directive', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', isCacheable: false, fetchSurrogateControl: 'stale-while-revalidate=43200,stale-if-error=43200' }),
      makeEntry({ url: '/b', isCacheable: false, fetchCacheControl: '' })
    ]);
    expect(m.missNoPositiveTtlShare).toBe(1);
    expect(m.missNoStoreShare).toBe(0);
    expect(m.sampleMissSurrogateControl).toMatch(/stale-while-revalidate/);
  });

  it('flags misspass (fetched then passed) from fetch_action', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', fetchAction: 'pass_noheaders120.000' }),
      makeEntry({ url: '/b', fetchAction: '' })
    ]);
    expect(m.misspassMissShare).toBeCloseTo(0.5, 5);
  });

  it('detects explicit no-store / private and recognises a positive max-age as cacheable', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', isCacheable: false, fetchCacheControl: 'no-store' }),
      makeEntry({ url: '/b', isCacheable: false, fetchCacheControl: 'private, max-age=0' }),
      makeEntry({ url: '/c', isCacheable: true, fetchCacheControl: 'max-age=300' })
    ]);
    expect(m.missNoStoreShare).toBeCloseTo(2 / 3, 5);
    expect(m.missNoPositiveTtlShare).toBeCloseTo(2 / 3, 5); // /c has max-age=300
  });
});

describe('computeCdnMetrics — DDoS / traffic-source signals', () => {
  it('detects cloud-ASN concentration and a request burst', () => {
    const m = computeCdnMetrics(cloudBurstEntries());
    expect(m.cloudAsnRequestShare).toBe(1);
    expect(m.topAsnRequestName.toLowerCase()).toContain('akamai');
    expect(m.peakRequestsPerSec).toBeGreaterThanOrEqual(200);
    expect(m.burstRatio).toBeGreaterThan(10);
  });

  it('treats eyeball-ISP traffic as non-cloud', () => {
    const entries = uniqueUrlBurstEntries(30).map(e => ({ ...e, clientAsName: 'comcast cable communications', clientAsNumber: '7922' }));
    const m = computeCdnMetrics(entries);
    expect(m.cloudAsnRequestShare).toBe(0);
  });

  it('attaches a forwarded-request sample to an ASN whose XFF chain ends at its own client IP', () => {
    const entries = cloudBurstEntries().map(e => ({
      ...e,
      clientIp: '23.52.12.49',
      originalXForwardedFor: '135.132.91.21, 23.52.12.49',
      requestVia: '1.1 akamai.net(ghost) (AkamaiGHost)'
    }));
    const m = computeCdnMetrics(entries);
    const asn = m.topSourceAsns.find(a => a.asn === '20940');
    expect(asn?.forwardedSample).toEqual({ realClientIp: '135.132.91.21', via: '1.1 akamai.net(ghost) (AkamaiGHost)' });
  });

  it('does not attach a forwarded-request sample without a multi-hop XFF chain ending at the client IP', () => {
    // Single-hop XFF (no real client ahead of it) and a mismatched last hop both should not count.
    const noChain = computeCdnMetrics(cloudBurstEntries().map(e => ({ ...e, originalXForwardedFor: '23.52.12.49' })));
    expect(noChain.topSourceAsns[0]?.forwardedSample).toBeUndefined();

    const mismatchedLastHop = computeCdnMetrics(cloudBurstEntries().map(e => ({
      ...e, clientIp: '23.52.12.49', originalXForwardedFor: '135.132.91.21, 9.9.9.9'
    })));
    expect(mismatchedLastHop.topSourceAsns[0]?.forwardedSample).toBeUndefined();
  });

  it('tracks the most common origin_host, for the upstream-CDN DNS cross-check', () => {
    const entries = uniqueUrlBurstEntries(10).map(e => ({ ...e, originHost: 'www.macnica.com' }));
    const m = computeCdnMetrics(entries);
    expect(m.topOriginHost).toBe('www.macnica.com');
  });

  it('leaves topOriginHost blank when no entry carries one', () => {
    const entries = uniqueUrlBurstEntries(5).map(e => ({ ...e, originHost: '' }));
    const m = computeCdnMetrics(entries);
    expect(m.topOriginHost).toBe('');
  });
});

describe('computeCdnMetrics — TTL sizing', () => {
  it('derives request rate and a recommended TTL from the aggregate inter-arrival', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    for (let u = 0; u < 12; u++) {
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base) }));
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base + 120000) }));
    }
    const m = computeCdnMetrics(entries);
    expect(m.ttlDataSufficient).toBe(1);
    expect(m.windowSeconds).toBeCloseTo(120, 0);
    expect(m.p90AggGapSeconds).toBeCloseTo(120, 0);
    expect(m.observedMaxAgeSeconds).toBe(60);
    expect(m.recommendedTtlSeconds).toBe(300); // niceTtl(120)
  });

  it('recommends a generous stale-while-revalidate floor (1 week) rather than sizing tightly to the gap', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    for (let u = 0; u < 12; u++) {
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base) }));
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base + 120000) }));
    }
    const m = computeCdnMetrics(entries);
    expect(m.observedSwrSeconds).toBe(0); // no stale-while-revalidate directive was present
    expect(m.recommendedSwrSeconds).toBe(604800); // the floor — the 120s gap alone would only need niceTtl(120)=300
  });

  it('floors the recommended SWR at the current value when it already exceeds the default floor', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const twoWeeks = 14 * 86400;
    const entries = [];
    for (let u = 0; u < 12; u++) {
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchSurrogateControl: `max-age=60,stale-while-revalidate=${twoWeeks}`, timeStart: new Date(base) }));
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchSurrogateControl: `max-age=60,stale-while-revalidate=${twoWeeks}`, timeStart: new Date(base + 120000) }));
    }
    const m = computeCdnMetrics(entries);
    expect(m.observedSwrSeconds).toBe(twoWeeks);
    expect(m.recommendedSwrSeconds).toBe(twoWeeks); // never suggest shortening it, even below the default floor
  });
});

describe('computeCdnMetrics — shielding', () => {
  it('computes the shielded MISS share', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', shieldingUsed: true }),
      makeEntry({ url: '/b', shieldingUsed: false }),
      makeEntry({ url: '/c', shieldingUsed: false }),
      makeEntry({ url: '/d', shieldingUsed: true })
    ]);
    expect(m.shieldingUsedMissShare).toBeCloseTo(0.5, 5);
  });
});

describe('computeCdnMetrics — cacheability', () => {
  it('reports the non-cacheable MISS share and dominant content type', () => {
    const m = computeCdnMetrics([
      makeEntry({ url: '/a', isCacheable: false, contentType: 'text/html;charset=utf-8' }),
      makeEntry({ url: '/b', isCacheable: false, contentType: 'text/html' }),
      makeEntry({ url: '/c', isCacheable: true, contentType: 'application/json' })
    ]);
    expect(m.cacheableFalseMissShare).toBeCloseTo(2 / 3, 5);
    expect(m.dominantMissContentType).toBe('text/html');
    expect(m.dominantMissContentTypeShare).toBeCloseTo(2 / 3, 5);
  });
});
