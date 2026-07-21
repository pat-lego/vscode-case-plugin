import { Finding } from '../types/finding';
import { CnameResolver } from './upstream-cdn';

/**
 * CDN cache-miss analysis module.
 *
 * Given an AEM service, a time window, and (optionally) a set of URLs, this module fetches
 * Fastly/Skyline CDN access logs from Splunk (`sky splunk query`), aggregates them into a
 * flat scalar summary (mirroring the thread-dump `ThreadDumpSummary` philosophy), and runs a
 * ranked classifier to determine WHY a burst of cache MISSes occurred:
 *
 *   1. unique-url-burst   — a flood of distinct / uncacheable URLs (naturally uncacheable)
 *   2. stale-content      — the same URLs re-fetched after TTL expiry / short TTLs
 *   3. pop-fragmentation  — the same URLs MISSing across many POPs (each POP cold)
 *   4. bot-cold-pop       — a bot burst hitting rarely-used POPs with cold caches
 *
 * The MISS storm is correlated with HTTP 429s (the symptom). Per the analysis rule, cache
 * PASS entries are excluded from the MISS analysis unless the PASS returned status 200.
 */

// ── Inputs ────────────────────────────────────────────────────────────────────

/** The user-provided analysis request. */
export interface CdnAnalysisInput {
  /** AEM service id, matched against the `aem_service` field, e.g. "cm-p53812-e590634". */
  service: string;
  /**
   * Splunk `earliest` for the incident window. Accepts ISO-8601 (e.g. "2026-07-16T03:30:00Z")
   * or a Splunk relative modifier (e.g. "-60m@m", "-2h").
   */
  from: string;
  /** Splunk `latest` for the incident window. Same accepted formats as {@link from}. */
  to: string;
  /**
   * URLs to scope the analysis to. Each value is matched against the `url` field; Splunk `*`
   * wildcards are supported (e.g. "/apac/*"). Empty / omitted analyses all URLs for the service.
   */
  urls?: string[];
  /** AEM tier to scope to (`aem_tier`). Defaults to "publish". */
  tier?: 'author' | 'publish';
}

/** A callback that runs one SPL query and returns raw stdout. Injectable for testing. */
export type SplunkRunner = (spl: string) => Promise<string>;

/** Options controlling how CDN logs are fetched and analysed. */
export interface CdnFetchOptions {
  /** Splunk index the CDN logs live in. Required to build a working query. */
  index: string;
  /** Splunk sourcetype for the CDN logs. Optional — omitted from the query when empty. */
  sourcetype?: string;
  /** Path to the `sky` binary. Defaults to "sky" (resolved on PATH). */
  skyPath?: string;
  /** Row cap applied to the incident query (`| head N`). Defaults to 100000. */
  maxEvents?: number;
  /** execFile timeout in milliseconds. Defaults to 300000 (5 min) — CDN queries are slow. */
  timeoutMs?: number;
  /** execFile maxBuffer in bytes. Defaults to 256 MiB. */
  maxBufferBytes?: number;
  /** Whether to fetch a POP-usage baseline for the bot/rare-POP hypothesis. Defaults to true. */
  baseline?: boolean;
  /** Baseline look-back in days, ending at the incident start. Clamped to a maximum of 2. */
  baselineDays?: number;
  /** Injectable query runner. When provided, the default `sky splunk query` runner is bypassed. */
  runner?: SplunkRunner;
  /** If set, the streaming fetch writes the raw incident response (NDJSON) to this file for later offline replay. */
  saveRawPath?: string;
  /**
   * Injectable CNAME resolver for the origin's-own-CDN DNS cross-check (see `resolveUpstreamCdn`).
   * Defaults to `dns.promises.resolveCname`. Inject a fake in tests to avoid a real DNS lookup.
   */
  resolveCname?: CnameResolver;
}

// ── Parsed log entry ────────────────────────────────────────────────────────────

/**
 * A normalised CDN log event — the subset of the ~100 raw Fastly/Skyline fields this module
 * reasons over. The original untyped record is preserved on {@link raw} for evidence building.
 */
