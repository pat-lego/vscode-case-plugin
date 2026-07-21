import { CdnLogEntry, PopBaseline } from '../../src/cdn/types';

/** Builds a typed CDN log entry — a cacheable HTML MISS on POP BMA, status 200, no bot. */
export function makeEntry(o: Partial<CdnLogEntry> = {}): CdnLogEntry {
  return {
    url: '/page',
    cacheStatus: 'MISS',
    fastlyState: 'MISS',
    xCache: 'MISS',
    status: 200,
    originStatus: 200,
    pop: 'BMA',
    region: 'EU-East',
    serverHostname: 'cache-bma-1',
    botName: '',
    userAgent: 'Mozilla/5.0',
    clientIp: '80.239.150.21',
    clientAsNumber: '1299',
    clientAsName: 'arelion sweden ab',
    responseAge: 0,
    responseTtl: 3600,
    isCacheable: true,
    fetchAction: '',
    cacheLocation: 'ORIGIN_FETCH',
    shieldingUsed: false,
    contentType: 'text/html;charset=utf-8',
    fetchSurrogateControl: '',
    fetchCacheControl: '',
    ddosAction: '',
    ddosRule: '',
    maliciousFlags: '',
    denyReason: '',
    geoCountryCode: 'JP',
    aemService: 'cm-p53812-e590634',
    timeStart: undefined,
    raw: {},
    ...o
  };
}

/** A flood of distinct, single-request URLs → unique-URL burst. */
export function uniqueUrlBurstEntries(count = 200): CdnLogEntry[] {
  return Array.from({ length: count }, (_, i) =>
    makeEntry({ url: `/search?q=${i}`, pop: i % 2 === 0 ? 'BMA' : 'FRA' })
  );
}

/** A repeating set of URLs MISSing on the SAME POP with short TTLs → stale content. */
export function staleContentEntries(urls = 30, repeats = 10): CdnLogEntry[] {
  const out: CdnLogEntry[] = [];
  for (let u = 0; u < urls; u++) {
    for (let r = 0; r < repeats; r++) {
      out.push(makeEntry({ url: `/article/${u}`, pop: 'BMA', responseTtl: 30 }));
    }
  }
  return out;
}

/** A repeating set of URLs MISSing across several POPs → POP fragmentation. */
export function popFragmentationEntries(urls = 30, pops = ['BMA', 'FRA', 'LHR', 'AMS']): CdnLogEntry[] {
  const out: CdnLogEntry[] = [];
  for (let u = 0; u < urls; u++) {
    for (const pop of pops) {
      out.push(makeEntry({ url: `/article/${u}`, pop, responseTtl: 3600 }));
    }
  }
  return out;
}

/** Bot traffic from one ASN concentrated on a single cold POP → bot-cold-pop. */
export function botColdPopEntries(urls = 50, repeats = 3, coldPop = 'XYZ'): CdnLogEntry[] {
  const out: CdnLogEntry[] = [];
  for (let u = 0; u < urls; u++) {
    for (let r = 0; r < repeats; r++) {
      out.push(makeEntry({
        url: `/crawl/${u}`,
        pop: coldPop,
        responseTtl: 3600,
        botName: 'Generic Bot',
        clientAsNumber: '1299',
        clientAsName: 'arelion sweden ab'
      }));
    }
  }
  return out;
}

/** A baseline where BMA/FRA are common and the cold POP is essentially unused. */
export function baselineWithColdPop(coldPop = 'XYZ'): PopBaseline {
  return {
    windowDays: 2,
    totalRequests: 200000,
    popCounts: { BMA: 120000, FRA: 79950, [coldPop]: 50 }
  };
}

/** A cloud/hosting-ASN burst of 301s (DDoS-shaped): a spike at t0 plus a trailing tail. */
export function cloudBurstEntries(burst = 200, tail = 20, asn = '20940', name = 'akamai international b.v.'): CdnLogEntry[] {
  const t0 = Date.parse('2026-07-16T03:25:00Z');
  const out: CdnLogEntry[] = [];
  for (let i = 0; i < burst; i++) {
    out.push(makeEntry({ url: `/apac/x${i % 20}`, cacheStatus: 'PASS', status: 301, clientAsNumber: asn, clientAsName: name, timeStart: new Date(t0) }));
  }
  for (let i = 0; i < tail; i++) {
    out.push(makeEntry({ url: `/apac/y${i}`, cacheStatus: 'PASS', status: 301, clientAsNumber: asn, clientAsName: name, timeStart: new Date(t0 + (i + 1) * 10000) }));
  }
  return out;
}

