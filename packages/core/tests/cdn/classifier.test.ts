import { describe, it, expect } from 'vitest';
import { computeCdnMetrics } from '../../src/cdn/metrics';
import { classifyCacheMiss, build429Context, buildPass200Finding, buildPassErrorFinding, buildTtlRecommendation, buildDdosFinding } from '../../src/cdn/classifier';
import {
  makeEntry,
  uniqueUrlBurstEntries,
  staleContentEntries,
  popFragmentationEntries,
  botColdPopEntries,
  baselineWithColdPop,
  cloudBurstEntries,
  singleIpBurstEntries,
  diverseSourceBurstEntries
} from './helpers';

function topFinding(entries = uniqueUrlBurstEntries(), baseline?: ReturnType<typeof baselineWithColdPop>) {
  const m = computeCdnMetrics(entries, baseline);
  return classifyCacheMiss(m)[0];
}

describe('classifyCacheMiss — verdict per scenario', () => {
  it('unique-URL burst → cdn-unique-url-burst (high)', () => {
    const f = topFinding(uniqueUrlBurstEntries(200));
    expect(f.signatureId).toBe('cdn-unique-url-burst');
    expect(f.confidence).toBe('high');
  });

  it('repeated URLs on one POP with short TTL → cdn-stale-content (high)', () => {
    const f = topFinding(staleContentEntries(30, 10));
    expect(f.signatureId).toBe('cdn-stale-content');
    expect(f.confidence).toBe('high');
  });

  it('same URLs across many POPs → cdn-pop-fragmentation (high)', () => {
    const f = topFinding(popFragmentationEntries(30, ['BMA', 'FRA', 'LHR', 'AMS']));
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.confidence).toBe('high');
  });

  it('bots on a cold POP from one ASN → cdn-bot-cold-pop (high)', () => {
    const f = topFinding(botColdPopEntries(50, 3, 'XYZ'), baselineWithColdPop('XYZ'));
    expect(f.signatureId).toBe('cdn-bot-cold-pop');
    expect(f.confidence).toBe('high');
  });

  it('no-store responses → cdn-uncacheable (high), outranking fragmentation', () => {
    const entries = popFragmentationEntries(30, ['BMA', 'FRA', 'LHR', 'AMS'])
      .map(e => ({ ...e, isCacheable: false, fetchCacheControl: 'no-store' }));
    const findings = classifyCacheMiss(computeCdnMetrics(entries));
    expect(findings[0].signatureId).toBe('cdn-uncacheable');
    expect(findings[0].confidence).toBe('high');
  });

  it('cacheable content (max-age present) across POPs is fragmentation, NOT uncacheable — even when is_cacheable=false', () => {
    // Mirrors real data: is_cacheable=false but Cache-Control has max-age=900.
    const entries = popFragmentationEntries(30, ['BMA', 'FRA', 'LHR', 'AMS'])
      .map(e => ({ ...e, isCacheable: false, fetchCacheControl: 'max-age=900,stale-while-revalidate=1800' }));
    const findings = classifyCacheMiss(computeCdnMetrics(entries));
    expect(findings[0].signatureId).toBe('cdn-pop-fragmentation');
    expect(findings.find(f => f.signatureId === 'cdn-uncacheable')).toBeUndefined();
  });
});

describe('classifyCacheMiss — POP fragmentation + shielding', () => {
  const pops = ['BMA', 'FRA', 'LHR', 'AMS'];

  it('flags shielding OFF with enable-shielding guidance (5/5 high)', () => {
    const f = topFinding(popFragmentationEntries(30, pops)); // shieldingUsed defaults false
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.confidence).toBe('high');
    expect(f.evidence.join(' ')).toMatch(/shielding is OFF/i);
  });

  it('still fires when shielding is ON, noting the shield is not collapsing them', () => {
    const entries = popFragmentationEntries(30, pops).map(e => ({ ...e, shieldingUsed: true }));
    const f = topFinding(entries);
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.evidence.join(' ')).toMatch(/shielding is ON/i);
  });
});

