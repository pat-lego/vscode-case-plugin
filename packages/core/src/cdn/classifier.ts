import { Finding, MatchedCondition, UnmatchedCondition } from '../types/finding';
import { CdnMetrics } from './types';
import { UpstreamCdnMatch, nameMatchesProvider } from './upstream-cdn';

/**
 * Classifies WHY a burst of cache MISSes occurred, as a set of ranked, `Finding`-shaped
 * hypotheses (reusing the same output type the thread-dump engine produces so the UI renders
 * them identically). Confidence is the fraction of a hypothesis's conditions that hold, matching
 * the signature matcher: >= 0.8 high, >= 0.5 medium, else low.
 */

type Condition = {
  field: string;
  description: string;
  test: (m: CdnMetrics) => boolean;
  observed: (m: CdnMetrics) => string | number;
  /**
   * Informational conditions surface a value in "Signals matched" (when `test` is true) without
   * counting toward the confidence score — for diagnostics that are useful context but aren't
   * themselves evidence for or against this hypothesis (e.g. a burst-clustering ratio).
   */
  informational?: boolean;
};

type Hypothesis = {
  id: string;
  name: string;
  conditions: Condition[];
  evidence: (m: CdnMetrics, upstreamCdn?: UpstreamCdnMatch | null) => string[];
  nextSteps: string[];
  related: string[];
};

/**
 * Formats a 0–1 ratio as a percentage. Plain nearest-integer rounding would show "100%"/"0%" for
 * values merely close to those boundaries (e.g. 0.9995584... -> "100%"), which reads as an
 * impossible claim of certainty. Show two decimal places instead whenever rounding would land
 * exactly on a boundary that the raw value did not actually reach.
 */
const pct = (x: number): string => {
  const p = x * 100;
  const rounded = Math.round(p);
  if ((rounded === 100 && p < 100) || (rounded === 0 && p > 0)) return `${p.toFixed(2)}%`;
  return `${rounded}%`;
};

/**
 * Explains WHY an ASN dominating traffic/MISS counts is not necessarily a bot or attacker, using
 * whichever evidence is actually available: a DNS-confirmed match to the origin's own upstream
 * CDN (see {@link resolveUpstreamCdn}), a concrete forwarded-request example (a real end-user IP
 * behind this ASN's own edge, from `X-Forwarded-For`/`Via`), or both together for the strongest
 * case. Returns null when neither signal is present — an ASN with no such evidence is left as a
 * plain, un-annotated number, exactly as before.
 */
function describeVerifiedForwarder(
  asn: { asn: string; name: string; forwardedSample?: { realClientIp: string; via: string } },
  upstreamCdn?: UpstreamCdnMatch | null
): string | null {
  const dnsMatch = upstreamCdn && nameMatchesProvider(asn.name, upstreamCdn.provider) ? upstreamCdn : null;
  const sample = asn.forwardedSample;
  if (!dnsMatch && !sample) return null;

  const proof: string[] = [];
  if (dnsMatch) proof.push(`DNS confirms this origin is fronted by ${dnsMatch.provider} (${dnsMatch.hostname} → ${dnsMatch.chain.join(' → ')})`);
  if (sample) {
    proof.push(
      `its own request headers show a real end-user IP (${sample.realClientIp}) behind this edge` +
      (sample.via ? ` (Via: ${sample.via})` : '')
    );
  }
  return `AS${asn.asn} ${asn.name} looks like this origin's own CDN forwarding real visitor traffic, not a bot or attack source — ${proof.join('; ')}.`;
}

/** Formats a duration in seconds as a compact human string (s / m / h / d). */
function fmtDur(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
  return `${Math.round(seconds / 86400)}d`;
}
const scoreFor = (c: 'high' | 'medium' | 'low') => (c === 'high' ? 0.9 : c === 'medium' ? 0.6 : 0.3);

/** One-line breakdown of WHY the MISSes happened, shared across findings. */
function missReasonSummary(m: CdnMetrics): string {
  const base = `Why these MISS: ${pct(m.coldPopFirstFetchShare)} first fetch at that POP (cold cache — object was never there), ` +
    `${pct(m.repeatSamePopShare)} re-fetch at a POP that already had it (should have HIT).`;
  const notCacheable = Math.max(m.missNoPositiveTtlShare, m.missNoStoreShare);
  return notCacheable >= 0.3
    ? `${base} Also ${pct(notCacheable)} not cacheable by directive (no max-age / no-store).`
    : base;
}

/** Explains a single top-URL row: cold-per-POP vs same-POP repeats. */
function urlReason(u: { url: string; count: number; pops: number }): string {
  const repeats = u.count - u.pops;
  if (u.pops <= 1) {
    return u.count > 1
      ? `${u.count}× on 1 POP (${u.count - 1} repeat${u.count - 1 === 1 ? '' : 's'} at the same edge — not staying cached)`
      : `${u.count}× on 1 POP (first fetch)`;
  }
  if (repeats <= 0) {
    return `${u.count}× across ${u.pops} POPs (one first fetch per POP — cold cache at each edge)`;
  }
  return `${u.count}× across ${u.pops} POPs (${repeats} same-edge repeat${repeats === 1 ? '' : 's'} — partly not cached)`;
}

