import { CdnLogEntry, CdnMetrics, PopBaseline } from './types';

/** MISS re-fetch within this many seconds is treated as "should have been cached". */
const SHORT_TTL_SECONDS = 120;
/** A POP contributing below this fraction of baseline traffic is "rare" (history-based). */
const RARE_POP_BASELINE_SHARE = 0.01;
/** A POP contributing below this fraction of in-window traffic is "rare" (no-baseline heuristic). */
const RARE_POP_INWINDOW_SHARE = 0.02;

/**
 * ASN-name patterns for cloud / hosting / datacenter networks (as opposed to eyeball ISPs).
 * Organic page traffic rarely originates from these; a burst from them is a DDoS/bot signal.
 */
const CLOUD_ASN_RE = /\b(amazon|aws|google|microsoft|azure|akamai|cloudflare|fastly|digitalocean|linode|vultr|ovh|hetzner|leaseweb|contabo|scaleway|choopa|m247|datacamp|oracle|alibaba|aliyun|tencent|huawei|meteverse|hostwinds|colocrossing|quadranet|psychz|constant|limelight|edgecast|stackpath|gcore|selectel|clouvider|servers\.com|hosting|datacenter|data ?center|colo|vps|cloud)\b/i;
function isCloudAsn(name: string): boolean {
  return CLOUD_ASN_RE.test(name || '');
}

