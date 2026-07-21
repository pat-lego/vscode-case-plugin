import { CdnAnalysisInput, CdnFetchOptions } from './types';

/**
 * The CDN fields the incident query projects. Kept narrow so the (expensive) query returns
 * only what the analysis reasons over. Field names are the raw Fastly/Skyline log keys.
 */
export const CDN_FIELDS = [
  'url',
  'cache_status',
  'fastly_info_state',
  'response_x_cache',
  'status',
  'origin_status',
  'server_datacenter',
  'server_region',
  'server_hostname',
  'bot_name',
  'request_user_agent',
  'client_ip',
  'client_as_number',
  'client_as_name',
  'response_age',
  'response_ttl',
  'is_cacheable',
  'fetch_action',
  'cache_location',
  'shielding_used',
  'content_type',
  'fetch_surrogate_control',
  'fetch_cache_control',
  'ddos_action',
  'ddos_rule',
  'malicious_flags',
  'deny_reason',
  'geo_country_code',
  'aem_service',
  'aem_tier',
  'time_start',
  'origin_host',
  'original_x_forwarded_for',
  'xdata.request_via'
] as const;

const DEFAULT_MAX_EVENTS = 100000;
const MAX_BASELINE_DAYS = 2;
const SECONDS_PER_DAY = 86400;
const DEFAULT_TIER = 'publish';

/**
 * Builds the incident-window SPL: row-level events for the service/URLs in the window, with a
 * narrow field projection and a `head` cap. This is the detailed dataset the classifier uses.
 *
 * `| sort 0 +_time` forces a genuine chronological (ascending) order before anything else runs.
 * Without it, Splunk's default result order is not guaranteed to be time-ordered, which several
 * analyses depend on: which (URL, POP) fetch is "first" (cold) vs. a later repeat, and the
 * cold-fetch burst-clustering check, are both determined by processing order — an unordered feed
 * would make those reads unreliable. `sort 0` (not just `sort`) is required to sort the FULL
 * result set: `sort`'s default cap is only the first 10,000 rows, well under `maxEvents`.
 */
export function buildIncidentQuery(input: CdnAnalysisInput, opts: CdnFetchOptions): string {
  const parts = baseFilters(input, opts);
  parts.push(`earliest=${toSplunkTime(input.from)}`, `latest=${toSplunkTime(input.to)}`);

  const urlClause = buildUrlClause(input.urls);
  if (urlClause) parts.push(urlClause);

  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  return `${parts.join(' ')} | sort 0 +_time | fields ${CDN_FIELDS.join(' ')} | head ${maxEvents}`;
}

/**
 * Builds the baseline SPL: a cheap `stats count by server_datacenter` over the `baselineDays`
 * (max 2) ending at the incident start. Aggregating in Splunk keeps this expensive query light.
 */
export function buildBaselineQuery(input: CdnAnalysisInput, opts: CdnFetchOptions): string {
  const days = clampBaselineDays(opts.baselineDays);
  const { earliest, latest } = baselineWindow(input.from, days);

  const parts = baseFilters(input, opts);
  parts.push(`earliest=${earliest}`, `latest=${latest}`, '| stats count by server_datacenter');
  return parts.join(' ');
}

/**
 * The shared leading filters both queries use: index, optional sourcetype, service and tier.
 * `sourcetype` is omitted entirely when unset (some CDN indexes need no sourcetype filter).
 */
function baseFilters(input: CdnAnalysisInput, opts: CdnFetchOptions): string[] {
  const parts = ['search', `index=${escapeSplunkValue(opts.index)}`];
  if (opts.sourcetype && opts.sourcetype.trim()) {
    parts.push(`sourcetype=${escapeSplunkValue(opts.sourcetype)}`);
  }
  parts.push(`aem_service="${escapeSplunkValue(input.service)}"`);
  parts.push(`aem_tier="${escapeSplunkValue(input.tier || DEFAULT_TIER)}"`);
  return parts;
}

/** Clamps the requested baseline look-back to the allowed [1, 2] day range. */
export function clampBaselineDays(days: number | undefined): number {
  if (!days || days < 1) return MAX_BASELINE_DAYS;
  return Math.min(days, MAX_BASELINE_DAYS);
}

// ── Time / value helpers ────────────────────────────────────────────────────────

/**
 * Renders a time value for a Splunk `earliest=`/`latest=` modifier. Relative modifiers
 * (e.g. "-60m@m") are passed through; absolute times are converted to epoch seconds.
 */
export function toSplunkTime(value: string): string {
  const v = (value ?? '').trim();
  if (!v) return 'now';
  if (isRelativeModifier(v)) return v;
  const epoch = toEpochSeconds(v);
  return epoch !== null ? String(epoch) : `"${escapeSplunkValue(v)}"`;
}

/** True if the value is Splunk relative-time syntax rather than an absolute timestamp. */
export function isRelativeModifier(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'now' || v === 'rt') return true;
  // e.g. -60m, +1h, -2d@d, @d
  return /^[-+]?\d+(?:s|m|h|d|w|mon|q|y|us|ms|cs|ds)(?:@[a-z0-9]+)?$/.test(v) || /^@[a-z0-9]+$/.test(v);
}

/** Converts an absolute time string to epoch seconds, or null if not absolute/parseable. */
export function toEpochSeconds(value: string): number | null {
  const s = value.trim();
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  if (/^\d{10}$/.test(s)) return Number(s);
  const d = new Date(s.replace(/GMT$/, 'Z'));
  return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/**
 * Computes the baseline window ending at the incident start `from`, spanning `days` days.
 * Uses epoch arithmetic for absolute starts; for relative starts, anchors the end at `from`
 * and the start at a relative `-{days}d` modifier.
 */
function baselineWindow(from: string, days: number): { earliest: string; latest: string } {
  const startEpoch = toEpochSeconds(from);
  if (startEpoch !== null) {
    return { earliest: String(startEpoch - days * SECONDS_PER_DAY), latest: String(startEpoch) };
  }
  return { earliest: `-${days}d`, latest: toSplunkTime(from) };
}

/** Builds an OR clause matching any of the requested URLs; returns '' when none are given. */
function buildUrlClause(urls: string[] | undefined): string {
  const cleaned = (urls ?? []).map(u => u.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  const terms = cleaned.map(u => `url="${escapeSplunkValue(u)}"`);
  return `(${terms.join(' OR ')})`;
}

/**
 * Escapes a value for embedding inside an SPL double-quoted string. Backslashes and quotes are
 * escaped and control characters stripped. The whole SPL is passed as a single argv to
 * `execFile` (no shell), so this guards only against breaking Splunk's own parser.
 */
export function escapeSplunkValue(value: string): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
}
