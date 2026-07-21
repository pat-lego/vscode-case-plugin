import { CdnLogEntry } from './types';

/**
 * Parses the raw stdout of `sky splunk query` into untyped result records.
 *
 * `sky splunk query` emits JSON (its own docs pipe it to `jq`). Splunk / the CLI can produce a
 * few shapes depending on version and query, so this is defensive and handles all of them:
 *
 *   - a JSON array of result objects:            `[ {...}, {...} ]`
 *   - a single object wrapping results:          `{ "results": [ {...} ] }`
 *   - newline-delimited JSON (one per line):     `{...}\n{...}` — each optionally
 *     wrapped as `{ "preview": false, "result": {...} }`
 *   - the human-readable key/value `_raw` block  (fallback — a single pasted event)
 *
 * Rows that carry a `_raw` string have it parsed and merged in to fill any absent fields.
 */
export function parseSplunkResults(raw: string): Record<string, string>[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  let rows: unknown[] | null = null;

  // 1. Whole-document JSON (array or wrapper object).
  try {
    const doc = JSON.parse(text);
    rows = coerceRows(doc);
  } catch {
    rows = null;
  }

  // 2. Newline-delimited JSON.
  if (rows === null) {
    const ndjson: unknown[] = [];
    let parsedAny = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        ndjson.push(JSON.parse(t));
        parsedAny = true;
      } catch {
        // A non-JSON line means this is not NDJSON — bail to the KV fallback.
        parsedAny = false;
        break;
      }
    }
    if (parsedAny) rows = ndjson;
  }

  // 3. KV `_raw` block fallback (single event).
  if (rows === null) {
    const kv = parseKvBlock(text);
    return Object.keys(kv).length > 0 ? [kv] : [];
  }

  return rows.map(normalizeRow).filter((r): r is Record<string, string> => r !== null);
}

/** Parses CDN log stdout into normalised, typed {@link CdnLogEntry} records. */
export function parseCdnLogs(raw: string): CdnLogEntry[] {
  return parseSplunkResults(raw).map(toEntry);
}

/**
 * Parses a single NDJSON line from a streaming `sky splunk query` response into one
 * {@link CdnLogEntry}, or null for blank lines, array delimiters, unparseable JSON, or Splunk
 * terminal/preview markers that carry no event payload (e.g. `{"preview":false,"lastrow":true}`).
 * Used by the streaming fetch path so huge responses never need to be buffered whole.
 */
export function parseResultLine(line: string): CdnLogEntry | null {
  const t = line.trim().replace(/,\s*$/, '');
  if (!t || t === '[' || t === ']') return null;

  let obj: unknown;
  try {
    obj = JSON.parse(t);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const o = obj as Record<string, unknown>;
  const hasResult = !!o.result && typeof o.result === 'object' && !Array.isArray(o.result);
  if (!hasResult && ('lastrow' in o || 'preview' in o) && !('url' in o) && !('cache_status' in o)) {
    return null; // streaming terminal / preview marker, no event
  }

  const rec = normalizeRow(obj);
  if (!rec || Object.keys(rec).length === 0) return null;
  return toEntry(rec);
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** Extracts an array of row objects from a parsed whole-document JSON value. */
function coerceRows(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.result)) return obj.result;
    if (obj.result && typeof obj.result === 'object') return [obj.result];
    return [obj];
  }
  return [];
}

/** Flattens a single row to a string/string record, unwrapping Splunk's `result` and `_raw`. */
function normalizeRow(row: unknown): Record<string, string> | null {
  if (!row || typeof row !== 'object') return null;
  let obj = row as Record<string, unknown>;

  // Streaming export rows wrap the event under `result`.
  if (obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)) {
    obj = obj.result as Record<string, unknown>;
  }

  const rec: Record<string, string> = {};

  // Merge fields carried inside `_raw` first, so explicit columns win over them. `_raw` is either
  // the human-readable `key: value` block Splunk renders, or — for JSON-formatted log sources
  // (e.g. this Fastly/Skyline feed) — the original event re-encoded as a JSON object string.
  if (typeof obj._raw === 'string') {
    Object.assign(rec, parseRawField(obj._raw));
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === '_raw') continue;
    if (v === null || v === undefined) continue;
    rec[k] = typeof v === 'string' ? v : String(v);
  }

  return rec;
}

/**
 * Parses a Splunk `_raw` field, which is either a JSON object (common for JSON-formatted log
 * sources — the whole event re-encoded as a single-line JSON string) or the human-readable
 * multi-line `key: value` block Splunk renders otherwise. Tries JSON first since a KV-block parse
 * of compact JSON text would find no `key: value` lines and silently return nothing.
 */