describe('classifyCacheMiss — a URL MISSing once per POP is fragmentation, not stale', () => {
  it('does not flag stale content for cold first-fetches across POPs', () => {
    const findings = classifyCacheMiss(
      computeCdnMetrics(popFragmentationEntries(30, ['BMA', 'FRA', 'LHR', 'AMS', 'CDG']))
    );
    expect(findings[0].signatureId).toBe('cdn-pop-fragmentation');
    // stale content must not win / be high when every MISS is a cold first-fetch at a distinct POP
    const stale = findings.find(f => f.signatureId === 'cdn-stale-content');
    expect(stale?.confidence ?? 'absent').not.toBe('high');
    expect(findings[0].evidence.join(' ')).toMatch(/first fetch of that URL at that POP/i);
  });
});

describe('classifyCacheMiss — structure', () => {
  it('returns findings sorted by confidence with populated evidence and next steps', () => {
    const findings = classifyCacheMiss(computeCdnMetrics(uniqueUrlBurstEntries(200)));
    expect(findings.length).toBeGreaterThan(0);
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i - 1].confidenceScore).toBeGreaterThanOrEqual(findings[i].confidenceScore);
    }
    const top = findings[0];
    expect(top.matchedConditions.length).toBeGreaterThan(0);
    expect(top.evidence.length).toBeGreaterThan(0);
    expect(top.nextSteps.length).toBeGreaterThan(0);
  });

  it('returns no hypotheses when there are no MISSes', () => {
    const m = computeCdnMetrics([makeEntry({ cacheStatus: 'HIT' })]);
    expect(classifyCacheMiss(m)).toEqual([]);
  });
});

describe('PASS analysis findings', () => {
  it('flags a majority of PASS+200 (cacheable status bypassing cache)', () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ url: `/p${i}`, cacheStatus: 'PASS', status: 200, fetchAction: 'pass_noheaders120.000' })
    );
    const f = buildPass200Finding(computeCdnMetrics(entries))!;
    expect(f.signatureId).toBe('cdn-pass-200-bypass');
    expect(f.confidence).toBe('high');
    expect(f.evidence.join(' ')).toMatch(/no cache headers/i);
  });

  it('flags a majority of PASS non-200 (excl. 429) for manual investigation', () => {
    const entries = [
      ...Array.from({ length: 20 }, (_, i) => makeEntry({ url: `/r${i}`, cacheStatus: 'PASS', status: 301 })),
      ...Array.from({ length: 10 }, (_, i) => makeEntry({ url: `/e${i}`, cacheStatus: 'PASS', status: 500 }))
    ];
    const f = buildPassErrorFinding(computeCdnMetrics(entries))!;
    expect(f.signatureId).toBe('cdn-pass-non200');
    expect(f.evidence.join(' ')).toMatch(/HTTP 301/);
  });

  it('does not flag when PASS is mostly 429 (origin stress, not a PASS problem)', () => {
    const entries = Array.from({ length: 30 }, (_, i) => makeEntry({ url: `/x${i}`, cacheStatus: 'PASS', status: 429 }));
    const m = computeCdnMetrics(entries);
    expect(buildPassErrorFinding(m)).toBeNull();
    expect(buildPass200Finding(m)).toBeNull();
  });
});