const HYPOTHESES: Hypothesis[] = [
  {
    id: 'cdn-uncacheable',
    name: 'Responses are not cacheable (no cache lifetime)',
    conditions: [
      {
        field: 'missNoPositiveTtlShare',
        description: 'Most MISS responses have no positive max-age/s-maxage (Cache-Control/Surrogate-Control) — no fresh lifetime to store',
        test: m => m.missNoPositiveTtlShare >= 0.7,
        observed: m => pct(m.missNoPositiveTtlShare)
      },
      {
        field: 'missNoStoreShare',
        description: 'Origin sent no-store / no-cache / private (or max-age=0) on these responses',
        test: m => m.missNoStoreShare >= 0.5,
        observed: m => pct(m.missNoStoreShare)
      }
    ],
    evidence: m => [
      missReasonSummary(m),
      m.missNoStoreShare >= 0.5
        ? `${pct(m.missNoStoreShare)} of MISS responses carry an explicit no-store / no-cache / private (or max-age=0) directive from origin`
        : `${pct(m.missNoPositiveTtlShare)} of MISS responses have no positive max-age / s-maxage — no fresh lifetime, so the CDN will not store them`,
      (m.sampleMissCacheControl || m.sampleMissSurrogateControl)
        ? `Observed origin directives — Cache-Control: "${m.sampleMissCacheControl || '(none)'}", Surrogate-Control: "${m.sampleMissSurrogateControl || '(none)'}"`
        : 'Origin sent no Cache-Control / Surrogate-Control on these responses',
      m.misspassMissShare > 0 ? `${pct(m.misspassMissShare)} were fetched then passed (misspass — origin fetch, not stored)` : '(is_cacheable is ignored — it reads false for clustered states and is not a cacheability signal)',
      `Dominant MISS content type: ${m.dominantMissContentType || 'unknown'} (${pct(m.dominantMissContentTypeShare)})`,
      'Top MISSed URLs (why):',
      ...m.topMissUrls.slice(0, 6).map(u => `  ${urlReason(u)} — ${u.url}`)
    ],
    nextSteps: [
      'The fix is at the AEM publish origin, which drives CDN caching via Cache-Control / Surrogate-Control on the response.',
      'Give these pages a positive lifetime — Cache-Control: max-age=… or Surrogate-Control: max-age=…; stale-while-revalidate / stale-if-error with no max-age is NOT cacheable.',
      'Remove any no-store / no-cache / private / max-age=0 emitted for these paths (check the page cache headers and dispatcher/CDN caching rules).',
      'Until the responses carry a cacheable TTL, origin shielding and POP/TTL tuning will NOT reduce these MISSes.'
    ],
    related: ['cdn-pop-fragmentation', 'cdn-stale-content']
  },
  {
    id: 'cdn-unique-url-burst',
    name: 'Burst of unique / uncacheable URLs',
    conditions: [
      {
        field: 'uniqueMissUrlRatio',
        description: 'Most MISSes are for distinct URLs (unique-URL ratio ≥ 80%)',
        test: m => m.uniqueMissUrlRatio >= 0.8,
        observed: m => pct(m.uniqueMissUrlRatio)
      },
      {
        field: 'singleRequestMissUrlShare',
        description: 'Most MISSed URLs were requested only once (≥ 70%)',
        test: m => m.singleRequestMissUrlShare >= 0.7,
        observed: m => pct(m.singleRequestMissUrlShare)
      },
      {
        field: 'distinctMissUrlCount',
        description: 'High distinct-URL cardinality (≥ 50 unique MISS URLs)',
        test: m => m.distinctMissUrlCount >= 50,
        observed: m => m.distinctMissUrlCount
      }
    ],
    evidence: m => [
      `${m.distinctMissUrlCount} distinct URLs across ${m.missCount} MISSes (${pct(m.uniqueMissUrlRatio)} unique)`,
      `${m.singleRequestMissUrlCount} URLs requested exactly once (${pct(m.singleRequestMissUrlShare)} of distinct URLs)`,
      `Dominant MISS content type: ${m.dominantMissContentType || 'unknown'} (${pct(m.dominantMissContentTypeShare)})`,
      ...m.topMissUrls.slice(0, 5).map(u => `  ${urlReason(u)} — ${u.url}`)
    ],
    nextSteps: [
      'Confirm whether these URLs are inherently unique (query-string variants, personalisation, search) — such traffic cannot be cached and the MISSes are expected.',
      'If the URLs SHOULD be cacheable, check for cache-busting query parameters and normalise/strip them at the CDN.',
      'Consider a surrogate key / vary strategy so distinct-looking URLs share a cache object.',
      'If this is scraping of a large URL space, evaluate rate limiting the source rather than expanding cache.'
    ],
    related: ['cdn-bot-cold-pop']
  },
  {
    id: 'cdn-stale-content',
    name: 'Content not staying cached (same-POP re-fetches)',
    conditions: [
      {
        field: 'repeatSamePopMissCount',
        description: 'A URL is re-fetched at a POP that already fetched it — it should have HIT (≥ 10)',
        test: m => m.repeatSamePopMissCount >= 10,
        observed: m => m.repeatSamePopMissCount
      },
      {
        field: 'repeatSamePopShare',
        description: 'A meaningful share of MISSes are same-POP re-fetches, not cold first-fetches (≥ 30%)',
        test: m => m.repeatSamePopShare >= 0.3,
        observed: m => pct(m.repeatSamePopShare)
      },
      {
        field: 'shortTtlMissShare',
        description: 'Short TTLs, stale-while-revalidate config, or rapid re-fetch within TTL',
        test: m => m.shortTtlMissShare >= 0.5 || m.staleEligibleMissShare >= 0.5 || m.refetchWithinTtlCount >= 5,
        observed: m =>
          `shortTTL ${pct(m.shortTtlMissShare)}, SWR ${pct(m.staleEligibleMissShare)}, refetch<TTL ${m.refetchWithinTtlCount}`
      }
    ],
    evidence: m => [
      missReasonSummary(m),
      `${m.repeatSamePopMissCount} MISSes (${pct(m.repeatSamePopShare)}) were re-fetches of a URL the same POP had already fetched — those should have HIT`,
      `Average MISS TTL ${Math.round(m.avgMissTtlSeconds)}s; short-TTL share ${pct(m.shortTtlMissShare)}; stale-while-revalidate share ${pct(m.staleEligibleMissShare)}`,
      m.refetchWithinTtlCount > 0
        ? `${m.refetchWithinTtlCount} re-fetches of the same URL/POP within its TTL — content is not being stored (no-store / Set-Cookie / Vary), not merely expiring`
        : 'No same-POP re-fetch-within-TTL detected (timing may be partial)',
      ...(m.missVaryShare > 0
        ? [
            `${pct(m.missVaryShare)} of MISSes carry a Vary header — top values: ${m.topMissVaryValues.slice(0, 3).map(v => `"${v.value}" (${v.count}×)`).join(', ')}`,
            m.highCardinalityVaryMissShare > 0
              ? `${pct(m.highCardinalityVaryMissShare)} of MISSes vary on a high-cardinality header (User-Agent / Cookie / Authorization / X-Forwarded-For / Accept-Language) — each distinct value is its own cache entry, so a POP that "already has" this URL can still MISS if this request's value doesn't match the cached variant`
              : 'Vary is limited to lower-cardinality headers here (e.g. Accept-Encoding) — fragmentation is possible but bounded, unless the CDN fails to normalize those values'
          ]
        : ['No Vary header observed on these MISSes — cache-key fragmentation by Vary is not the explanation here']),
      ...(m.ttlDataSufficient && m.recommendedTtlSeconds > 0
        ? [
            `Recommended fix (full reasoning in the TTL-recommendation finding): max-age ~${fmtDur(m.recommendedTtlSeconds)} (current ${m.observedMaxAgeSeconds > 0 ? fmtDur(m.observedMaxAgeSeconds) : 'none'}), stale-while-revalidate ~${fmtDur(m.recommendedSwrSeconds)} (current ${m.observedSwrSeconds > 0 ? fmtDur(m.observedSwrSeconds) : 'none'})`
          ]
        : []),
      ...m.topMissUrls.filter(u => u.count - u.pops > 0).slice(0, 5).map(u => `  ${urlReason(u)} — ${u.url}`)
    ],
    nextSteps: [
      'These URLs were re-fetched at a POP that already had them — inspect the origin response: a short/missing Cache-Control/Surrogate-Control TTL, no-store, or Set-Cookie on a cacheable path prevents retention.',
      'If the evidence above shows Vary fragmentation: normalize Accept-Encoding at the CDN (most support this) and remove unnecessary high-cardinality Vary dimensions (User-Agent, Cookie, Accept-Language) at the origin unless the response genuinely differs per that dimension.',
      'Confirm is_cacheable=true for these paths — if false, the object is never stored and every request MISSes.',
      'If TTLs are simply short, apply the recommended max-age/stale-while-revalidate values shown above — do not guess a magnitude.'
    ],
    related: ['cdn-pop-fragmentation', 'cdn-ttl-recommendation']
  },
  {
    id: 'cdn-pop-fragmentation',
    name: 'Cache fragmentation across POPs',
    conditions: [
      {
        field: 'repeatedUrlMultiPopShare',
        description: 'The same URLs MISS across multiple POPs (≥ 50% of repeated URLs)',
        test: m => m.repeatedUrlMultiPopShare >= 0.5,
        observed: m => pct(m.repeatedUrlMultiPopShare)
      },
      {
        field: 'avgPopsPerRepeatedMissUrl',
        description: 'Repeated URLs are MISSing on 2+ POPs each',
        test: m => m.avgPopsPerRepeatedMissUrl >= 2,
        observed: m => Number(m.avgPopsPerRepeatedMissUrl.toFixed(2))
      },
      {
        field: 'distinctPopCount',
        description: 'MISS traffic spread across several POPs (≥ 3)',
        test: m => m.distinctPopCount >= 3,
        observed: m => m.distinctPopCount
      },
      {
        field: 'repeatedMissUrlCount',
        description: 'There is a repeating set of URLs to fragment (≥ 5)',
        test: m => m.repeatedMissUrlCount >= 5,
        observed: m => m.repeatedMissUrlCount
      },
      {
        field: 'shieldingUsedMissShare',
        description: 'Origin shielding is off for most MISSes, so each cold POP fetches origin directly',
        test: m => m.shieldingUsedMissShare < 0.5,
        observed: m => `${pct(1 - m.shieldingUsedMissShare)} without shield`
      },
      {
        field: 'coldFetchBurstRatio',
        description: 'Cold-POP fetch timing: clustered (≥5×) suggests a synchronized invalidation/deploy/purge; flat (~1×) suggests organic per-POP diversity',
        test: m => m.coldFetchBurstRatio > 0,
        observed: m => `${m.coldFetchBurstRatio.toFixed(1)}×`,
        informational: true
      }
    ],
    evidence: m => [
      missReasonSummary(m),
      `${pct(m.coldPopFirstFetchShare)} of MISSes are the first fetch of that URL at that POP — nothing was cached at that edge yet, so only shielding or cache warming avoids the origin hit`,
      m.singleRequestMissUrlShare >= 0.3
        ? `Caveat: ${pct(m.singleRequestMissUrlShare)} of MISSed URLs were requested only once in this window — with that little repeat opportunity, "first fetch at this POP" cannot be told apart from "this POP just doesn't get much traffic for this URL". Re-run over a longer window for a trustworthy fragmentation share.`
        : '',
      m.coldFetchBurstRatio >= 5
        ? `These cold-POP first-fetches are clustered in time (burst ratio ${m.coldFetchBurstRatio.toFixed(1)}×), not spread through the window — that pattern points at a synchronized invalidation (a deploy, or a dispatcher/CDN purge) rather than organic per-POP traffic diversity. Correlate this timing with your deploy/publish/purge log before treating it as a caching-architecture problem.`
        : m.coldFetchBurstRatio > 0
          ? `These cold-POP first-fetches are spread through the window (burst ratio ${m.coldFetchBurstRatio.toFixed(1)}×), not clustered around one moment — more consistent with organic per-POP traffic diversity than a single invalidation event`
          : '',
      m.repeatSamePopShare > 0
        ? `${pct(m.repeatSamePopShare)} of MISSes were already cached at that SAME POP before going stale and re-fetching — this share is fixable with a longer TTL/stale-while-revalidate, no shield required`
        : '',
      `${m.distinctPopCount} POPs served MISS traffic; repeated URLs MISSed on ${m.avgPopsPerRepeatedMissUrl.toFixed(2)} POPs on average (${m.repeatedUrlMultiPopCount} spanned >1 POP)`,
      m.shieldingUsedMissShare < 0.5
        ? `Origin shielding is OFF for ${pct(1 - m.shieldingUsedMissShare)} of these MISSes — enabling it collapses multi-POP MISSes into one origin fetch, if that is available to you`
        : `Origin shielding is ON for ${pct(m.shieldingUsedMissShare)} of these MISSes — the shield is not collapsing them; check the cache key or a cold shield POP`,
      'Top MISSed URLs (why):',
      ...m.topMissUrls.slice(0, 6).map(u => `  ${urlReason(u)} — ${u.url}`)
    ].filter(Boolean) as string[],
    nextSteps: [
      'Check whether the cold-POP fetches were clustered in time or spread through the window (see the evidence above) — clustered points at a deploy/purge event to investigate on its own timeline, not a caching-architecture fix.',
      'If shielding is available, enable it — a shield POP collapses multi-POP MISSes into one origin fetch. If it is not available or not easy to turn on, the steps below still help without it.',
      'Raise Surrogate-Control: stale-while-revalidate generously — days or weeks, not minutes (see the TTL recommendation finding) — a per-POP mechanism that works with no shield: once a POP has cached an object, it serves the stale copy and revalidates in the background instead of blocking on origin when it expires. This fixes the "already cached at that POP" share of the fragmentation, not the first-ever fetch at a POP. Publish typically invalidates the dispatcher, not necessarily the CDN edge — confirm your pipeline explicitly purges the CDN on publish before relying on a long SWR for freshness; otherwise a real content change can stay stale for up to that window.',
      'For the first-fetch-per-POP cost that stale-while-revalidate cannot help with, pre-warm the cache after deploys/purges — issue synthetic requests for the top URLs (see "Top MISSed URLs" above) so each POP populates before real traffic arrives.',
      'Confirm requests are not being spread unnaturally across POPs (e.g. a client resolver or load generator hitting many edges) — that inflates the POP count for no benefit.',
      'Review whether the cache key includes POP-specific dimensions (region, node id, etc.) that prevent the same object from being shared across POPs.'
    ],
    related: ['cdn-stale-content', 'cdn-ttl-recommendation']
  },
  {
    id: 'cdn-bot-cold-pop',
    name: 'Bot burst on rarely-used POPs',
    conditions: [
      {
        field: 'botMissShare',
        description: 'Most MISS traffic is attributed to bots (≥ 50%)',
        test: m => m.botMissShare >= 0.5,
        observed: m => pct(m.botMissShare)
      },
      {
        field: 'rarePopMissShare',
        description: 'MISS traffic concentrated on rarely-used / cold POPs (≥ 40%)',
        test: m => m.rarePopMissShare >= 0.4,
        observed: m => pct(m.rarePopMissShare)
      },
      {
        field: 'botOnRarePopMissShare',
        description: 'Bots specifically hitting rare/cold POPs (≥ 30%)',
        test: m => m.botOnRarePopMissShare >= 0.3,
        observed: m => pct(m.botOnRarePopMissShare)
      },
      {
        field: 'topAsnMissShare',
        description: 'MISS traffic concentrated in one source network / ASN (≥ 30%)',
        test: m => m.topAsnMissShare >= 0.3,
        observed: m => pct(m.topAsnMissShare)
      }
    ],
    evidence: (m, upstreamCdn) => [
      `${pct(m.botMissShare)} of MISSes are bot traffic (top bot: ${m.topBotName || 'n/a'}, ${pct(m.topBotMissShare)})`,
      `${pct(m.rarePopMissShare)} of MISSes hit rarely-used POPs${m.baselineUsed ? ' (vs historical baseline)' : ' (in-window heuristic — no baseline)'}`,
      `${pct(m.botOnRarePopMissShare)} of MISSes are bots on cold POPs; top ASN share ${pct(m.topAsnMissShare)}`,
      ...m.topBots.slice(0, 3).map(b => `  ${b.count} MISS — bot: ${b.bot}`),
      ...m.topAsns.slice(0, 3).map(a => `  ${a.count} MISS — AS${a.asn} ${a.name}`),
      ...m.topAsns.slice(0, 3)
        .map(a => describeVerifiedForwarder(a, upstreamCdn))
        .filter((s): s is string => s !== null)
    ],
    nextSteps: [
      'Cold POPs have no warm cache, so bot traffic routed to them MISSes and hits origin — confirm this is unwanted crawling.',
      'Apply bot management / rate limiting for the identified bot(s) and ASN(s).',
      'Enable origin shielding so cold-POP MISSes are absorbed by the shield rather than origin.',
      'If the bot is legitimate (e.g. search indexing), consider a crawl-rate directive or a dedicated cache warming strategy.'
    ],
    related: ['cdn-unique-url-burst']
  }
];