export interface CdnLogEntry {
  /** Requested path, e.g. "/apac/galaxy/zh_tw/?page=3". */
  url: string;
  /** Edge cache disposition from `cache_status` (HIT | MISS | PASS | ERROR | ...), upper-cased. */
  cacheStatus: string;
  /** Corroborating edge state from `fastly_info_state`. */
  fastlyState: string;
  /** The `response_x_cache` header value (often "MISS" even on a PASS — not authoritative). */
  xCache: string;
  /** Final HTTP status returned to the client (`status`). */
  status: number;
  /** Origin HTTP status (`origin_status`). */
  originStatus: number;
  /** POP / datacenter that served the request (`server_datacenter`, e.g. "BMA"). */
  pop: string;
  /** Server region (`server_region`). */
  region: string;
  /** Cache node hostname (`server_hostname`). */
  serverHostname: string;
  /** Classified bot name (`bot_name`); empty / "-" / "none" when not a known bot. */
  botName: string;
  /** Client user agent (`request_user_agent`). */
  userAgent: string;
  /** Client IP (`client_ip`). */
  clientIp: string;
  /** Autonomous system number of the client network (`client_as_number`), kept as a string. */
  clientAsNumber: string;
  /** Autonomous system name of the client network (`client_as_name`). */
  clientAsName: string;
  /** Age of the served cached object in seconds (`response_age`); 0 on a fresh fetch. */
  responseAge: number;
  /** TTL applied to the response in seconds (`response_ttl`). */
  responseTtl: number;
  /**
   * The `is_cacheable` edge field. UNRELIABLE — the CDN logs it as `fastly_info.state ~ "^(HIT|MISS)$"`
   * (exact match), so normal clustered states (HIT-CLUSTER, MISS-CLUSTER) read `false` even for
   * cacheable, cached content. It is a Fastly clustering artifact, NOT a cacheability signal; the
   * analysis ignores it. Cacheability is decided from Cache-Control / Surrogate-Control + fetch_action.
   */
  isCacheable: boolean;
  /** Origin-fetch action (`fetch_action`) — e.g. pass_private / pass_s_private / pass_noheaders. */
  fetchAction: string;
  /** Where the object was sourced (`cache_location`, e.g. "ORIGIN_FETCH"). */
  cacheLocation: string;
  /** Whether origin shielding was used (`shielding_used`) — a shield collapses multi-POP MISSes. */
  shieldingUsed: boolean;
  /** Response content type (`content_type`). */
  contentType: string;
  /** Surrogate-control returned by origin (`fetch_surrogate_control`) — stale-while-revalidate etc. */
  fetchSurrogateControl: string;
  /** Cache-Control returned by origin (`fetch_cache_control`) — drives CDN cacheability. */
  fetchCacheControl: string;
  /** DDoS mitigation action, if any (`ddos_action`). */
  ddosAction: string;
  /** DDoS rule that matched, if any (`ddos_rule`). */
  ddosRule: string;
  /** Malicious-traffic flags set by the CDN (`malicious_flags`). */
  maliciousFlags: string;
  /** Deny reason, if the request was blocked / rate-limited (`deny_reason`). */
  denyReason: string;
  /** Client geo country code (`geo_country_code`). */
  geoCountryCode: string;
  /** AEM service id (`aem_service`). */
  aemService: string;
  /**
   * The origin hostname this request was ultimately for (`origin_host`), e.g. "www.macnica.com".
   * Used to cross-reference a flagged "cloud/hosting ASN" against the site's OWN CDN (via DNS) —
   * see {@link resolveUpstreamCdn} — before treating that ASN as a DDoS signal.
   */
  originHost: string;
  /**
   * The `X-Forwarded-For` chain as originally received (`original_x_forwarded_for`), e.g.
   * "135.132.91.21, 23.52.12.49" — real end-user IP(s) followed by the forwarding CDN's own edge
   * IP. Proves a request attributed to a CDN's ASN is that CDN forwarding a real visitor, not the
   * visitor itself, when the last hop matches {@link clientIp}.
   */
  originalXForwardedFor: string;
  /**
   * The HTTP `Via` header as received (nested under `xdata.request_via` in this feed's raw JSON),
   * e.g. "1.1 akamai.net(ghost) (AkamaiGHost)" — names the forwarding CDN's own software,
   * corroborating {@link originalXForwardedFor}.
   */
  requestVia: string;
  /** Request start time (`time_start`), when parseable. */
  timeStart?: Date;
  /** The original untyped key/value record, for evidence and debugging. */
  raw: Record<string, string>;
}