describe('buildDdosFinding', () => {
  it('flags a cloud-ASN burst as suspicious/DDoS', () => {
    const f = buildDdosFinding(computeCdnMetrics(cloudBurstEntries()))!;
    expect(f.signatureId).toBe('cdn-ddos-pattern');
    expect(f.confidence).toBe('high');
    expect(f.evidence.join(' ').toLowerCase()).toContain('akamai');
  });

  it('flags traffic the CDN already marked (ddos_action) even without a big burst', () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      makeEntry({ url: `/p${i}`, cacheStatus: 'PASS', status: 403, ddosAction: 'blocked', clientAsName: 'comcast cable', clientAsNumber: '7922' })
    );
    const f = buildDdosFinding(computeCdnMetrics(entries))!;
    expect(f.signatureId).toBe('cdn-ddos-pattern');
  });

  it('is null for normal eyeball traffic', () => {
    const entries = uniqueUrlBurstEntries(50).map(e => ({ ...e, clientAsName: 'comcast cable', clientAsNumber: '7922', timeStart: new Date() }));
    expect(buildDdosFinding(computeCdnMetrics(entries))).toBeNull();
  });

  it('flags a single-IP/user-agent burst as suspicious even without a cloud ASN', () => {
    const f = buildDdosFinding(computeCdnMetrics(singleIpBurstEntries()))!;
    expect(f.signatureId).toBe('cdn-ddos-pattern');
    expect(f.evidence.join(' ')).toMatch(/single client ip/i);
    expect(f.evidence.join(' ')).toContain('curl/8.0');
  });

  it('is null for a genuine burst spread across many client IPs/user agents/countries', () => {
    expect(buildDdosFinding(computeCdnMetrics(diverseSourceBurstEntries()))).toBeNull();
  });
});

describe('buildTtlRecommendation', () => {
  function repeatedTimed() {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const out = [];
    for (let u = 0; u < 12; u++) {
      out.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base) }));
      out.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=60', timeStart: new Date(base + 120000) }));
    }
    return out;
  }

  it('recommends increasing the TTL when current max-age is shorter than the request gap', () => {
    const f = buildTtlRecommendation(computeCdnMetrics(repeatedTimed()))!;
    expect(f.signatureId).toBe('cdn-ttl-recommendation');
    expect(f.confidence).toBe('high');           // p90 gap 120s > current 60s
    expect(f.nextSteps.join(' ')).toMatch(/Surrogate-Control: max-age=300/);
  });

  it('never recommends lowering the TTL when current already exceeds the request gap', () => {
    // 12 URLs, 2 requests 60s apart, but current max-age is 900s (>> the 60s gap).
    const base = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    for (let u = 0; u < 12; u++) {
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=900', timeStart: new Date(base) }));
      entries.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=900', timeStart: new Date(base + 60000) }));
    }
    const m = computeCdnMetrics(entries);
    expect(m.recommendedTtlSeconds).toBeGreaterThanOrEqual(900); // never below current
    const f = buildTtlRecommendation(m)!;
    expect(f.signatureName.toLowerCase()).toMatch(/do not lower|adequate/);
    expect(f.confidence).toBe('low');
    expect(f.evidence.join(' ')).toMatch(/lowering it would only ADD MISSes/i);
  });

  it('is null when there is not enough repeat-request timing', () => {
    const entries = uniqueUrlBurstEntries(50).map(e => ({ ...e, timeStart: new Date() }));
    expect(buildTtlRecommendation(computeCdnMetrics(entries))).toBeNull();
  });
});

describe('build429Context', () => {
  it('is null when there were no 429s', () => {
    expect(build429Context(computeCdnMetrics(uniqueUrlBurstEntries(10)))).toBeNull();
  });

  it('summarises the 429 correlation as a high-confidence context finding', () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => makeEntry({ url: `/m${i}`, cacheStatus: 'MISS', status: 429 })),
      ...Array.from({ length: 2 }, (_, i) => makeEntry({ url: `/h${i}`, cacheStatus: 'HIT', status: 200 }))
    ];
    const ctx = build429Context(computeCdnMetrics(entries))!;
    expect(ctx.signatureId).toBe('cdn-rate-limit-429');
    expect(ctx.confidence).toBe('high');       // all 429s were on MISSes
    expect(ctx.matchedConditions.some(c => c.field === 'missWith429Count')).toBe(true);
  });
});