/** Evaluates all root-cause hypotheses and returns the matching ones, highest confidence first. */
export function classifyCacheMiss(metrics: CdnMetrics, upstreamCdn?: UpstreamCdnMatch | null): Finding[] {
  if (metrics.missCount === 0) return [];
  return HYPOTHESES
    .map(h => evaluate(h, metrics, upstreamCdn))
    .filter(f => f.confidenceScore > 0)
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
}

/**
 * Builds the 429 correlation as a context finding (the symptom, not a root cause). Returns null
 * when there were no 429s. Confidence reflects how tightly 429s track the MISS storm.
 */
export function build429Context(metrics: CdnMetrics): Finding | null {
  if (metrics.error429Count === 0) return null;

  const confidence = metrics.missShareOf429 >= 0.5 ? 'high' : metrics.missShareOf429 > 0 ? 'medium' : 'low';
  const matched: MatchedCondition[] = [
    { field: 'error429Count', description: 'HTTP 429 responses in the window', observedValue: metrics.error429Count },
    { field: 'missWith429Count', description: '429s that occurred on a cache MISS', observedValue: metrics.missWith429Count },
    { field: 'missShareOf429', description: 'Share of 429s that were MISSes', observedValue: pct(metrics.missShareOf429) }
  ];
  if (metrics.originError5xxCount > 0) {
    matched.push({ field: 'originError5xxCount', description: 'Origin 5xx responses (overload symptom)', observedValue: metrics.originError5xxCount });
  }
  if (metrics.cdnDeniedCount > 0) {
    matched.push({ field: 'cdnDeniedCount', description: 'Requests rate-limited/denied at the CDN', observedValue: metrics.cdnDeniedCount });
  }

  return {
    signatureId: 'cdn-rate-limit-429',
    signatureName: 'HTTP 429 rate limiting (symptom of the MISS storm)',
    confidence,
    confidenceScore: metrics.missShareOf429,
    matchedConditions: matched,
    unmatchedConditions: [],
    evidence: [
      `${metrics.error429Count} of ${metrics.totalRequests} requests returned 429 (${pct(metrics.error429Ratio)})`,
      `${metrics.missWith429Count} of those (${pct(metrics.missShareOf429)}) were on cache MISSes`,
      metrics.originError5xxCount > 0 ? `${metrics.originError5xxCount} origin 5xx responses — origin is being overwhelmed by MISS-driven fetches` : 'No origin 5xx observed',
      metrics.cdnDeniedCount > 0 ? `${metrics.cdnDeniedCount} requests were rate-limited/denied at the CDN edge` : 'No explicit CDN denials recorded'
    ],
    nextSteps: [
      'The 429s are the symptom — resolve the top-ranked MISS cause above to relieve origin pressure.',
      'Review the origin/CDN rate-limit thresholds against normal traffic to confirm they are not too aggressive.',
      'If origin 5xx is present, check origin capacity and connection pool limits during the window.'
    ],
    relatedSignatures: ['cdn-unique-url-burst', 'cdn-stale-content', 'cdn-pop-fragmentation', 'cdn-bot-cold-pop']
  };
}

