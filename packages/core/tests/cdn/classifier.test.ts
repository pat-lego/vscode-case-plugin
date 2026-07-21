import { describe, it, expect } from 'vitest';
import { computeCdnMetrics } from '../../src/cdn/metrics';
import { classifyCacheMiss, build429Context, buildPass200Finding, buildPassErrorFinding, buildTtlRecommendation, buildDdosFinding } from '../../src/cdn/classifier';
import { UpstreamCdnMatch } from '../../src/cdn/upstream-cdn';
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

describe('cdn-stale-content — Vary fragmentation and concrete TTL/SWR recommendation', () => {
  function findStaleContent(entries: ReturnType<typeof staleContentEntries>) {
    return classifyCacheMiss(computeCdnMetrics(entries)).find(f => f.signatureId === 'cdn-stale-content');
  }

  it('flags high-cardinality Vary fragmentation with real numbers, not a bare suggestion', () => {
    const entries = staleContentEntries(30, 10).map(e => ({ ...e, responseVary: 'Accept-Encoding, User-Agent' }));
    const f = findStaleContent(entries)!;
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/of MISSes carry a Vary header — top values: "Accept-Encoding, User-Agent"/);
    expect(evidence).toMatch(/high-cardinality header \(User-Agent \/ Cookie \/ Authorization \/ X-Forwarded-For \/ Accept-Language\)/);
  });

  it('distinguishes low-cardinality-only Vary (Accept-Encoding) from high-cardinality fragmentation', () => {
    const entries = staleContentEntries(30, 10).map(e => ({ ...e, responseVary: 'Accept-Encoding' }));
    const f = findStaleContent(entries)!;
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/Vary is limited to lower-cardinality headers here/);
    expect(evidence).not.toMatch(/high-cardinality header/);
  });

  it('states plainly when no Vary header is present at all', () => {
    const f = findStaleContent(staleContentEntries(30, 10))!;
    expect(f.evidence.join(' ')).toMatch(/No Vary header observed on these MISSes/);
  });

  it('embeds the concrete recommended max-age/SWR values instead of a vague "raise them"', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    for (let u = 0; u < 12; u++) {
      entries.push(makeEntry({ url: `/article/${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=30', responseTtl: 30, timeStart: new Date(base) }));
      entries.push(makeEntry({ url: `/article/${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchCacheControl: 'max-age=30', responseTtl: 30, timeStart: new Date(base + 120000) }));
    }
    const m = computeCdnMetrics(entries);
    expect(m.ttlDataSufficient).toBe(1);
    const f = classifyCacheMiss(m).find(fnd => fnd.signatureId === 'cdn-stale-content')!;
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/Recommended fix \(full reasoning in the TTL-recommendation finding\): max-age ~5m \(current 30s\), stale-while-revalidate ~7d \(current none\)/);
    expect(f.nextSteps.join(' ')).toMatch(/apply the recommended max-age\/stale-while-revalidate values shown above/i);
    expect(f.relatedSignatures).toContain('cdn-ttl-recommendation');
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

  it('offers remediation beyond shielding: stale-while-revalidate and cache warming', () => {
    const f = topFinding(popFragmentationEntries(30, pops));
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    const steps = f.nextSteps.join(' ');
    expect(steps).toMatch(/stale-while-revalidate/i);
    expect(steps).toMatch(/pre-warm/i);
    expect(steps).toMatch(/not available or not easy to turn on/i);
    expect(f.relatedSignatures).toContain('cdn-ttl-recommendation');
  });

  it('surfaces the repeat-same-POP share as the specifically SWR-fixable portion', () => {
    // Mostly genuine cold first-fetches per POP, plus a few re-fetches of a URL already cached
    // at that SAME POP (repeatSamePopShare > 0) — the share stale-while-revalidate alone can fix.
    const entries = [
      ...popFragmentationEntries(30, pops),
      ...Array.from({ length: 10 }, (_, u) => makeEntry({ url: `/article/${u}`, pop: 'BMA', responseTtl: 3600 }))
    ];
    const f = topFinding(entries);
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.evidence.join(' ')).toMatch(/already cached at that SAME POP before going stale/i);
  });

  it('flags a clustered cold-fetch burst as a likely invalidation event, not a caching-architecture problem', () => {
    const t0 = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    for (let u = 0; u < 20; u++) {
      for (const pop of pops) {
        entries.push(makeEntry({ url: `/article/${u}`, pop, cacheStatus: 'MISS', timeStart: new Date(t0) }));
      }
    }
    entries.push(makeEntry({ url: '/article/0', pop: 'BMA', cacheStatus: 'MISS', timeStart: new Date(t0 + 60000) }));
    const f = topFinding(entries);
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.evidence.join(' ')).toMatch(/clustered in time.*synchronized invalidation/i);
    expect(f.nextSteps.join(' ')).toMatch(/deploy\/purge event/i);
    // The ratio itself must be visible in "Signals matched" (matchedConditions), not just prose.
    const cond = f.matchedConditions.find(c => c.field === 'coldFetchBurstRatio');
    expect(cond).toBeDefined();
    expect(String(cond!.observedValue)).toMatch(/^\d+\.\d×$/);
  });

  it('does not let the informational coldFetchBurstRatio condition dilute the confidence score', () => {
    // 5/5 scored conditions match here (see the "5/5 high" test above); the informational
    // condition must not silently become a 6th vote and drag the score down to 5/6.
    const f = topFinding(popFragmentationEntries(30, pops));
    expect(f.confidenceScore).toBe(1);
  });

  it('reads a diffuse cold-fetch spread as organic per-POP traffic, not an invalidation event', () => {
    const t0 = Date.parse('2026-07-16T03:40:00Z');
    const entries = [];
    let i = 0;
    for (let u = 0; u < 20; u++) {
      for (const pop of pops) {
        entries.push(makeEntry({ url: `/article/${u}`, pop, cacheStatus: 'MISS', timeStart: new Date(t0 + i * 1000) }));
        i++;
      }
    }
    const f = topFinding(entries);
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    expect(f.evidence.join(' ')).toMatch(/spread through the window.*organic per-POP traffic diversity/i);
  });

  it('warns that a short window with mostly single-shot URLs cannot yield a trustworthy fragmentation share', () => {
    // Every MISSed URL requested exactly once — no repeat opportunity at all in this window.
    const entries = pops.flatMap(pop =>
      Array.from({ length: 10 }, (_, u) => makeEntry({ url: `/x-${pop}-${u}`, pop, cacheStatus: 'MISS' }))
    );
    const m = computeCdnMetrics(entries);
    expect(m.singleRequestMissUrlShare).toBe(1);
    const findings = classifyCacheMiss(m);
    const f = findings.find(fnd => fnd.signatureId === 'cdn-pop-fragmentation');
    expect(f?.evidence.join(' ')).toMatch(/requested only once in this window.*cannot be told apart/i);
  });

  it('shows decimal precision instead of a misleading 100%/0% when a share is merely close to the boundary', () => {
    // 2000 cold first-fetches + 1 same-POP repeat -> coldPopFirstFetchShare = 2000/2001 = 99.950...%,
    // repeatSamePopShare = 1/2001 = 0.0499...% — neither is exactly 100% or 0%, and must not print as such.
    const entries = [
      ...popFragmentationEntries(500, pops),
      makeEntry({ url: '/article/0', pop: 'BMA', cacheStatus: 'MISS' })
    ];
    const f = topFinding(entries);
    expect(f.signatureId).toBe('cdn-pop-fragmentation');
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/99\.95\d?%/);
    expect(evidence).not.toMatch(/100% of MISSes are the first fetch/);
    expect(evidence).toMatch(/0\.0[45]%/);
    expect(evidence).not.toMatch(/0% of MISSes were already cached/);
  });

  it('still prints a plain whole-number percentage for an exact 100%/0% (a real, not rounded, boundary)', () => {
    const f = topFinding(popFragmentationEntries(30, pops)); // every MISS is a genuine cold first-fetch
    expect(f.evidence.join(' ')).toMatch(/100% of MISSes are the first fetch/);
  });
});