/** Field values that mean "absent" across the CDN log (empty, dash, none, …). */
const BLANK = new Set(['', '-', 'none', 'n/a', '?']);
function hasVal(s: string): boolean {
  return !BLANK.has(s.trim().toLowerCase());
}
function ratio(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

/** True if a Cache-Control/Surrogate-Control string grants a positive freshness lifetime. */
function hasPositiveTtl(directives: string): boolean {
  const m = directives.match(/(?:s-maxage|max-age)\s*=\s*(\d+)/i);
  return !!m && parseInt(m[1], 10) > 0;
}
/** True if a Cache-Control string forbids storage (no-store/no-cache/private/max-age=0). */
function hasNoStore(cacheControl: string): boolean {
  return /\b(no-store|no-cache|private)\b/i.test(cacheControl) || /\bmax-age\s*=\s*0\b/i.test(cacheControl);
}
/** Extracts the max-age / s-maxage value (seconds) from a directive string, or 0 if none. */
function extractMaxAge(directives: string): number {
  const m = directives.match(/(?:s-maxage|max-age)\s*=\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

/** Human-friendly TTL steps (seconds) used when rounding a recommendation up. */
const NICE_TTLS = [300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
function niceTtl(seconds: number): number {
  for (const t of NICE_TTLS) if (t >= seconds) return t;
  return NICE_TTLS[NICE_TTLS.length - 1];
}
/** Percentile of an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length))];
}
/** Records a timestamp into a per-key {min,max,count} span (order-independent inter-arrival). */
function updateSpan(map: Map<string, { min: number; max: number; count: number }>, key: string, ms: number): void {
  const s = map.get(key);
  if (s) {
    if (ms < s.min) s.min = ms;
    if (ms > s.max) s.max = ms;
    s.count++;
  } else {
    map.set(key, { min: ms, max: ms, count: 1 });
  }
}

/** Edge cache disposition, prioritising `cache_status`, then `fastly_info_state`, then x-cache. */
export function disposition(e: CdnLogEntry): 'MISS' | 'HIT' | 'PASS' | 'OTHER' {
  const s = e.cacheStatus || e.fastlyState || e.xCache;
  if (!s) return 'OTHER';
  if (s.includes('MISS')) return 'MISS';
  if (s.includes('PASS')) return 'PASS'; // before HIT: "HITPASS" is a pass decided at hit time
  if (s.includes('HIT')) return 'HIT';
  return 'OTHER';
}

function is429(e: CdnLogEntry): boolean {
  return e.status === 429 || e.originStatus === 429;
}

/**
 * Incremental CDN metrics aggregator. Events are fed one at a time via {@link add} and the flat
 * scalar {@link CdnMetrics} summary is produced by {@link finalize}. Memory scales with the number
 * of *distinct* URLs / POPs / bots / ASNs — not with the total event count — so the streaming
 * fetch path can process arbitrarily large CDN responses without buffering them.
 *
 * All URL/POP/bot signals are accumulated over the MISS set only; PASS/HIT are tracked for context.
 */
export class CdnAggregator {
  private total = 0;
  private missCount = 0;
  private hitCount = 0;
  private passCount = 0;
  private otherCount = 0;
  private passWith200Count = 0;
  private pass429Count = 0;
  private passNon200Non429Count = 0;
  private passStatus = new Map<number, number>();
  private pass200NoHeadersCount = 0;
  private pass200PrivateCount = 0;
  private pass200UrlCount = new Map<string, number>();

  private error429Count = 0;
  private missWith429Count = 0;
  private originError5xxCount = 0;
  private cdnDeniedCount = 0;

  private popTotalAll = new Map<string, number>();   // all dispositions — for in-window rarity

  // MISS-only accumulators
  private urlCount = new Map<string, number>();
  private urlPops = new Map<string, Set<string>>();
  private popMissCount = new Map<string, number>();
  private missWithPopCount = 0;
  private shieldedMissCount = 0;
  private ttlSum = 0;
  private ttlCount = 0;
  private shortTtlMissCount = 0;
  private staleEligibleCount = 0;
  private cacheableFalseCount = 0;
  private misspassMissCount = 0;
  private noPositiveTtlMissCount = 0;
  private noStoreMissCount = 0;
  private sampleMissCacheControl = '';
  private sampleMissSurrogateControl = '';
  private sampleCaptured = false;
  private ctCount = new Map<string, number>();
  private botMissCount = 0;
  private botCount = new Map<string, number>();
  private botMissByPop = new Map<string, number>();
  private asnCount = new Map<string, number>();
  private asnName = new Map<string, string>();
  private missTimed = 0;
  private refetch = new Map<string, { ms: number; ttl: number }>();
  private refetchWithinTtlCount = 0;

  // Request-rate / inter-arrival tracking (cacheable HIT+MISS) for TTL sizing
  private minTs = Infinity;
  private maxTs = -Infinity;
  private cacheableTimed = 0;
  private maxAgeCount = new Map<number, number>();
  private urlSpan = new Map<string, { min: number; max: number; count: number }>();
  private urlPopSpan = new Map<string, { min: number; max: number; count: number }>();

  // DDoS / traffic-source signals (over all requests)
  private asnAll = new Map<string, { count: number; name: string }>();
  private cloudAsnRequestCount = 0;
  private cdnThreatCount = 0;
  private perSecCount = new Map<number, number>();
  private allTimed = 0;
  private allMinMs = Infinity;
  private allMaxMs = -Infinity;
  private clientIpAll = new Map<string, number>();
  private userAgentAll = new Map<string, number>();
  private countryAll = new Map<string, number>();

  /** Folds one log event into the running aggregates. */
  add(e: CdnLogEntry): void {
    this.total++;

    if (hasVal(e.pop)) this.popTotalAll.set(e.pop, (this.popTotalAll.get(e.pop) ?? 0) + 1);

    // Error signals span all dispositions.
    const rateLimited = is429(e);
    if (rateLimited) this.error429Count++;
    if (e.originStatus >= 500 && e.originStatus < 600) this.originError5xxCount++;
    if (hasVal(e.ddosAction) || hasVal(e.denyReason)) this.cdnDeniedCount++;

    // DDoS / traffic-source signals over ALL requests.
    if (hasVal(e.clientAsNumber)) {
      const a = this.asnAll.get(e.clientAsNumber);
      if (a) { a.count++; if (e.clientAsName) a.name = e.clientAsName; }
      else this.asnAll.set(e.clientAsNumber, { count: 1, name: e.clientAsName });
      if (isCloudAsn(e.clientAsName)) this.cloudAsnRequestCount++;
    }
    if (hasVal(e.ddosAction) || hasVal(e.ddosRule) || hasVal(e.maliciousFlags) || hasVal(e.denyReason)) this.cdnThreatCount++;
    if (hasVal(e.clientIp)) this.clientIpAll.set(e.clientIp, (this.clientIpAll.get(e.clientIp) ?? 0) + 1);
    if (hasVal(e.userAgent)) this.userAgentAll.set(e.userAgent, (this.userAgentAll.get(e.userAgent) ?? 0) + 1);
    if (hasVal(e.geoCountryCode)) this.countryAll.set(e.geoCountryCode, (this.countryAll.get(e.geoCountryCode) ?? 0) + 1);
    if (e.timeStart instanceof Date) {
      const ms = e.timeStart.getTime();
      if (ms < this.allMinMs) this.allMinMs = ms;
      if (ms > this.allMaxMs) this.allMaxMs = ms;
      this.allTimed++;
      const sec = Math.floor(ms / 1000);
      this.perSecCount.set(sec, (this.perSecCount.get(sec) ?? 0) + 1);
    }

    const disp = disposition(e);

    // Inter-arrival tracking over cacheable (HIT|MISS) requests, for TTL sizing.
    if ((disp === 'HIT' || disp === 'MISS') && e.timeStart instanceof Date) {
      const ms = e.timeStart.getTime();
      if (ms < this.minTs) this.minTs = ms;
      if (ms > this.maxTs) this.maxTs = ms;
      this.cacheableTimed++;
      updateSpan(this.urlSpan, e.url, ms);
      if (hasVal(e.pop)) updateSpan(this.urlPopSpan, `${e.url} ${e.pop}`, ms);
    }

    switch (disp) {
      case 'HIT':
        this.hitCount++;
        return;
      case 'PASS':
        this.passCount++;
        this.passStatus.set(e.status, (this.passStatus.get(e.status) ?? 0) + 1);
        if (e.status === 200) {
          this.passWith200Count++;
          this.pass200UrlCount.set(e.url, (this.pass200UrlCount.get(e.url) ?? 0) + 1);
          if (/pass_noheaders/i.test(e.fetchAction)) this.pass200NoHeadersCount++;
          if (/pass_(s_)?private/i.test(e.fetchAction)) this.pass200PrivateCount++;
        } else if (e.status === 429) {
          this.pass429Count++;
        } else {
          this.passNon200Non429Count++;
        }
        return;
      case 'OTHER':
        this.otherCount++;
        return;
      case 'MISS':
        break;
    }

    // ── MISS-only ────────────────────────────────────────────────────────────────
    this.missCount++;
    if (rateLimited) this.missWith429Count++;

    this.urlCount.set(e.url, (this.urlCount.get(e.url) ?? 0) + 1);
    if (hasVal(e.pop)) {
      let pops = this.urlPops.get(e.url);
      if (!pops) { pops = new Set(); this.urlPops.set(e.url, pops); }
      pops.add(e.pop);
      this.popMissCount.set(e.pop, (this.popMissCount.get(e.pop) ?? 0) + 1);
      this.missWithPopCount++;
    }
    if (e.shieldingUsed) this.shieldedMissCount++;

    if (e.responseTtl > 0) {
      this.ttlSum += e.responseTtl;
      this.ttlCount++;
      if (e.responseTtl < SHORT_TTL_SECONDS) this.shortTtlMissCount++;
    }
    if (/stale-while-revalidate|stale-if-error/i.test(e.fetchSurrogateControl)) this.staleEligibleCount++;
    if (!e.isCacheable) this.cacheableFalseCount++;
    if (/^pass/i.test(e.fetchAction)) this.misspassMissCount++;

    // Why is it uncacheable? Inspect the origin cache directives (AEM drives CDN caching via these).
    if (!hasPositiveTtl(`${e.fetchCacheControl};${e.fetchSurrogateControl}`)) this.noPositiveTtlMissCount++;
    if (hasNoStore(e.fetchCacheControl)) this.noStoreMissCount++;
    if (!e.isCacheable && !this.sampleCaptured && (e.fetchCacheControl.trim() || e.fetchSurrogateControl.trim())) {
      this.sampleMissCacheControl = e.fetchCacheControl.trim();
      this.sampleMissSurrogateControl = e.fetchSurrogateControl.trim();
      this.sampleCaptured = true;
    }
    const maxAge = extractMaxAge(`${e.fetchCacheControl};${e.fetchSurrogateControl}`);
    if (maxAge > 0) this.maxAgeCount.set(maxAge, (this.maxAgeCount.get(maxAge) ?? 0) + 1);

    const ct = e.contentType.split(';')[0].trim() || 'unknown';
    this.ctCount.set(ct, (this.ctCount.get(ct) ?? 0) + 1);

    if (hasVal(e.botName)) {
      this.botMissCount++;
      this.botCount.set(e.botName, (this.botCount.get(e.botName) ?? 0) + 1);
      if (hasVal(e.pop)) this.botMissByPop.set(e.pop, (this.botMissByPop.get(e.pop) ?? 0) + 1);
    }
    if (hasVal(e.clientAsNumber)) {
      this.asnCount.set(e.clientAsNumber, (this.asnCount.get(e.clientAsNumber) ?? 0) + 1);
      if (e.clientAsName) this.asnName.set(e.clientAsNumber, e.clientAsName);
    }

    // Same URL + POP re-fetched within the previous TTL — a "not actually cached" signal.
    // Order-agnostic (uses |Δt|) so it does not require a costly time sort in the query.
    if (e.timeStart instanceof Date) {
      this.missTimed++;
      const key = `${e.url} ${e.pop}`;
      const ms = e.timeStart.getTime();
      const prev = this.refetch.get(key);
      if (prev && prev.ttl > 0 && Math.abs(ms - prev.ms) / 1000 < prev.ttl) this.refetchWithinTtlCount++;
      this.refetch.set(key, { ms, ttl: e.responseTtl });
    }
  }

  /** PASS-set breakdown (status split + why 200s bypassed cache) — shared by both finalize paths. */
  private passPart() {
    return {
      passCount: this.passCount,
      passWith200Count: this.passWith200Count,
      passWith200Share: ratio(this.passWith200Count, this.passCount),
      passNon200Count: this.passCount - this.passWith200Count,
      pass429Count: this.pass429Count,
      passNon200Non429Count: this.passNon200Non429Count,
      passNon200Non429Share: ratio(this.passNon200Non429Count, this.passCount),
      pass200NoHeadersShare: ratio(this.pass200NoHeadersCount, this.passWith200Count),
      pass200PrivateShare: ratio(this.pass200PrivateCount, this.passWith200Count),
      passStatusTop: [...this.passStatus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([status, count]) => ({ status, count })),
      topPass200Urls: [...this.pass200UrlCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([url, count]) => ({ url, count }))
    };
  }

  /** DDoS / traffic-source signals (over all requests) — shared by both finalize paths. */
  private ddosPart() {
    let topAsnCount = 0;
    let topAsnRequestName = '';
    for (const [, a] of this.asnAll) {
      if (a.count > topAsnCount) { topAsnCount = a.count; topAsnRequestName = a.name; }
    }
    let peakRequestsPerSec = 0;
    for (const c of this.perSecCount.values()) if (c > peakRequestsPerSec) peakRequestsPerSec = c;
    const windowSecAll = this.allMaxMs > this.allMinMs ? (this.allMaxMs - this.allMinMs) / 1000 : 0;
    const meanPerSec = windowSecAll > 0 ? this.allTimed / windowSecAll : 0;
    const topClientIp = topEntry(this.clientIpAll);
    const topUserAgent = topEntry(this.userAgentAll);
    const topCountry = topEntry(this.countryAll);
    return {
      cloudAsnRequestShare: ratio(this.cloudAsnRequestCount, this.total),
      topAsnRequestShare: ratio(topAsnCount, this.total),
      topAsnRequestName,
      peakRequestsPerSec,
      burstRatio: meanPerSec > 0 ? peakRequestsPerSec / meanPerSec : 0,
      cdnThreatShare: ratio(this.cdnThreatCount, this.total),
      topSourceAsns: [...this.asnAll.entries()]
        .sort((a, b) => b[1].count - a[1].count).slice(0, 6)
        .map(([asn, a]) => ({ asn, name: a.name, count: a.count, cloud: isCloudAsn(a.name) })),
      distinctClientIpCount: this.clientIpAll.size,
      topClientIpRequestShare: ratio(topClientIp.count, this.total),
      topClientIpAddress: topClientIp.key,
      topClientIps: [...this.clientIpAll.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, count]) => ({ ip, count })),
      distinctUserAgentCount: this.userAgentAll.size,
      topUserAgentRequestShare: ratio(topUserAgent.count, this.total),
      topUserAgentName: topUserAgent.key,
      topUserAgents: [...this.userAgentAll.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([userAgent, count]) => ({ userAgent, count })),
      distinctCountryCount: this.countryAll.size,
      topCountryRequestShare: ratio(topCountry.count, this.total),
      topCountryCode: topCountry.key,
      topCountries: [...this.countryAll.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([country, count]) => ({ country, count }))
    };
  }

  /** Produces the final metrics; pass a {@link PopBaseline} to define POP rarity from history. */
  finalize(baseline?: PopBaseline): CdnMetrics {
    const warnings: string[] = [];

    if (this.total === 0) {
      return emptyMetrics(['No CDN log events matched the query.']);
    }
    if (this.missCount === 0) {
      warnings.push('No cache MISS events in the result — nothing to attribute a MISS storm to.');
      const m = emptyMetrics(warnings);
      Object.assign(m, this.passPart(), this.ddosPart());
      m.totalRequests = this.total;
      m.hitCount = this.hitCount;
      m.otherCount = this.otherCount;
      m.error429Count = this.error429Count;
      m.error429Ratio = ratio(this.error429Count, this.total);
      m.originError5xxCount = this.originError5xxCount;
      m.cdnDeniedCount = this.cdnDeniedCount;
      return m;
    }

    const missCount = this.missCount;

    if (this.missTimed > 0 && this.missTimed < missCount) {
      warnings.push('Some MISS events lack time_start — TTL re-fetch timing is partial.');
    }

    // URL cardinality
    const distinctMissUrlCount = this.urlCount.size;
    let singleRequestMissUrlCount = 0;
    let repeatedMissUrlCount = 0;
    let maxRequestsForSingleMissUrl = 0;
    let popsPerRepeatedSum = 0;
    let repeatedUrlMultiPopCount = 0;
    let distinctUrlPopPairs = 0;
    for (const [url, count] of this.urlCount) {
      const pops = this.urlPops.get(url)?.size ?? 0;
      distinctUrlPopPairs += pops;
      if (count === 1) singleRequestMissUrlCount++;
      if (count > 1) {
        repeatedMissUrlCount++;
        popsPerRepeatedSum += pops;
        if (pops > 1) repeatedUrlMultiPopCount++;
      }
      if (count > maxRequestsForSingleMissUrl) maxRequestsForSingleMissUrl = count;
    }
    // Each distinct (url,pop) pair is one "first fetch at that POP"; the rest are same-POP repeats.
    const firstFetchPerPopMissCount = distinctUrlPopPairs;
    const repeatSamePopMissCount = Math.max(0, this.missWithPopCount - distinctUrlPopPairs);

    // ── TTL / request-rate sizing (over cacheable HIT+MISS with timestamps) ──────────
    const windowSeconds = this.maxTs > this.minTs ? (this.maxTs - this.minTs) / 1000 : 0;
    const cacheableRequestRatePerMin = windowSeconds > 0 ? this.cacheableTimed / (windowSeconds / 60) : 0;
    // Mean inter-arrival per URL (aggregate = shield view) and per URL+POP (edge view).
    const aggGaps: number[] = [];
    let singleReqUrls = 0;
    for (const s of this.urlSpan.values()) {
      if (s.count >= 2) aggGaps.push((s.max - s.min) / 1000 / (s.count - 1));
      else singleReqUrls++;
    }
    const popGaps: number[] = [];
    for (const s of this.urlPopSpan.values()) {
      if (s.count >= 2) popGaps.push((s.max - s.min) / 1000 / (s.count - 1));
    }
    aggGaps.sort((a, b) => a - b);
    popGaps.sort((a, b) => a - b);
    const p50AggGapSeconds = percentile(aggGaps, 0.5);
    const p90AggGapSeconds = percentile(aggGaps, 0.9);
    const p90PerPopGapSeconds = percentile(popGaps, 0.9);
    const ttlDataSufficient = aggGaps.length >= 10 && windowSeconds > 0 ? 1 : 0;
    const singleRequestCacheableUrlShare = this.urlSpan.size > 0 ? singleReqUrls / this.urlSpan.size : 0;
    // Representative current TTL = the most common max-age among cacheable MISSes (mode),
    // so an asset's long TTL does not mask the pages' shorter one (or vice versa).
    let observedMaxAgeSeconds = 0;
    let maxAgeModeCount = 0;
    for (const [age, count] of this.maxAgeCount) {
      if (count > maxAgeModeCount) { maxAgeModeCount = count; observedMaxAgeSeconds = age; }
    }
    // Size the TTL to the edge (per-POP) inter-arrival, but NEVER below the current TTL — lowering a
    // TTL only causes MORE MISSes; a longer TTL caches more (at the cost of freshness). So the
    // recommendation is a floor at the current value: it only ever suggests keeping or raising.
    const gapTargetTtl = niceTtl(Math.max(p90PerPopGapSeconds, p90AggGapSeconds));
    const recommendedTtlSeconds = ttlDataSufficient ? Math.max(gapTargetTtl, observedMaxAgeSeconds) : 0;

    // POP rarity
    const baselineUsable = !!baseline && baseline.totalRequests > 0;
    const isRarePop = (pop: string): boolean => {
      if (!hasVal(pop)) return false;
      if (baselineUsable) {
        return ratio(baseline!.popCounts[pop] ?? 0, baseline!.totalRequests) < RARE_POP_BASELINE_SHARE;
      }
      return ratio(this.popTotalAll.get(pop) ?? 0, this.total) < RARE_POP_INWINDOW_SHARE;
    };

    let topPopMiss = 0;
    let rarePopMiss = 0;
    for (const [pop, count] of this.popMissCount) {
      if (count > topPopMiss) topPopMiss = count;
      if (isRarePop(pop)) rarePopMiss += count;
    }
    let botOnRarePopMiss = 0;
    for (const [pop, count] of this.botMissByPop) {
      if (isRarePop(pop)) botOnRarePopMiss += count;
    }

    const topBot = topEntry(this.botCount);
    const topAsnMiss = maxValue(this.asnCount);
    const topCt = topEntry(this.ctCount);

    // Evidence arrays
    const topMissUrls = [...this.urlCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([url, count]) => ({ url, count, pops: this.urlPops.get(url)?.size ?? 0 }));
    const popMissBreakdown = [...this.popMissCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pop, count]) => ({ pop, count, share: ratio(count, missCount), rare: isRarePop(pop) }));
    const topBots = [...this.botCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([bot, count]) => ({ bot, count }));
    const topAsns = [...this.asnCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([asn, count]) => ({ asn, name: this.asnName.get(asn) ?? '', count }));

    return {
      totalRequests: this.total,
      missCount,
      hitCount: this.hitCount,
      otherCount: this.otherCount,
      missRatio: ratio(missCount, missCount + this.hitCount),
      ...this.passPart(),

      error429Count: this.error429Count,
      error429Ratio: ratio(this.error429Count, this.total),
      missWith429Count: this.missWith429Count,
      missShareOf429: ratio(this.missWith429Count, Math.max(this.error429Count, 1)),
      originError5xxCount: this.originError5xxCount,
      cdnDeniedCount: this.cdnDeniedCount,

      distinctMissUrlCount,
      uniqueMissUrlRatio: ratio(distinctMissUrlCount, missCount),
      singleRequestMissUrlCount,
      singleRequestMissUrlShare: ratio(singleRequestMissUrlCount, distinctMissUrlCount),
      repeatedMissUrlCount,
      maxRequestsForSingleMissUrl,

      distinctUrlPopPairs,
      firstFetchPerPopMissCount,
      coldPopFirstFetchShare: ratio(firstFetchPerPopMissCount, missCount),
      repeatSamePopMissCount,
      repeatSamePopShare: ratio(repeatSamePopMissCount, missCount),

      shortTtlMissCount: this.shortTtlMissCount,
      shortTtlMissShare: ratio(this.shortTtlMissCount, missCount),
      staleEligibleMissShare: ratio(this.staleEligibleCount, missCount),
      avgMissTtlSeconds: ratio(this.ttlSum, this.ttlCount),
      refetchWithinTtlCount: this.refetchWithinTtlCount,

      windowSeconds,
      cacheableRequestRatePerMin,
      singleRequestCacheableUrlShare,
      p50AggGapSeconds,
      p90AggGapSeconds,
      p90PerPopGapSeconds,
      observedMaxAgeSeconds,
      recommendedTtlSeconds,
      ttlDataSufficient,

      distinctPopCount: this.popMissCount.size,
      topPopMissShare: ratio(topPopMiss, missCount),
      avgPopsPerRepeatedMissUrl: ratio(popsPerRepeatedSum, repeatedMissUrlCount),
      repeatedUrlMultiPopCount,
      repeatedUrlMultiPopShare: ratio(repeatedUrlMultiPopCount, repeatedMissUrlCount),
      shieldingUsedMissShare: ratio(this.shieldedMissCount, missCount),

      botMissCount: this.botMissCount,
      botMissShare: ratio(this.botMissCount, missCount),
      topBotName: topBot.key,
      topBotMissShare: ratio(topBot.count, missCount),
      distinctClientAsCount: this.asnCount.size,
      topAsnMissShare: ratio(topAsnMiss, missCount),

      rarePopMissShare: ratio(rarePopMiss, missCount),
      botOnRarePopMissShare: ratio(botOnRarePopMiss, missCount),
      baselineUsed: baselineUsable ? 1 : 0,

      ...this.ddosPart(),

      cacheableFalseMissShare: ratio(this.cacheableFalseCount, missCount),
      misspassMissShare: ratio(this.misspassMissCount, missCount),
      missNoPositiveTtlShare: ratio(this.noPositiveTtlMissCount, missCount),
      missNoStoreShare: ratio(this.noStoreMissCount, missCount),
      sampleMissCacheControl: this.sampleMissCacheControl,
      sampleMissSurrogateControl: this.sampleMissSurrogateControl,
      dominantMissContentType: topCt.key,
      dominantMissContentTypeShare: ratio(topCt.count, missCount),

      topMissUrls,
      popMissBreakdown,
      topBots,
      topAsns,
      warnings
    };
  }
}