/** Normal POP-usage snapshot from a baseline query (`| stats count by server_datacenter`). */
export interface PopBaseline {
  /** Look-back window used, in days. */
  windowDays: number;
  /** Total requests observed across all POPs in the baseline window. */
  totalRequests: number;
  /** Request count per POP (`server_datacenter` -> count) over the baseline window. */
  popCounts: Record<string, number>;
}

// ── Metrics (flat scalar summary) ───────────────────────────────────────────────

/**
 * A concrete example proving an ASN's traffic is a CDN forwarding a real visitor, not the visitor
 * itself — found when an entry's {@link CdnLogEntry.originalXForwardedFor} chain has more than one
 * hop and the last one matches {@link CdnLogEntry.clientIp} (i.e. this ASN's own edge is the most
 * recent hop, with a real client IP ahead of it).
 */
export interface AsnForwardedSample {
  /** The real end-user IP found ahead of this ASN's own edge IP in the X-Forwarded-For chain. */
  realClientIp: string;
  /** The HTTP Via header value naming the forwarding software (e.g. "1.1 akamai.net(ghost) (AkamaiGHost)"), when present. */
  via: string;
}

/**
 * Aggregated CDN metrics. Scalar fields are the signals the classifier thresholds against;
 * plural array fields hold examples for evidence rendering only. All ratios are 0.0–1.0.
 */
export interface CdnMetrics {
  // ── Volume ──────────────────────────────────────────────────────────────────
  /** Total log events analysed. */
  totalRequests: number;
  /** Events whose edge disposition is MISS. */
  missCount: number;
  /** Events whose edge disposition is HIT. */
  hitCount: number;
  /** Events whose edge disposition is PASS (uncacheable / bypassed cache). */
  passCount: number;
  /** Events with any other disposition (ERROR, unknown, …). */
  otherCount: number;
  /** missCount / (missCount + hitCount) — PASS is excluded from the denominator. */
  missRatio: number;
  /** PASS events that returned status 200 — a cacheable status that bypassed cache (anomaly). */
  passWith200Count: number;
  /** passWith200Count / passCount. */
  passWith200Share: number;
  /** PASS events that returned a non-200 status. */
  passNon200Count: number;
  /** PASS events that returned 429 (origin-stress symptom, not a PASS problem to flag). */
  pass429Count: number;
  /** PASS events with a non-200, non-429 status (uncacheable-by-status: 5xx / 3xx / 4xx). */
  passNon200Non429Count: number;
  /** passNon200Non429Count / passCount. */
  passNon200Non429Share: number;
  /** Of PASS+200, the share bypassed because origin sent no cache headers (`fetch_action=pass_noheaders`). */
  pass200NoHeadersShare: number;
  /** Of PASS+200, the share bypassed because origin sent private/no-store (`fetch_action=pass_[s_]private`). */
  pass200PrivateShare: number;
  /** Top HTTP statuses among PASS events (evidence). */
  passStatusTop: Array<{ status: number; count: number }>;
  /** Top URLs among PASS+200 events (evidence). */
  topPass200Urls: Array<{ url: string; count: number }>;