/**
 * Flags PASS responses that returned **200** — a cacheable status that bypassed the cache. This is
 * the "really weird, analyse it" case: a 200 should be cacheable, so passing it wastes cache and
 * loads origin. Explains WHY via `fetch_action` (no cache headers vs private/no-store). Null unless
 * PASS+200 is a meaningful majority of PASS.
 */
export function buildPass200Finding(m: CdnMetrics): Finding | null {
  if (m.passWith200Count < 20 || m.passWith200Share < 0.5) return null;

  const why = m.pass200NoHeadersShare >= 0.5
    ? `${pct(m.pass200NoHeadersShare)} were passed because origin sent no cache headers (fetch_action=pass_noheaders) — add a positive max-age to cache them`
    : m.pass200PrivateShare >= 0.5
      ? `${pct(m.pass200PrivateShare)} were passed because origin sent private / no-store on a 200`
      : `Reasons split — no cache headers ${pct(m.pass200NoHeadersShare)}, private/no-store ${pct(m.pass200PrivateShare)}`;

  return {
    signatureId: 'cdn-pass-200-bypass',
    signatureName: 'Cacheable (200) responses bypassing cache (PASS)',
    confidence: m.passWith200Share >= 0.7 ? 'high' : 'medium',
    confidenceScore: m.passWith200Share,
    matchedConditions: [
      { field: 'passWith200Count', description: '200-status responses that bypassed cache (PASS)', observedValue: m.passWith200Count },
      { field: 'passWith200Share', description: 'Share of PASS that returned 200', observedValue: pct(m.passWith200Share) }
    ],
    unmatchedConditions: [],
    evidence: [
      `${m.passWith200Count} of ${m.passCount} PASS responses returned 200 (${pct(m.passWith200Share)}) — a 200 is cacheable by status, so passing it wastes cache and loads origin`,
      why,
      'Top PASS+200 URLs:',
      ...m.topPass200Urls.slice(0, 6).map(u => `  ${u.count}× — ${u.url}`)
    ],
    nextSteps: [
      'These 200 responses bypass the cache — decide whether they should be cacheable.',
      'If yes: set a positive Cache-Control/Surrogate-Control max-age at the AEM publish origin (with no cache headers the CDN passes them).',
      'Remove any no-store / no-cache / private emitted on these 200 pages.',
      'If they are genuinely dynamic/personalised, confirm the PASS is intended.'
    ],
    relatedSignatures: ['cdn-uncacheable']
  };
}