/**
 * Batch convenience over {@link CdnAggregator}: aggregates an array of events into {@link CdnMetrics}.
 * The streaming fetch path uses the aggregator directly to avoid holding all events in memory.
 */
export function computeCdnMetrics(entries: CdnLogEntry[], baseline?: PopBaseline): CdnMetrics {
  const agg = new CdnAggregator();
  for (const e of entries) agg.add(e);
  return agg.finalize(baseline);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function topEntry(counts: Map<string, number>): { key: string; count: number } {
  let key = '';
  let count = 0;
  for (const [k, c] of counts) {
    if (c > count) { key = k; count = c; }
  }
  return { key, count };
}

function maxValue(counts: Map<string, number>): number {
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max;
}

function emptyMetrics(warnings: string[]): CdnMetrics {
  return {
    totalRequests: 0,
    missCount: 0,
    hitCount: 0,
    passCount: 0,
    otherCount: 0,
    missRatio: 0,
    passWith200Count: 0,
    passWith200Share: 0,
    passNon200Count: 0,
    pass429Count: 0,
    passNon200Non429Count: 0,
    passNon200Non429Share: 0,
    pass200NoHeadersShare: 0,
    pass200PrivateShare: 0,
    passStatusTop: [],
    topPass200Urls: [],
    error429Count: 0,
    error429Ratio: 0,
    missWith429Count: 0,
    missShareOf429: 0,
    originError5xxCount: 0,
    cdnDeniedCount: 0,
    distinctMissUrlCount: 0,
    uniqueMissUrlRatio: 0,
    singleRequestMissUrlCount: 0,
    singleRequestMissUrlShare: 0,
    repeatedMissUrlCount: 0,
    maxRequestsForSingleMissUrl: 0,
    distinctUrlPopPairs: 0,
    firstFetchPerPopMissCount: 0,
    coldPopFirstFetchShare: 0,
    repeatSamePopMissCount: 0,
    repeatSamePopShare: 0,
    shortTtlMissCount: 0,
    shortTtlMissShare: 0,
    staleEligibleMissShare: 0,
    avgMissTtlSeconds: 0,
    refetchWithinTtlCount: 0,
    windowSeconds: 0,
    cacheableRequestRatePerMin: 0,
    singleRequestCacheableUrlShare: 0,
    p50AggGapSeconds: 0,
    p90AggGapSeconds: 0,
    p90PerPopGapSeconds: 0,
    observedMaxAgeSeconds: 0,
    recommendedTtlSeconds: 0,
    ttlDataSufficient: 0,
    distinctPopCount: 0,
    topPopMissShare: 0,
    avgPopsPerRepeatedMissUrl: 0,
    repeatedUrlMultiPopCount: 0,
    repeatedUrlMultiPopShare: 0,
    shieldingUsedMissShare: 0,
    botMissCount: 0,
    botMissShare: 0,
    topBotName: '',
    topBotMissShare: 0,
    distinctClientAsCount: 0,
    topAsnMissShare: 0,
    rarePopMissShare: 0,
    botOnRarePopMissShare: 0,
    baselineUsed: 0,
    cloudAsnRequestShare: 0,
    topAsnRequestShare: 0,
    topAsnRequestName: '',
    peakRequestsPerSec: 0,
    burstRatio: 0,
    cdnThreatShare: 0,
    topSourceAsns: [],
    distinctClientIpCount: 0,
    topClientIpRequestShare: 0,
    topClientIpAddress: '',
    topClientIps: [],
    distinctUserAgentCount: 0,
    topUserAgentRequestShare: 0,
    topUserAgentName: '',
    topUserAgents: [],
    distinctCountryCount: 0,
    topCountryRequestShare: 0,
    topCountryCode: '',
    topCountries: [],
    cacheableFalseMissShare: 0,
    misspassMissShare: 0,
    missNoPositiveTtlShare: 0,
    missNoStoreShare: 0,
    sampleMissCacheControl: '',
    sampleMissSurrogateControl: '',
    dominantMissContentType: '',
    dominantMissContentTypeShare: 0,
    topMissUrls: [],
    popMissBreakdown: [],
    topBots: [],
    topAsns: [],
    warnings
  };
}