  // ── Errors / rate limiting ────────────────────────────────────────────────────
  /** Events where the client (`status`) or origin (`origin_status`) status was 429. */
  error429Count: number;
  /** error429Count / totalRequests. */
  error429Ratio: number;
  /** MISS events that returned 429 — the core "MISS storm → rate limit" correlation. */
  missWith429Count: number;
  /** MISS-relative share of 429s: missWith429Count / max(error429Count, 1). */
  missShareOf429: number;
  /** Events where the origin returned a 5xx (origin overload symptom). */
  originError5xxCount: number;
  /** Events explicitly rate-limited / denied at the CDN (`ddos_action`/`deny_reason` set). */
  cdnDeniedCount: number;

  // ── URL cardinality (over the MISS set) ───────────────────────────────────────
  /** Distinct URLs among MISS events. */
  distinctMissUrlCount: number;
  /** distinctMissUrlCount / missCount — approaches 1.0 when every MISS is a unique URL. */
  uniqueMissUrlRatio: number;
  /** MISS URLs requested exactly once. */
  singleRequestMissUrlCount: number;
  /** singleRequestMissUrlCount / distinctMissUrlCount. */
  singleRequestMissUrlShare: number;
  /** MISS URLs requested more than once (should have HIT after the first fetch if cacheable). */
  repeatedMissUrlCount: number;
  /** Highest MISS count for any single URL. */
  maxRequestsForSingleMissUrl: number;

  // ── Why each MISS happened (per URL+POP) ──────────────────────────────────────
  /** Distinct (URL, POP) pairs among MISSes. */
  distinctUrlPopPairs: number;
  /** MISSes that were the first fetch of that URL at that POP — cold cache, object not yet at the edge. */
  firstFetchPerPopMissCount: number;
  /** firstFetchPerPopMissCount / missCount — share of MISSes explained by a cold POP (expected). */
  coldPopFirstFetchShare: number;
  /** MISSes for a URL already fetched at the SAME POP earlier — should have HIT (not staying cached). */
  repeatSamePopMissCount: number;
  /** repeatSamePopMissCount / missCount — the genuinely suspicious share. */
  repeatSamePopShare: number;
  /**
   * Peak-vs-mean concentration of "first fetch of this URL at this POP" timestamps — the same
   * technique as the DDoS burst ratio, applied to cold-POP fetches. High (spiky) means the cold
   * fetches cluster in a narrow time band: the signature of a synchronized invalidation (a
   * deploy, a dispatcher/CDN purge), not organic per-POP traffic diversity. ~1 (flat) means they
   * are spread through the window, consistent with genuinely diverse cold POPs — though a short
   * window can also produce a flat-but-still-high coldPopFirstFetchShare simply because there
   * wasn't enough time to observe repeats; re-run over a longer window to tell those apart. 0 when
   * there is no timed cold-fetch data.
   */
  coldFetchBurstRatio: number;

  // ── Staleness / TTL ───────────────────────────────────────────────────────────
  /** MISS events whose responseTtl is > 0 but below the short-TTL threshold. */
  shortTtlMissCount: number;
  /** shortTtlMissCount / missCount. */
  shortTtlMissShare: number;
  /** MISS events configured with stale-while-revalidate / stale-if-error surrogate control. */
  staleEligibleMissShare: number;
  /** Average responseTtl (seconds) across MISS events with a positive TTL. */
  avgMissTtlSeconds: number;
  /** Consecutive MISSes of the same URL on the same POP re-fetched within the TTL window. */
  refetchWithinTtlCount: number;

