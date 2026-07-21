/**
 * Cross-references a MISS-storm's flagged "cloud/hosting ASN" traffic against the origin's OWN
 * DNS delegation, to rule out a specific false positive: sites that themselves sit behind a CDN
 * (Akamai, Cloudflare, Fastly, CloudFront, ...) see ALL of their real visitor traffic arrive at
 * this layer AS that CDN's edge network — a legitimate origin-fetch, not a botnet. Walking the
 * hostname's CNAME chain (the `dig`-equivalent) and matching it against known CDN delegation
 * domains tells the classifier "this ASN is the customer's own front door", so a burst from it is
 * not, by itself, a DDoS signal.
 */

/** One resolved CNAME hop plus the provider it identifies, when the chain leads to a known CDN. */
export interface UpstreamCdnMatch {
  /** The hostname that was resolved (e.g. "www.macnica.com"). */
  hostname: string;
  /** The full CNAME chain walked, in order, ending at the matched hop. */
  chain: string[];
  /** Canonical provider keyword (e.g. "akamai", "cloudflare") — matches the vocabulary `isCloudAsn` uses. */
  provider: string;
}

/** Injectable CNAME resolver — defaults to `dns.promises.resolveCname`. Mirrors the `SplunkRunner` DI pattern. */
export type CnameResolver = (hostname: string) => Promise<string[]>;

const MAX_CHAIN_HOPS = 10;
const RESOLVE_TIMEOUT_MS = 3000;

/**
 * CNAME delegation domains known to belong to a CDN, mapped to the canonical provider keyword.
 * Keywords intentionally match the vocabulary in `metrics.ts`'s `CLOUD_ASN_RE`, so a match here
 * can be checked against an ASN name with a simple case-insensitive word match.
 */
const KNOWN_CDN_SUFFIXES: Array<{ suffix: string; provider: string }> = [
  { suffix: 'akamaiedge.net', provider: 'akamai' },
  { suffix: 'akamaized.net', provider: 'akamai' },
  { suffix: 'akamaihd.net', provider: 'akamai' },
  { suffix: 'akamaitechnologies.com', provider: 'akamai' },
  { suffix: 'edgekey.net', provider: 'akamai' },
  { suffix: 'edgesuite.net', provider: 'akamai' },
  { suffix: 'cloudflare.net', provider: 'cloudflare' },
  { suffix: 'fastly.net', provider: 'fastly' },
  { suffix: 'fastlylb.net', provider: 'fastly' },
  { suffix: 'cloudfront.net', provider: 'amazon' },
  { suffix: 'azureedge.net', provider: 'microsoft' },
  { suffix: 'azurefd.net', provider: 'microsoft' },
  { suffix: 'trafficmanager.net', provider: 'microsoft' },
  { suffix: 'googleusercontent.com', provider: 'google' },
  { suffix: 'ghs.google.com', provider: 'google' },
  { suffix: 'googlehosted.com', provider: 'google' },
  { suffix: 'llnwd.net', provider: 'limelight' },
  { suffix: 'lldns.net', provider: 'limelight' },
  { suffix: 'edgecastcdn.net', provider: 'edgecast' },
  { suffix: 'systemcdn.net', provider: 'edgecast' },
  { suffix: 'stackpathcdn.com', provider: 'stackpath' },
  { suffix: 'incapdns.net', provider: 'imperva' },
  { suffix: 'impervadns.net', provider: 'imperva' },
  { suffix: 'sucuri.net', provider: 'sucuri' },
  { suffix: 'cdn77.net', provider: 'cdn77' },
  { suffix: 'kxcdn.com', provider: 'keycdn' },
  { suffix: 'gcorelabs.net', provider: 'gcore' },
  { suffix: 'gcdn.co', provider: 'gcore' }
];

function matchKnownSuffix(hop: string): string | null {
  const h = hop.toLowerCase().replace(/\.$/, '');
  for (const { suffix, provider } of KNOWN_CDN_SUFFIXES) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return provider;
  }
  return null;
}

/** True if `name` (e.g. an ASN name) contains the provider keyword as a whole word, case-insensitively. */
export function nameMatchesProvider(name: string, provider: string): boolean {
  if (!name || !provider) return false;
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(name);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

async function defaultResolveCname(hostname: string): Promise<string[]> {
  const dns = await import('dns');
  return dns.promises.resolveCname(hostname);
}

/**
 * Walks the CNAME chain for `hostname` (like `dig`), hop by hop, looking for a known CDN
 * delegation domain. Returns the match (with the full chain walked) as soon as one is found, or
 * `null` if the chain ends (an A/AAAA record, NXDOMAIN, or no CNAME at all) without matching a
 * known CDN. DNS failures at any hop are treated the same as "no match" — this is a best-effort
 * cross-check, never a hard failure of the analysis.
 */
export async function resolveUpstreamCdn(
  hostname: string,
  resolveCname: CnameResolver = defaultResolveCname
): Promise<UpstreamCdnMatch | null> {
  const start = (hostname ?? '').trim();
  if (!start) return null;

  const chain: string[] = [];
  let current = start;

  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    const provider = matchKnownSuffix(current);
    if (provider) return { hostname: start, chain, provider };

    let targets: string[];
    try {
      targets = await withTimeout(resolveCname(current), RESOLVE_TIMEOUT_MS);
    } catch {
      return null; // no further CNAME (A/AAAA record) or a lookup failure — no match
    }
    if (!targets.length) return null;

    current = targets[0];
    chain.push(current);
  }
  return null;
}