/**
 * Flags a majority of PASS being **non-200 (excluding 429)** for manual investigation. Such statuses
 * (3xx/4xx/5xx) are uncacheable by status, so a PASS is expected — but a large volume signals
 * redirect loops / origin errors worth a look. 429s are excluded (origin stress — see the 429 finding).
 */
export function buildPassErrorFinding(m: CdnMetrics): Finding | null {
  if (m.passNon200Non429Count < 20 || m.passNon200Non429Share < 0.5) return null;

  const statuses = m.passStatusTop.filter(s => s.status !== 200 && s.status !== 429);

  return {
    signatureId: 'cdn-pass-non200',
    signatureName: 'Uncacheable non-200 responses (manual investigation)',
    confidence: m.passNon200Non429Share >= 0.7 ? 'high' : 'medium',
    confidenceScore: m.passNon200Non429Share,
    matchedConditions: [
      { field: 'passNon200Non429Count', description: 'PASS responses with a non-200, non-429 status', observedValue: m.passNon200Non429Count },
      { field: 'passNon200Non429Share', description: 'Share of PASS that were non-200 (excl. 429)', observedValue: pct(m.passNon200Non429Share) }
    ],
    unmatchedConditions: [],
    evidence: [
      `${m.passNon200Non429Count} of ${m.passCount} PASS responses were non-200, non-429 (${pct(m.passNon200Non429Share)}) — these statuses (3xx/4xx/5xx) cannot be cached, so they PASS`,
      ...statuses.slice(0, 6).map(s => `  ${s.count}× — HTTP ${s.status}`),
      m.pass429Count > 0 ? `(${m.pass429Count} PASS were 429 — excluded here; see the 429 finding: likely origin stress from the MISS storm)` : ''
    ].filter(Boolean) as string[],
    nextSteps: [
      'A large share of traffic is uncacheable error/redirect responses — worth a manual look.',
      'Many 3xx can mean a redirect loop or misconfigured vanity URLs; many 5xx means origin errors — check the dominant statuses above.',
      'Investigate origin health and the specific paths generating these responses.'
    ],
    relatedSignatures: ['cdn-rate-limit-429']
  };
}