  // ── TTL / request-rate sizing (over cacheable HIT+MISS with timestamps) ───────────
  /** Observed window duration in seconds (max−min time_start across cacheable requests). */
  windowSeconds: number;
  /** Cacheable (HIT+MISS) request rate per minute over the window. */
  cacheableRequestRatePerMin: number;
  /** Share of cacheable URLs requested only once in the window (cannot be TTL-sized from it). */
  singleRequestCacheableUrlShare: number;
  /** Median inter-arrival (seconds) between requests to the same URL, aggregate across POPs (shield view). */
  p50AggGapSeconds: number;
  /** P90 aggregate inter-arrival (seconds) — the gap a shield TTL must cover to serve ~90% of repeats. */
  p90AggGapSeconds: number;
  /** P90 per-(URL,POP) inter-arrival (seconds) — the gap an edge-only TTL (no shield) would need to cover. */
  p90PerPopGapSeconds: number;
  /** Observed origin max-age/s-maxage on cacheable MISSes (current TTL), 0 if none seen. */
  observedMaxAgeSeconds: number;
  /** Recommended TTL (seconds) so the shield serves ~90% of repeat requests before expiry; 0 if insufficient data. */
  recommendedTtlSeconds: number;
  /** Observed origin stale-while-revalidate on cacheable MISSes, 0 if none seen. */
  observedSwrSeconds: number;
  /**
   * Recommended stale-while-revalidate (seconds), sized to the PER-POP gap — unlike `recommendedTtlSeconds`
   * this works at the edge WITHOUT a shield: once a POP has a copy, it can serve it stale (and
   * revalidate in the background) instead of blocking on origin the next time it goes stale.
   * 0 if insufficient data.
   */
  recommendedSwrSeconds: number;
  /** 1 if there were enough repeat-request timestamps to make a TTL recommendation, else 0. */
  ttlDataSufficient: number;

  // ── POP fragmentation ─────────────────────────────────────────────────────────
  /** Distinct POPs serving MISS traffic. */
  distinctPopCount: number;
  /** Busiest POP's share of MISS traffic. */
  topPopMissShare: number;
  /** For repeated MISS URLs, the average number of distinct POPs each was MISSed on. */
  avgPopsPerRepeatedMissUrl: number;
  /** Repeated MISS URLs that MISSed on more than one POP. */
  repeatedUrlMultiPopCount: number;
  /** repeatedUrlMultiPopCount / repeatedMissUrlCount. */
  repeatedUrlMultiPopShare: number;
  /** MISS share where origin shielding was used; a low value means cold POPs fetch origin directly. */
  shieldingUsedMissShare: number;

  // ── Bots / source concentration ───────────────────────────────────────────────
  /** MISS events attributed to a classified bot. */
  botMissCount: number;
  /** botMissCount / missCount. */
  botMissShare: number;
  /** Most active bot on MISS traffic. */
  topBotName: string;
  /** Top bot's share of MISS traffic. */
  topBotMissShare: number;
  /** Distinct client ASNs among MISS traffic. */
  distinctClientAsCount: number;
  /** Busiest ASN's share of MISS traffic. */
  topAsnMissShare: number;

  // ── DDoS / traffic-source signals (over all requests) ─────────────────────────
  /** Share of ALL requests originating from cloud/hosting ASNs (not eyeball ISPs). */
  cloudAsnRequestShare: number;
  /** Busiest ASN's share of ALL requests. */
  topAsnRequestShare: number;
  /** Name of the busiest source ASN. */
  topAsnRequestName: string;
  /** Peak requests/second observed in any 1-second bucket (burst detection). */
  peakRequestsPerSec: number;
  /** peakRequestsPerSec / mean requests/second — how spiky the traffic is. */
  burstRatio: number;
  /** Share of requests the CDN already flagged (ddos_action / ddos_rule / malicious_flags / deny_reason). */
  cdnThreatShare: number;
  /** Top source ASNs by request volume (evidence), with a cloud/hosting flag. */
  topSourceAsns: Array<{ asn: string; name: string; count: number; cloud: boolean; forwardedSample?: AsnForwardedSample }>;
  /** Most common non-blank `origin_host` seen — the hostname DNS-cross-referenced for a known upstream CDN. */
  topOriginHost: string;
  /** Distinct client IPs among ALL requests. */
  distinctClientIpCount: number;
  /** Busiest single client IP's share of ALL requests — corroborates a DDoS/scripted-traffic burst. */
  topClientIpRequestShare: number;
  /** The busiest client IP address (evidence). */
  topClientIpAddress: string;
  /** Top client IPs by request volume (evidence). */
  topClientIps: Array<{ ip: string; count: number }>;
  /** Distinct user agents among ALL requests. */
  distinctUserAgentCount: number;
  /** Busiest single user agent's share of ALL requests — a dominant UA can indicate scripted traffic. */
  topUserAgentRequestShare: number;
  /** The busiest user agent string (evidence). */
  topUserAgentName: string;
  /** Top user agents by request volume (evidence). */
  topUserAgents: Array<{ userAgent: string; count: number }>;
  /** Distinct client countries (`geo_country_code`) among ALL requests. */
  distinctCountryCount: number;
  /** Busiest single country's share of ALL requests — corroborates a regional bot/attack source. */
  topCountryRequestShare: number;
  /** The busiest client country code (evidence). */
  topCountryCode: string;
  /** Top client countries by request volume (evidence). */
  topCountries: Array<{ country: string; count: number }>;

