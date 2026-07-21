import { CdnAnalysisInput, CdnAnalysisReport, CdnFetchOptions, CdnLogEntry, CdnMetrics, PopBaseline } from './types';
import { CdnAggregator, computeCdnMetrics } from './metrics';
import { classifyCacheMiss, build429Context, buildPass200Finding, buildPassErrorFinding, buildTtlRecommendation, buildDdosFinding } from './classifier';
import { parseCdnLogs } from './parser';
import { buildIncidentQuery, buildBaselineQuery } from './query-builder';
import { streamCdnLogs, streamCdnFile, fetchCdnLogs, fetchPopBaseline } from './fetcher';
import { resolveUpstreamCdn, CnameResolver, UpstreamCdnMatch } from './upstream-cdn';

const DEFAULT_MAX_EVENTS = 100000;

/**
 * Pure analysis over already-fetched CDN events: aggregate metrics, classify the MISS cause, and
 * assemble a report. Useful when the log data is already in hand (a mocked runner, a pasted/
 * captured export). Pass a {@link PopBaseline} to define POP rarity from history.
 *
 * No DNS lookup happens here (this function does no I/O) — pass an already-resolved
 * `upstreamCdn` (see {@link resolveUpstreamCdn}) if the cloud-ASN-vs-origin's-own-CDN cross-check
 * should be applied. The other `analyzeCdn*` entry points resolve it automatically.
 */
export function analyzeCdnEntries(
  entries: CdnLogEntry[],
  input: CdnAnalysisInput,
  baseline?: PopBaseline,
  upstreamCdn?: UpstreamCdnMatch | null
): CdnAnalysisReport {
  return assembleReport(computeCdnMetrics(entries, baseline), input, entries.length, [], upstreamCdn);
}

/**
 * Analyses an already-captured CDN export **pasted as text** — the raw `sky splunk query` output
 * (JSON array or NDJSON) or the human-readable KV `_raw` block. No Splunk round-trip; POP rarity
 * uses the in-window heuristic (no historical baseline is available offline). The origin hostname
 * seen in the data is cross-referenced against a live DNS lookup (see {@link resolveUpstreamCdn})
 * to rule out the origin's own CDN being mistaken for a DDoS source; DNS failures are non-fatal.
 * `resolveCname` is injectable (defaults to `dns.promises.resolveCname`) — pass a fake in tests.
 */
export async function analyzeCdnText(
  rawText: string,
  input: CdnAnalysisInput,
  baseline?: PopBaseline,
  resolveCname?: CnameResolver
): Promise<CdnAnalysisReport> {
  const entries = parseCdnLogs(rawText);
  const metrics = computeCdnMetrics(entries, baseline);
  const upstreamCdn = await tryResolveUpstreamCdn(metrics.topOriginHost, metrics.warnings, resolveCname);
  return assembleReport(metrics, input, entries.length, [], upstreamCdn);
}

/**
 * Analyses a saved CDN export **file**, streaming NDJSON line-by-line so large exports stay
 * memory-bounded. Falls back to whole-file parsing when the file is a JSON array / KV block.
 * Cross-references the origin hostname against DNS, as {@link analyzeCdnText} does.
 */
export async function analyzeCdnFile(
  filePath: string,
  input: CdnAnalysisInput,
  baseline?: PopBaseline,
  resolveCname?: CnameResolver
): Promise<CdnAnalysisReport> {
  const agg = new CdnAggregator();
  const count = await streamCdnFile(filePath, entry => agg.add(entry));
  if (count > 0) {
    const metrics = agg.finalize(baseline);
    const upstreamCdn = await tryResolveUpstreamCdn(metrics.topOriginHost, metrics.warnings, resolveCname);
    return assembleReport(metrics, input, count, [], upstreamCdn);
  }
  // Not NDJSON — read the whole file and parse as an array / KV block.
  const fs = await import('fs');
  const raw = fs.readFileSync(filePath, 'utf-8');
  const entries = parseCdnLogs(raw);
  const metrics = computeCdnMetrics(entries, baseline);
  const upstreamCdn = await tryResolveUpstreamCdn(metrics.topOriginHost, metrics.warnings, resolveCname);
  return assembleReport(metrics, input, entries.length, [], upstreamCdn);
}

/**
 * End-to-end analysis. By default the incident logs are **streamed** from `sky splunk query` and
 * folded into an incremental aggregator, so the (potentially huge) CDN response is never buffered
 * whole — memory scales with distinct URLs/POPs, not event count. When a `runner` is injected
 * (tests) the buffered array path is used instead. A ≤2-day POP baseline is fetched unless disabled;
 * baseline failures are non-fatal (analysis falls back to the in-window rarity heuristic).
 */