/**
 * Recommends a cache TTL from the observed request rate, so shielded content survives between
 * requests instead of being evicted (shielding only helps if the object outlives its inter-arrival
 * gap), PLUS a stale-while-revalidate window sized to the per-POP gap. Unlike max-age,
 * stale-while-revalidate is a per-edge-node mechanism — it works even without a shield: once a POP
 * has cached the object, that same POP can serve the stale copy (revalidating in the background)
 * instead of blocking on origin the next time it goes stale. Null when there isn't enough
 * repeat-request timing to make a call.
 */
export function buildTtlRecommendation(m: CdnMetrics): Finding | null {
  if (!m.ttlDataSufficient || m.recommendedTtlSeconds <= 0) return null;

  const current = m.observedMaxAgeSeconds;
  const rec = m.recommendedTtlSeconds;         // clamped to never fall below `current`
  const raise = current === 0 || rec > current; // only ever keep or raise — never lower
  const confidence: 'high' | 'medium' | 'low' = raise ? (current > 0 ? 'high' : 'medium') : 'low';

  const swr = m.recommendedSwrSeconds;
  const swrRaise = swr > 0 && (m.observedSwrSeconds === 0 || swr > m.observedSwrSeconds);

  return {
    signatureId: 'cdn-ttl-recommendation',
    signatureName: raise
      ? `Increase cache TTL to ~${fmtDur(rec)} (current ${current > 0 ? fmtDur(current) : 'none'})`
      : `Cache TTL (~${fmtDur(current)}) is adequate — do not lower it`,
    confidence,
    confidenceScore: scoreFor(confidence),
    matchedConditions: [
      { field: 'observedMaxAgeSeconds', description: 'Current origin max-age (most common on MISSes)', observedValue: current > 0 ? fmtDur(current) : 'none' },
      { field: 'recommendedTtlSeconds', description: 'Recommended TTL (edge inter-arrival, never below current)', observedValue: fmtDur(rec) },
      { field: 'p90PerPopGapSeconds', description: 'P90 gap between requests to a URL at one POP (edge)', observedValue: fmtDur(m.p90PerPopGapSeconds) },
      ...(swrRaise ? [{ field: 'recommendedSwrSeconds', description: 'Recommended stale-while-revalidate (per-POP, works without a shield)', observedValue: fmtDur(swr) }] : [])
    ],
    unmatchedConditions: [],
    evidence: [
      `Cacheable requests to these paths arrive at ~${m.cacheableRequestRatePerMin.toFixed(1)}/min over a ${fmtDur(m.windowSeconds)} window`,
      `Gap between repeat requests to the same URL: ~${fmtDur(m.p50AggGapSeconds)} median / ~${fmtDur(m.p90AggGapSeconds)} P90 at the shield (aggregate), vs ~${fmtDur(m.p90PerPopGapSeconds)} P90 per POP at the edge`,
      raise
        ? `Content expires before it is re-requested — a TTL of ~${fmtDur(rec)} would keep more of it served from cache (current: ${current > 0 ? fmtDur(current) : 'no max-age'})`
        : `Current TTL ${fmtDur(current)} already exceeds the request gap — lowering it would only ADD MISSes. The ${pct(m.missRatio)} MISS rate here is NOT caused by too-long a TTL`,
      raise
        ? `Without shielding, an edge POP would still need a TTL up to ~${fmtDur(m.p90PerPopGapSeconds)} to avoid a MISS on expiry — shielding fixes that at the aggregate rate, but stale-while-revalidate=${fmtDur(swr)} does the same job per-POP with no shield: instead of blocking on origin, that POP serves the stale copy while it revalidates in the background. SWR is cheap to set this generously — the client-visible freshness (max-age) is unchanged — but confirm your publish pipeline explicitly purges the CDN edge, not just the dispatcher: if it does not, a real content change can stay stale for up to this whole window`
        : `The MISSes are driven by cold caches per POP (first-fetch-per-POP ${pct(m.coldPopFirstFetchShare)}) — that specific cost needs shielding or cache warming, not a TTL/SWR change (nothing is cached at a brand-new POP yet to serve stale)`,
      m.repeatSamePopShare > 0
        ? `${pct(m.repeatSamePopShare)} of MISSes were already cached at that SAME POP before going stale — stale-while-revalidate directly prevents THIS share from blocking on origin, with no shield required`
        : '',
      m.singleRequestCacheableUrlShare >= 0.3
        ? `Caveat: ${pct(m.singleRequestCacheableUrlShare)} of URLs were requested only once in this window — they can't be TTL-sized here; re-run over a longer window for a firmer number`
        : ''
    ].filter(Boolean) as string[],
    nextSteps: raise
      ? [
          `Set Surrogate-Control: max-age=${rec} (a CDN-only TTL) so content lives longer at the edge/shield without changing the browser Cache-Control.`,
          ...(swrRaise ? [`Set Surrogate-Control: stale-while-revalidate=${fmtDur(swr)} alongside it — this is what actually stops a stale-but-still-cached POP from blocking on origin; it works even if shielding is not available.`] : []),
          'Enable origin shielding if you can — it additionally collapses the first-fetch-per-POP cost onto one origin fetch instead of one per POP.',
          'Re-run over a longer window (a few hours) for a firmer TTL — especially for URLs seen only once here.'
        ]
      : [
          'Keep the current TTL — do NOT lower it; a shorter TTL expires content sooner and increases MISSes.',
          swrRaise
            ? `Raise Surrogate-Control: stale-while-revalidate to ~${fmtDur(swr)} — the TTL itself is fine, but a longer stale-serving window still cuts blocking MISSes at POPs that already had the object, without needing a shield.`
            : 'The MISSes here come from cold caches spread across POPs — enable origin shielding so an edge MISS is served by a warm shield instead of origin.',
          'Only lower the TTL for a freshness requirement (content changing faster than the TTL) — that is separate from the MISS rate.',
          'Re-run over a longer window for a firmer picture, especially for URLs seen only once here.'
        ],
    relatedSignatures: ['cdn-pop-fragmentation', 'cdn-stale-content']
  };
}