  // ── Rare-POP concentration (bot-cold-pop hypothesis) ──────────────────────────
  /** MISS share hitting POPs deemed "rare" (via baseline if available, else in-window). */
  rarePopMissShare: number;
  /** MISS share from bots hitting rare POPs. */
  botOnRarePopMissShare: number;
  /** 1 if a historical baseline defined rarity, 0 if the in-window heuristic was used. */
  baselineUsed: number;

  // ── Cacheability ──────────────────────────────────────────────────────────────
  /**
   * MISS share where `is_cacheable`=false. NOTE: unreliable — this is really the clustered-MISS
   * share (MISS-CLUSTER/MISS-WAIT), not uncacheability. Retained for reference; not used to classify.
   */
  cacheableFalseMissShare: number;
  /** MISS share that was fetched then passed (`fetch_action` starts with "pass" — misspass, not stored). */
  misspassMissShare: number;
  /** MISS share whose origin Cache-Control/Surrogate-Control has no positive max-age/s-maxage. */
  missNoPositiveTtlShare: number;
  /** MISS share whose origin sent no-store / no-cache / private / max-age=0. */
  missNoStoreShare: number;
  /** A representative origin Cache-Control seen on a non-cacheable MISS (for evidence). */
  sampleMissCacheControl: string;
  /** A representative origin Surrogate-Control seen on a non-cacheable MISS (for evidence). */
  sampleMissSurrogateControl: string;
  /** Most common content type among MISS events. */
  dominantMissContentType: string;
  /** dominant content type's share of MISS traffic. */
  dominantMissContentTypeShare: number;

  // ── Evidence arrays (NOT for thresholds) ──────────────────────────────────────
  topMissUrls: Array<{ url: string; count: number; pops: number }>;
  popMissBreakdown: Array<{ pop: string; count: number; share: number; rare: boolean }>;
  topBots: Array<{ bot: string; count: number }>;
  topAsns: Array<{ asn: string; name: string; count: number; forwardedSample?: AsnForwardedSample }>;
  /** Non-fatal issues encountered while fetching / computing (missing fields, baseline failure). */
  warnings: string[];
}

// ── Report ──────────────────────────────────────────────────────────────────────

/** The full result of a CDN cache-miss analysis. */
export interface CdnAnalysisReport {
  /** Echo of the request that produced this report. */
  input: CdnAnalysisInput;
  /** Number of log events analysed. */
  entryCount: number;
  /** The aggregated metrics. */
  metrics: CdnMetrics;
  /** Ranked root-cause hypotheses (highest confidence first), plus a trailing 429-context finding. */
  findings: Finding[];
  /** Id of the top-ranked root-cause hypothesis, if any. */
  verdictId?: string;
  /** Name of the top-ranked root-cause hypothesis, if any. */
  verdictName?: string;
  /** A short human-readable headline of the finding and key numbers. */
  summary: string;
  /** The exact `sky splunk query '...'` commands run to produce this report (empty for offline replay). */
  splunkQueries: string[];
  /** Whether a historical POP baseline informed the rare-POP signals. */
  baselineUsed: boolean;
  /** When the report was generated. */
  generatedAt: Date;
}