/**
 * A burst from a single client IP + user agent on an eyeball ISP (no cloud ASN) — exercises the
 * IP/UA corroborating DDoS signal for traffic the ASN-based signal alone would miss.
 */
export function singleIpBurstEntries(burst = 200, tail = 20, ip = '203.0.113.7', ua = 'curl/8.0'): CdnLogEntry[] {
  const t0 = Date.parse('2026-07-16T03:25:00Z');
  const out: CdnLogEntry[] = [];
  for (let i = 0; i < burst; i++) {
    out.push(makeEntry({
      url: `/checkout?x=${i % 20}`, cacheStatus: 'PASS', status: 429,
      clientIp: ip, userAgent: ua, clientAsName: 'comcast cable', clientAsNumber: '7922', timeStart: new Date(t0)
    }));
  }
  for (let i = 0; i < tail; i++) {
    out.push(makeEntry({
      url: `/checkout?y=${i}`, cacheStatus: 'PASS', status: 429,
      clientIp: ip, userAgent: ua, clientAsName: 'comcast cable', clientAsNumber: '7922', timeStart: new Date(t0 + (i + 1) * 10000)
    }));
  }
  return out;
}

/**
 * A genuine burst (same spike+tail shape as {@link cloudBurstEntries}) spread across many distinct
 * client IPs/user agents/countries — no single-source concentration signal should fire on this.
 */
export function diverseSourceBurstEntries(burst = 200, tail = 20): CdnLogEntry[] {
  const t0 = Date.parse('2026-07-16T03:25:00Z');
  const countries = ['US', 'GB', 'DE', 'FR', 'JP', 'BR', 'IN', 'AU'];
  const out: CdnLogEntry[] = [];
  for (let i = 0; i < burst; i++) {
    out.push(makeEntry({
      url: `/sale?x=${i % 20}`, clientIp: `203.0.113.${i % 200}`, userAgent: `Mozilla/5.0 (build ${i % 50})`,
      geoCountryCode: countries[i % countries.length], clientAsName: 'comcast cable', clientAsNumber: '7922', timeStart: new Date(t0)
    }));
  }
  for (let i = 0; i < tail; i++) {
    out.push(makeEntry({
      url: `/sale?y=${i}`, clientIp: `203.0.113.${200 + i}`, userAgent: `Mozilla/5.0 (build ${50 + i})`,
      geoCountryCode: countries[i % countries.length], clientAsName: 'comcast cable', clientAsNumber: '7922', timeStart: new Date(t0 + (i + 1) * 10000)
    }));
  }
  return out;
}

/** Maps a typed entry to a raw Splunk key/value record (for parser/analyzer round-trips). */
export function toRaw(e: Partial<CdnLogEntry>): Record<string, string> {
  const m = makeEntry(e);
  return {
    url: m.url,
    cache_status: m.cacheStatus,
    fastly_info_state: m.fastlyState,
    response_x_cache: m.xCache,
    status: String(m.status),
    origin_status: String(m.originStatus),
    server_datacenter: m.pop,
    server_region: m.region,
    server_hostname: m.serverHostname,
    bot_name: m.botName,
    request_user_agent: m.userAgent,
    client_ip: m.clientIp,
    client_as_number: m.clientAsNumber,
    client_as_name: m.clientAsName,
    response_age: String(m.responseAge),
    response_ttl: String(m.responseTtl),
    is_cacheable: String(m.isCacheable),
    fetch_action: m.fetchAction,
    cache_location: m.cacheLocation,
    shielding_used: String(m.shieldingUsed),
    content_type: m.contentType,
    fetch_surrogate_control: m.fetchSurrogateControl,
    fetch_cache_control: m.fetchCacheControl,
    ddos_action: m.ddosAction,
    ddos_rule: m.ddosRule,
    malicious_flags: m.maliciousFlags,
    deny_reason: m.denyReason,
    geo_country_code: m.geoCountryCode,
    aem_service: m.aemService
  };
}
