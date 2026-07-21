import { describe, it, expect } from 'vitest';
import { parseCdnLogs, parseSplunkResults, parseKvBlock, parseResultLine } from '../../src/cdn/parser';

// ── JSON array ──────────────────────────────────────────────────────────────────

describe('parseCdnLogs — JSON array', () => {
  const raw = JSON.stringify([
    { url: '/a', cache_status: 'miss', status: '200', is_cacheable: 'true', response_ttl: '122.795', server_datacenter: 'BMA' },
    { url: '/b', cache_status: 'PASS', status: '200', is_cacheable: 'false', server_datacenter: 'FRA' }
  ]);
  const entries = parseCdnLogs(raw);

  it('parses both rows', () => {
    expect(entries).toHaveLength(2);
  });

  it('upper-cases the cache status', () => {
    expect(entries[0].cacheStatus).toBe('MISS');
    expect(entries[1].cacheStatus).toBe('PASS');
  });

  it('coerces numbers and booleans', () => {
    expect(entries[0].status).toBe(200);
    expect(entries[0].responseTtl).toBeCloseTo(122.795, 3);
    expect(entries[0].isCacheable).toBe(true);
    expect(entries[1].isCacheable).toBe(false);
  });

  it('maps POP from server_datacenter', () => {
    expect(entries[0].pop).toBe('BMA');
  });
});

// ── Wrapper objects ─────────────────────────────────────────────────────────────

describe('parseSplunkResults — wrapper shapes', () => {
  it('unwraps a { results: [...] } document', () => {
    const raw = JSON.stringify({ results: [{ url: '/a' }, { url: '/b' }], fields: ['url'] });
    expect(parseSplunkResults(raw)).toHaveLength(2);
  });

  it('unwraps NDJSON with { result: {...} } lines', () => {
    const raw = [
      JSON.stringify({ preview: false, offset: 0, result: { url: '/a', cache_status: 'MISS' } }),
      JSON.stringify({ preview: false, offset: 1, result: { url: '/b', cache_status: 'HIT' } })
    ].join('\n');
    const rows = parseSplunkResults(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0].url).toBe('/a');
    expect(rows[1].cache_status).toBe('HIT');
  });

  it('returns [] for empty input', () => {
    expect(parseSplunkResults('   ')).toEqual([]);
  });
});

// ── KV _raw block fallback ──────────────────────────────────────────────────────

const KV_SAMPLE = `{ [-]
   aem_service: cm-p53812-e590634
   bot_name: Generic Bot
   cache_status: PASS
   client_as_number: 1299
   content_type: text/html;charset=utf-8
   is_cacheable: false
   origin_status: 200
   response_ttl: 122.795
   response_x_cache: MISS
   server_datacenter: BMA
   shielding_used: false
   status: 200
   time_start: 2026-07-16T03:40:00GMT
   url: /apac/galaxy/zh_tw/?page=3
   xdata: { [+]
   }
}`;

describe('parseCdnLogs — KV _raw fallback', () => {
  const entries = parseCdnLogs(KV_SAMPLE);

  it('parses the single event', () => {
    expect(entries).toHaveLength(1);
  });

  it('extracts the url and distinguishes cache_status (PASS) from x-cache (MISS)', () => {
    expect(entries[0].url).toBe('/apac/galaxy/zh_tw/?page=3');
    expect(entries[0].cacheStatus).toBe('PASS');
    expect(entries[0].xCache).toBe('MISS');
  });

  it('parses the Fastly GMT timestamp', () => {
    expect(entries[0].timeStart).toBeInstanceOf(Date);
    expect(isNaN(entries[0].timeStart!.getTime())).toBe(false);
  });

  it('captures bot, cacheability and shielding', () => {
    expect(entries[0].botName).toBe('Generic Bot');
    expect(entries[0].isCacheable).toBe(false);
    expect(entries[0].shieldingUsed).toBe(false);
  });

  it('skips the collapsed { [+] } nested marker', () => {
    const rec = parseKvBlock(KV_SAMPLE);
    expect(rec.xdata).toBe('');
    expect(rec.url).toBe('/apac/galaxy/zh_tw/?page=3');
  });
});

// ── _raw carried inside a JSON row ──────────────────────────────────────────────

// ── Streaming NDJSON line parser ────────────────────────────────────────────────

describe('parseResultLine (streaming)', () => {
  it('parses a streaming result line and unwraps .result', () => {
    const e = parseResultLine('{"preview":false,"offset":0,"result":{"url":"/a","cache_status":"miss","server_datacenter":"BMA"}}');
    expect(e).not.toBeNull();
    expect(e!.url).toBe('/a');
    expect(e!.cacheStatus).toBe('MISS');
    expect(e!.pop).toBe('BMA');
  });

  it('parses a bare direct event line', () => {
    const e = parseResultLine('{"url":"/b","cache_status":"HIT"}');
    expect(e!.url).toBe('/b');
    expect(e!.cacheStatus).toBe('HIT');
  });

  it('tolerates a trailing comma (pretty-printed array element)', () => {
    const e = parseResultLine('{"url":"/c","cache_status":"MISS"},');
    expect(e!.url).toBe('/c');
  });

  it('returns null for terminal / preview markers with no payload', () => {
    expect(parseResultLine('{"preview":false,"lastrow":true}')).toBeNull();
    expect(parseResultLine('{"preview":true}')).toBeNull();
  });

  it('returns null for blanks, array delimiters and garbage', () => {
    expect(parseResultLine('')).toBeNull();
    expect(parseResultLine('   ')).toBeNull();
    expect(parseResultLine('[')).toBeNull();
    expect(parseResultLine(']')).toBeNull();
    expect(parseResultLine('not json')).toBeNull();
  });
});

describe('parseCdnLogs — _raw merged into a JSON row', () => {
  it('fills fields from _raw, with explicit columns taking precedence', () => {
    const raw = JSON.stringify([
      { url: '/explicit', _raw: 'url: /fromraw\ncache_status: MISS\nserver_datacenter: FRA' }
    ]);
    const entries = parseCdnLogs(raw);
    expect(entries[0].url).toBe('/explicit');    // column wins
    expect(entries[0].pop).toBe('FRA');          // filled from _raw
    expect(entries[0].cacheStatus).toBe('MISS'); // filled from _raw
  });
});