export async function analyzeCdnCacheMisses(
  input: CdnAnalysisInput,
  opts: CdnFetchOptions
): Promise<CdnAnalysisReport> {
  const preWarnings: string[] = [];
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;

  // Capture the exact commands so the report can "show its work" / be re-run by hand.
  const splunkQueries: string[] = [`sky splunk query '${buildIncidentQuery(input, opts)}'`];
  if (opts.baseline !== false) splunkQueries.push(`sky splunk query '${buildBaselineQuery(input, opts)}'`);

  // Fetch the incident data first (fails fast with a clear error, e.g. auth, before the baseline).
  let finalize: (baseline?: PopBaseline) => CdnMetrics;
  let entryCount: number;

  if (opts.runner) {
    const entries = await fetchCdnLogs(input, opts);
    entryCount = entries.length;
    if (maxEvents > 0 && entryCount >= maxEvents) preWarnings.push(truncationWarning(maxEvents));
    finalize = baseline => computeCdnMetrics(entries, baseline);
  } else {
    const agg = new CdnAggregator();
    const { count, truncated } = await streamCdnLogs(input, opts, entry => agg.add(entry));
    entryCount = count;
    if (truncated) preWarnings.push(truncationWarning(maxEvents));
    finalize = baseline => agg.finalize(baseline);
  }

  // POP baseline (cheap, aggregated in Splunk). Non-fatal.
  let baseline: PopBaseline | undefined;
  if (opts.baseline !== false) {
    try {
      baseline = await fetchPopBaseline(input, opts);
      if (baseline.totalRequests === 0) {
        preWarnings.push('POP baseline query returned no data — using in-window rarity heuristic.');
        baseline = undefined;
      }
    } catch (err) {
      preWarnings.push(`POP baseline query failed (${errMsg(err)}) — using in-window rarity heuristic.`);
    }
  }

  const metrics = finalize(baseline);
  const upstreamCdn = await tryResolveUpstreamCdn(metrics.topOriginHost, metrics.warnings, opts.resolveCname);
  const report = assembleReport(metrics, input, entryCount, splunkQueries, upstreamCdn);
  report.metrics.warnings.unshift(...preWarnings);
  return report;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/**
 * Best-effort DNS cross-check for a burst's cloud-ASN signal: resolves `hostname`'s CNAME chain
 * looking for a known CDN delegation (see {@link resolveUpstreamCdn}). Never throws — a DNS
 * failure (offline, no network egress from this host, NXDOMAIN, ...) just means the cross-check
 * is skipped and a warning is recorded, exactly like the POP baseline's non-fatal failure handling.
 */
async function tryResolveUpstreamCdn(
  hostname: string,
  warnings: string[],
  resolveCname?: CnameResolver
): Promise<UpstreamCdnMatch | null> {
  if (!hostname) return null;
  try {
    return await resolveUpstreamCdn(hostname, resolveCname);
  } catch (err) {
    warnings.push(`Upstream-CDN DNS cross-check for ${hostname} failed (${errMsg(err)}) — cloud-ASN traffic was not cross-referenced against the origin's own CDN.`);
    return null;
  }
}

function assembleReport(
  metrics: CdnMetrics,
  input: CdnAnalysisInput,
  entryCount: number,
  splunkQueries: string[] = [],
  upstreamCdn?: UpstreamCdnMatch | null
): CdnAnalysisReport {
  const hypotheses = classifyCacheMiss(metrics, upstreamCdn);
  const context = [
    buildDdosFinding(metrics, upstreamCdn),
    buildTtlRecommendation(metrics),
    build429Context(metrics),
    buildPass200Finding(metrics),
    buildPassErrorFinding(metrics)
  ].filter((f): f is NonNullable<typeof f> => f !== null);
  const findings = [...hypotheses, ...context];
  const verdict = hypotheses[0];

  return {
    input,
    entryCount,
    metrics,
    findings,
    verdictId: verdict?.signatureId,
    verdictName: verdict?.signatureName,
    summary: buildSummary(metrics, verdict?.signatureName, verdict?.confidence),
    splunkQueries,
    baselineUsed: metrics.baselineUsed === 1,
    generatedAt: new Date()
  };
}

function truncationWarning(maxEvents: number): string {
  return `Result hit the ${maxEvents}-event cap — analysis may be truncated. Narrow the window/URLs or raise investigator.cdn.maxEvents.`;
}

function buildSummary(m: CdnMetrics, verdictName?: string, confidence?: string): string {
  if (m.totalRequests === 0) {
    return 'No CDN log events matched the query — check the service id, time window, index/sourcetype, and URL filter.';
  }
  if (m.missCount === 0) {
    const passNote = m.passCount > 0 ? ` ${m.passCount} PASS (uncacheable) requests were seen but excluded from MISS analysis.` : '';
    return `No cache MISSes in ${m.totalRequests} events, so there is no MISS storm to attribute.${passNote}`;
  }

  const parts = [
    `${m.missCount} cache MISSes of ${m.totalRequests} events (MISS ratio ${Math.round(m.missRatio * 100)}% of MISS+HIT).`
  ];
  if (verdictName) {
    parts.push(`Most likely cause: ${verdictName} (${confidence} confidence).`);
  } else {
    parts.push('No single hypothesis met its threshold — see the per-hypothesis conditions for partial matches.');
  }
  if (m.error429Count > 0) {
    parts.push(`${m.error429Count} HTTP 429s, ${Math.round(m.missShareOf429 * 100)}% of them on MISSes.`);
  }
  return parts.join(' ');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