/**
 * Recomputes the cloud-ASN / top-ASN signals with a known, legitimate upstream CDN's traffic
 * (identified via {@link resolveUpstreamCdn}) excluded — that traffic is this origin's OWN front
 * door doing origin-fetches on behalf of real visitors, not a botnet.
 */
function excludeUpstreamCdn(m: CdnMetrics, upstreamCdn: UpstreamCdnMatch) {
  const matched = m.topSourceAsns.filter(a => nameMatchesProvider(a.name, upstreamCdn.provider));
  const matchedAsnKeys = new Set(matched.map(a => a.asn));
  const matchedCount = matched.reduce((sum, a) => sum + a.count, 0);
  const nextTopAsn = m.topSourceAsns.find(a => !matchedAsnKeys.has(a.asn));
  const totalRequests = Math.max(m.totalRequests, 1);
  return {
    matched,
    matchedAsnKeys,
    matchedShare: matchedCount / totalRequests,
    cloudAsnRequestShare: Math.max(0, m.cloudAsnRequestShare - matchedCount / totalRequests),
    topAsnRequestShare: nextTopAsn ? nextTopAsn.count / totalRequests : 0,
    topAsnRequestName: nextTopAsn?.name ?? ''
  };
}

/**
 * Flags suspicious / possible-DDoS traffic: a burst concentrated in cloud/hosting ASNs (not eyeball
 * ISPs), traffic the CDN already flagged (ddos_action/ddos_rule/malicious_flags), or — when the ASN
 * signal is inconclusive — a burst concentrated in a single client IP, user agent, or country. The
 * IP/UA/country signals are weaker on their own (a busy office NAT or a genuinely regional site can
 * look similar), so each only counts alongside an actual burst (spikiness), never in isolation.
 * Common for redirect/error floods from a small set of hosting networks. Null when no pattern fires.
 *
 * `upstreamCdn` — when the origin's own DNS (see {@link resolveUpstreamCdn}) shows it is fronted by
 * a known CDN, and that provider matches (one of) the flagged cloud ASN(s) — that ASN's traffic is
 * excluded from the cloud-ASN signal before evaluating it: it is the customer's own CDN making
 * origin-fetch requests, not attacker infrastructure. This can fully rule the finding out (when it
 * was the only signal that fired) or just narrow the evidence to the genuinely unexplained ASNs.
 */