describe('cdn-bot-cold-pop — distinguishing a forwarding CDN from a bot/attacker', () => {
  const upstreamAkamai: UpstreamCdnMatch = {
    hostname: 'www.macnica.com',
    chain: ['www.macnica.com.edgekey.net'],
    provider: 'akamai'
  };

  function findBotColdPop(entries: ReturnType<typeof botColdPopEntries>, upstreamCdn?: UpstreamCdnMatch | null) {
    const m = computeCdnMetrics(entries, baselineWithColdPop('XYZ'));
    return classifyCacheMiss(m, upstreamCdn).find(f => f.signatureId === 'cdn-bot-cold-pop');
  }

  it('explains a top ASN verified via DNS AND its own forwarding headers, instead of a bare count', () => {
    const entries = [
      ...botColdPopEntries(50, 3, 'XYZ'),
      ...Array.from({ length: 80 }, (_, i) => makeEntry({
        url: `/page${i}`, pop: 'BMA',
        clientIp: '23.52.12.49', clientAsNumber: '20940', clientAsName: 'akamai international b.v.',
        originalXForwardedFor: '135.132.91.21, 23.52.12.49', requestVia: '1.1 akamai.net(ghost) (AkamaiGHost)'
      }))
    ];
    const f = findBotColdPop(entries, upstreamAkamai)!;
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/AS20940 akamai international b\.v\. looks like this origin's own CDN forwarding real visitor traffic, not a bot or attack source/);
    expect(evidence).toMatch(/DNS confirms this origin is fronted by akamai/);
    expect(evidence).toMatch(/real end-user IP \(135\.132\.91\.21\)/);
    expect(evidence).toMatch(/Via: 1\.1 akamai\.net\(ghost\) \(AkamaiGHost\)/);
  });

  it('still flags a forwarding-looking ASN from its headers alone, with no DNS match at all', () => {
    const entries = [
      ...botColdPopEntries(50, 3, 'XYZ'),
      ...Array.from({ length: 80 }, (_, i) => makeEntry({
        url: `/page${i}`, pop: 'BMA',
        clientIp: '52.1.2.3', clientAsNumber: '54994', clientAsName: 'meteverse limited.',
        originalXForwardedFor: '52.167.144.143, 52.1.2.3', requestVia: ''
      }))
    ];
    const f = findBotColdPop(entries, null)!;
    const evidence = f.evidence.join(' ');
    expect(evidence).toMatch(/AS54994 meteverse limited\. looks like this origin's own CDN forwarding real visitor traffic/);
    expect(evidence).toMatch(/real end-user IP \(52\.167\.144\.143\)/);
    expect(evidence).not.toMatch(/DNS confirms/);
  });

  it('leaves an ordinary ASN with no forwarding evidence and no DNS match as a plain count', () => {
    const f = findBotColdPop(botColdPopEntries(50, 3, 'XYZ'))!;
    expect(f.evidence.join(' ')).not.toMatch(/looks like this origin's own CDN/);
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

describe('buildDdosFinding — upstream CDN cross-check', () => {
  // The origin (www.macnica.com) is fronted by Akamai; DNS confirms it (CNAME -> ...edgekey.net).
  const upstreamAkamai: UpstreamCdnMatch = {
    hostname: 'www.macnica.com',
    chain: ['www.macnica.com.edgekey.net'],
    provider: 'akamai'
  };

  it('fully rules out a burst when excluding the origin\'s own CDN leaves no other signal', () => {
    // Same cloud ASN as cloudBurstEntries(), but spread across diverse client IPs/UAs/countries so
    // no OTHER independent concentration signal survives once the known ASN is excluded.
    const entries = diverseSourceBurstEntries().map(e => ({ ...e, clientAsName: 'akamai international b.v.', clientAsNumber: '20940' }));

    // Sanity check: without the DNS cross-check, the concentrated cloud ASN alone is enough to flag it.
    expect(buildDdosFinding(computeCdnMetrics(entries))).not.toBeNull();

    expect(buildDdosFinding(computeCdnMetrics(entries), upstreamAkamai)).toBeNull();
  });

  it('narrows the evidence but still fires when another independent signal survives the exclusion', () => {
    // cloudBurstEntries() shares one client IP/UA across every request, so that concentration
    // signal (unrelated to the ASN) still legitimately warrants a look even once Akamai is excluded.
    const f = buildDdosFinding(computeCdnMetrics(cloudBurstEntries()), upstreamAkamai)!;
    expect(f).not.toBeNull();
    expect(f.evidence.join(' ')).toMatch(/own CDN/i);
    expect(f.evidence.join(' ')).toMatch(/confirmed via DNS/i);
    expect(f.evidence.join(' ')).toMatch(/www\.macnica\.com\.edgekey\.net/);
    // Must not tell the responder to block their own front-door CDN.
    expect(f.nextSteps.join(' ')).toMatch(/NOT akamai/i);
  });

  it('has no effect when the DNS-confirmed provider does not match any flagged ASN', () => {
    const withoutUpstream = buildDdosFinding(computeCdnMetrics(cloudBurstEntries()));
    const mismatched: UpstreamCdnMatch = { hostname: 'www.macnica.com', chain: ['x.cloudflare.net'], provider: 'cloudflare' };
    const withMismatch = buildDdosFinding(computeCdnMetrics(cloudBurstEntries()), mismatched);
    expect(withMismatch).toEqual(withoutUpstream);
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

  it('recommends a generous (1-week floor) stale-while-revalidate value alongside the TTL raise', () => {
    const f = buildTtlRecommendation(computeCdnMetrics(repeatedTimed()))!;
    expect(f.nextSteps.join(' ')).toMatch(/stale-while-revalidate=7d/);
    expect(f.nextSteps.join(' ')).toMatch(/works even if shielding is not available/i);
    expect(f.matchedConditions.some(c => c.field === 'recommendedSwrSeconds')).toBe(true);
  });

  it('does not re-suggest stale-while-revalidate when it already exceeds the default floor', () => {
    const base = Date.parse('2026-07-16T03:40:00Z');
    const twoWeeks = 14 * 86400;
    const out = [];
    for (let u = 0; u < 12; u++) {
      out.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchSurrogateControl: `max-age=60,stale-while-revalidate=${twoWeeks}`, timeStart: new Date(base) }));
      out.push(makeEntry({ url: `/u${u}`, pop: 'BMA', cacheStatus: 'MISS', fetchSurrogateControl: `max-age=60,stale-while-revalidate=${twoWeeks}`, timeStart: new Date(base + 120000) }));
    }
    const f = buildTtlRecommendation(computeCdnMetrics(out))!;
    expect(f.nextSteps.join(' ')).not.toMatch(/stale-while-revalidate=/);
    expect(f.matchedConditions.some(c => c.field === 'recommendedSwrSeconds')).toBe(false);
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