export function parseRawField(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return flattenJson(parsed as Record<string, unknown>);
      }
    } catch {
      // Not actually JSON (e.g. a KV block that happens to start with the `{ [-]` collapse
      // marker) — fall through to KV parsing below.
    }
  }
  return parseKvBlock(raw);
}

/**
 * Flattens a JSON object to a flat string/string record, dot-joining nested object keys (e.g.
 * `{ xdata: { request_via: "..." } }` becomes `{ "xdata.request_via": "..." }`) so nested fields
 * (this feed nests a handful of fields, e.g. under `xdata`) survive instead of being lost to a
 * `[object Object]` stringification. Arrays are stringified as-is (none of the fields this module
 * reasons over are arrays).
 */
function flattenJson(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(rec, flattenJson(v as Record<string, unknown>, key));
    } else {
      rec[key] = typeof v === 'string' ? v : String(v);
    }
  }
  return rec;
}

/**
 * Parses the multi-line `key: value` block that Splunk renders for `_raw`. Skips the
 * `{ [-]` / `{ [+]` / `}` collapse markers and tolerates empty values.
 */
export function parseKvBlock(block: string): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '}' || line.startsWith('{')) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    // A value of "{ [+]" / "{ [-]" indicates a nested/collapsed object — store as empty.
    rec[key] = value.startsWith('{') ? '' : value;
  }
  return rec;
}

/** Maps a raw record to a typed {@link CdnLogEntry}. */
function toEntry(rec: Record<string, string>): CdnLogEntry {
  return {
    url: rec.url ?? '',
    cacheStatus: (rec.cache_status ?? '').trim().toUpperCase(),
    fastlyState: (rec.fastly_info_state ?? '').trim().toUpperCase(),
    xCache: (rec.response_x_cache ?? '').trim().toUpperCase(),
    status: toNum(rec.status),
    originStatus: toNum(rec.origin_status),
    pop: (rec.server_datacenter ?? '').trim(),
    region: (rec.server_region ?? '').trim(),
    serverHostname: (rec.server_hostname ?? '').trim(),
    botName: (rec.bot_name ?? '').trim(),
    userAgent: rec.request_user_agent ?? '',
    clientIp: (rec.client_ip ?? '').trim(),
    clientAsNumber: (rec.client_as_number ?? '').trim(),
    clientAsName: (rec.client_as_name ?? '').trim(),
    responseAge: toNum(rec.response_age),
    responseTtl: toNum(rec.response_ttl),
    isCacheable: toBool(rec.is_cacheable),
    fetchAction: (rec.fetch_action ?? '').trim(),
    cacheLocation: (rec.cache_location ?? '').trim(),
    shieldingUsed: toBool(rec.shielding_used),
    contentType: (rec.content_type ?? '').trim(),
    fetchSurrogateControl: rec.fetch_surrogate_control ?? '',
    fetchCacheControl: rec.fetch_cache_control ?? '',
    ddosAction: (rec.ddos_action ?? '').trim(),
    ddosRule: (rec.ddos_rule ?? '').trim(),
    maliciousFlags: (rec.malicious_flags ?? '').trim(),
    denyReason: (rec.deny_reason ?? '').trim(),
    geoCountryCode: (rec.geo_country_code ?? '').trim(),
    aemService: (rec.aem_service ?? '').trim(),
    originHost: (rec.origin_host ?? '').trim(),
    originalXForwardedFor: (rec.original_x_forwarded_for ?? '').trim(),
    requestVia: (rec['xdata.request_via'] ?? rec.request_via ?? '').trim(),
    responseVary: (rec.response_vary ?? '').trim(),
    timeStart: toDate(rec.time_start),
    raw: rec
  };
}

function toNum(v: string | undefined): number {
  if (v === undefined || v === '') return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function toBool(v: string | undefined): boolean {
  return /^(true|1|yes)$/i.test((v ?? '').trim());
}

function toDate(v: string | undefined): Date | undefined {
  const s = (v ?? '').trim();
  if (!s) return undefined;

  // Pure epoch (seconds or milliseconds).
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const d = new Date(s.length > 10 ? n : n * 1000);
    return isNaN(d.getTime()) ? undefined : d;
  }

  // Fastly renders "2026-07-16T03:40:00GMT" — normalise the trailing GMT to a Z offset.
  const normalized = s.replace(/GMT$/, 'Z');
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? undefined : d;
}