export function buildDdosFinding(m: CdnMetrics, upstreamCdn?: UpstreamCdnMatch | null): Finding | null {
  const excl = upstreamCdn ? excludeUpstreamCdn(m, upstreamCdn) : null;
  const hasUpstreamMatch = !!excl && excl.matchedShare > 0;

  const effectiveCloudShare = hasUpstreamMatch ? excl!.cloudAsnRequestShare : m.cloudAsnRequestShare;
  const effectiveTopAsnShare = hasUpstreamMatch ? excl!.topAsnRequestShare : m.topAsnRequestShare;
  const effectiveTopAsnName = hasUpstreamMatch ? excl!.topAsnRequestName : m.topAsnRequestName;

  const cloudBurst = effectiveCloudShare >= 0.4 && (m.burstRatio >= 5 || effectiveTopAsnShare >= 0.3);
  const cdnFlagged = m.cdnThreatShare >= 0.1;
  const ipBurst = m.topClientIpRequestShare >= 0.2 && m.burstRatio >= 5;
  const uaBurst = m.topUserAgentRequestShare >= 0.6 && m.burstRatio >= 5;
  const countryBurst = m.topCountryRequestShare >= 0.6 && m.burstRatio >= 5;
  if (!cloudBurst && !cdnFlagged && !ipBurst && !uaBurst && !countryBurst) return null;

  const signalCount = [cloudBurst, cdnFlagged, ipBurst, uaBurst, countryBurst].filter(Boolean).length;
  const confidence: 'high' | 'medium' | 'low' =
    cdnFlagged || effectiveCloudShare >= 0.8 || (effectiveCloudShare >= 0.5 && m.burstRatio >= 8) || signalCount >= 2
      ? 'high' : 'medium';

  const matchedAsnKeys = hasUpstreamMatch ? excl!.matchedAsnKeys : new Set<string>();
  const cloudAsns = m.topSourceAsns.filter(a => a.cloud && !matchedAsnKeys.has(a.asn));
  const nonUpstreamAsns = m.topSourceAsns.filter(a => !matchedAsnKeys.has(a.asn));
  const shownAsns = cloudAsns.length > 0 ? cloudAsns : nonUpstreamAsns.length > 0 ? nonUpstreamAsns : m.topSourceAsns;

  return {
    signatureId: 'cdn-ddos-pattern',
    signatureName: 'Suspicious traffic / possible DDoS (cloud-ASN burst)',
    confidence,
    confidenceScore: scoreFor(confidence),
    matchedConditions: [
      { field: 'cloudAsnRequestShare', description: 'Requests from cloud/hosting ASNs (not eyeball ISPs)', observedValue: pct(effectiveCloudShare) },
      { field: 'burstRatio', description: 'Peak vs mean request rate (spikiness)', observedValue: `${m.burstRatio.toFixed(1)}×` },
      { field: 'topAsnRequestShare', description: 'Busiest source ASN share', observedValue: pct(effectiveTopAsnShare) },
      ...(cdnFlagged ? [{ field: 'cdnThreatShare', description: 'Requests already flagged by CDN DDoS/WAF', observedValue: pct(m.cdnThreatShare) }] : []),
      ...(ipBurst ? [{ field: 'topClientIpRequestShare', description: 'Busiest single client IP share of all requests', observedValue: pct(m.topClientIpRequestShare) }] : []),
      ...(uaBurst ? [{ field: 'topUserAgentRequestShare', description: 'Busiest single user agent share of all requests', observedValue: pct(m.topUserAgentRequestShare) }] : []),
      ...(countryBurst ? [{ field: 'topCountryRequestShare', description: 'Busiest single client country share of all requests', observedValue: pct(m.topCountryRequestShare) }] : [])
    ],
    unmatchedConditions: [],
    evidence: [
      ...(hasUpstreamMatch ? [
        `${pct(excl!.matchedShare)} of requests came from this origin's own CDN (${upstreamCdn!.provider}) — confirmed via DNS (${upstreamCdn!.hostname} → ${upstreamCdn!.chain.join(' → ')})` +
        (excl!.matched[0]?.forwardedSample
          ? ` and via its own request headers (e.g. real end-user IP ${excl!.matched[0].forwardedSample!.realClientIp} behind this edge${excl!.matched[0].forwardedSample!.via ? `, Via: ${excl!.matched[0].forwardedSample!.via}` : ''})`
          : '') +
        `; excluded below as expected upstream origin-fetches, not attacker traffic.`
      ] : []),
      `${pct(effectiveCloudShare)} of requests come from ${hasUpstreamMatch ? 'OTHER ' : ''}cloud/hosting networks (not typical eyeball ISPs) — unusual for organic page traffic`,
      `Peak ${m.peakRequestsPerSec}/s, burst ratio ${m.burstRatio.toFixed(1)}× over the window${effectiveTopAsnName ? `; top source: ${effectiveTopAsnName} (${pct(effectiveTopAsnShare)})` : ''}`,
      m.cdnThreatShare > 0
        ? `${pct(m.cdnThreatShare)} of requests were already flagged by the CDN (ddos_action / ddos_rule / malicious_flags / deny_reason)`
        : 'No CDN DDoS/WAF flags on this traffic yet — it is slipping through',
      ...(ipBurst ? [`${pct(m.topClientIpRequestShare)} of requests come from a single client IP (${m.topClientIpAddress}) — not typical for organic traffic`] : []),
      ...(uaBurst ? [`${pct(m.topUserAgentRequestShare)} of requests share one user agent ("${m.topUserAgentName}") — consistent with scripted/bot traffic`] : []),
      ...(countryBurst ? [`${pct(m.topCountryRequestShare)} of requests originate from a single country (${m.topCountryCode}) — check whether that matches this service's expected audience`] : []),
      hasUpstreamMatch ? 'Top source networks (excluding the origin\'s own CDN above):' : 'Top source networks:',
      ...shownAsns.slice(0, 5).map(a => `  ${a.count}× — AS${a.asn} ${a.name}${a.cloud ? ' [cloud/hosting]' : ''}`),
      ...(ipBurst ? ['Top client IPs:', ...m.topClientIps.slice(0, 5).map(ip => `  ${ip.count}× — ${ip.ip}`)] : []),
      ...(uaBurst ? ['Top user agents:', ...m.topUserAgents.slice(0, 5).map(ua => `  ${ua.count}× — ${ua.userAgent}`)] : []),
      ...(countryBurst ? ['Top client countries:', ...m.topCountries.slice(0, 5).map(c => `  ${c.count}× — ${c.country}`)] : [])
    ],
    nextSteps: [
      hasUpstreamMatch
        ? `Rate-limit, challenge, or block the OTHER identified cloud/hosting ASNs at the CDN — NOT ${upstreamCdn!.provider}, which is this origin's own CDN (confirmed via DNS) and is expected to be the majority source.`
        : 'Rate-limit, challenge, or block the identified cloud/hosting ASNs at the CDN — legitimate users rarely browse from these networks.',
      'Enable / tune the CDN DDoS and bot-management rules (ddos_action) for this burst pattern.',
      'Correlate with the 429s and origin load — this traffic may be driving the origin stress.',
      ...(ipBurst || uaBurst || countryBurst
        ? ['Corroborate with the client IP / user agent / country concentration above before blocking — a single legitimate integration or office network can look similar.']
        : []),
      'If it is a known integration (monitoring, prefetch, migration), allowlist it; otherwise treat it as an attack.'
    ],
    relatedSignatures: ['cdn-pass-non200', 'cdn-rate-limit-429', 'cdn-bot-cold-pop']
  };
}

// ── Internals ─────────────────────────────────────────────────────────────────

function evaluate(h: Hypothesis, m: CdnMetrics, upstreamCdn?: UpstreamCdnMatch | null): Finding {
  const matched: MatchedCondition[] = [];
  const unmatched: UnmatchedCondition[] = [];
  let scoredTotal = 0;
  let scoredMatched = 0;

  for (const c of h.conditions) {
    const ok = c.test(m);
    if (ok) matched.push({ field: c.field, description: c.description, observedValue: c.observed(m) });
    if (!c.informational) {
      scoredTotal++;
      if (ok) scoredMatched++;
      else unmatched.push({ field: c.field, description: c.description, required: true });
    }
  }

  const score = scoredTotal > 0 ? scoredMatched / scoredTotal : 0;
  const confidence = score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';

  return {
    signatureId: h.id,
    signatureName: h.name,
    confidence,
    confidenceScore: score,
    matchedConditions: matched,
    unmatchedConditions: unmatched,
    evidence: scoredMatched > 0 ? h.evidence(m, upstreamCdn) : [],
    nextSteps: h.nextSteps,
    relatedSignatures: h.related
  };
}
