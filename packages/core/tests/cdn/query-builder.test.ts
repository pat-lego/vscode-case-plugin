import { describe, it, expect } from 'vitest';
import {
  buildIncidentQuery,
  buildBaselineQuery,
  toSplunkTime,
  toEpochSeconds,
  isRelativeModifier,
  clampBaselineDays,
  escapeSplunkValue,
  CDN_FIELDS
} from '../../src/cdn/query-builder';
import { CdnAnalysisInput, CdnFetchOptions } from '../../src/cdn/types';

const OPTS: CdnFetchOptions = { index: 'dx_aem_engineering', sourcetype: 'cdn', maxEvents: 5000 };
const INPUT: CdnAnalysisInput = {
  service: 'cm-p53812-e590634',
  from: '2026-07-16T03:30:00Z',
  to: '2026-07-16T04:00:00Z',
  urls: ['/apac/*', '/products/x"y']
};

describe('buildIncidentQuery', () => {
  const spl = buildIncidentQuery(INPUT, OPTS);

  it('includes index, sourcetype and service filter', () => {
    expect(spl).toContain('index=dx_aem_engineering');
    expect(spl).toContain('sourcetype=cdn');
    expect(spl).toContain('aem_service="cm-p53812-e590634"');
  });

  it('converts absolute times to epoch seconds', () => {
    const from = Math.floor(Date.parse('2026-07-16T03:30:00Z') / 1000);
    const to = Math.floor(Date.parse('2026-07-16T04:00:00Z') / 1000);
    expect(spl).toContain(`earliest=${from}`);
    expect(spl).toContain(`latest=${to}`);
  });

  it('builds an OR url clause and escapes embedded quotes', () => {
    expect(spl).toContain('(url="/apac/*" OR url="/products/x\\"y")');
  });

  it('projects only the CDN fields and caps rows', () => {
    expect(spl).toContain(`| fields ${CDN_FIELDS.join(' ')}`);
    expect(spl).toContain('| head 5000');
  });

  it('scopes to the tier, defaulting to publish', () => {
    expect(spl).toContain('aem_tier="publish"');
  });

  it('omits the url clause when no urls are given', () => {
    const noUrls = buildIncidentQuery({ ...INPUT, urls: [] }, OPTS);
    expect(noUrls).not.toContain('url=');
  });

  it('sorts the FULL result set chronologically before fields/head — order matters for cold-fetch/burst timing', () => {
    // `sort 0` (not bare `sort`) is required: `sort`'s default cap is only the first 10,000 rows,
    // which would silently leave the tail of a large maxEvents result unsorted.
    expect(spl).toContain('| sort 0 +_time |');
    const sortIdx = spl.indexOf('| sort 0 +_time');
    const fieldsIdx = spl.indexOf('| fields');
    const headIdx = spl.indexOf('| head');
    expect(sortIdx).toBeGreaterThan(-1);
    expect(sortIdx).toBeLessThan(fieldsIdx);
    expect(fieldsIdx).toBeLessThan(headIdx);
  });
});

describe('buildIncidentQuery — tier + optional sourcetype', () => {
  it('honours an explicit author tier', () => {
    const spl = buildIncidentQuery({ ...INPUT, tier: 'author' }, OPTS);
    expect(spl).toContain('aem_tier="author"');
    expect(spl).not.toContain('aem_tier="publish"');
  });

  it('includes the sourcetype clause when configured', () => {
    const spl = buildIncidentQuery(INPUT, { ...OPTS, sourcetype: 'aem_cdn' });
    expect(spl).toContain('sourcetype=aem_cdn');
  });

  it('omits the sourcetype clause when empty (index alone scopes the data)', () => {
    const spl = buildIncidentQuery(INPUT, { index: 'dx_aem_edge_prod' });
    expect(spl).not.toContain('sourcetype=');
    expect(spl).toContain('index=dx_aem_edge_prod');
  });
});

describe('buildBaselineQuery', () => {
  it('aggregates POP counts and ends at the incident start, 2 days back', () => {
    const spl = buildBaselineQuery(INPUT, { ...OPTS, baselineDays: 2 });
    const start = Math.floor(Date.parse('2026-07-16T03:30:00Z') / 1000);
    expect(spl).toContain('| stats count by server_datacenter');
    expect(spl).toContain(`latest=${start}`);
    expect(spl).toContain(`earliest=${start - 2 * 86400}`);
  });

  it('clamps baseline look-back to a maximum of 2 days', () => {
    const spl = buildBaselineQuery(INPUT, { ...OPTS, baselineDays: 30 });
    const start = Math.floor(Date.parse('2026-07-16T03:30:00Z') / 1000);
    expect(spl).toContain(`earliest=${start - 2 * 86400}`);
  });

  it('uses a relative earliest when the incident start is relative', () => {
    const spl = buildBaselineQuery({ ...INPUT, from: '-60m@m' }, OPTS);
    expect(spl).toContain('earliest=-2d');
    expect(spl).toContain('latest=-60m@m');
  });
});

describe('time helpers', () => {
  it('passes relative modifiers through unchanged', () => {
    expect(toSplunkTime('-60m@m')).toBe('-60m@m');
    expect(isRelativeModifier('-2h')).toBe(true);
    expect(isRelativeModifier('@d')).toBe(true);
    expect(isRelativeModifier('now')).toBe(true);
  });

  it('recognises absolute times as non-relative and converts them', () => {
    expect(isRelativeModifier('2026-07-16T03:30:00Z')).toBe(false);
    expect(toEpochSeconds('2026-07-16T03:30:00Z')).toBe(Math.floor(Date.parse('2026-07-16T03:30:00Z') / 1000));
  });

  it('accepts epoch input', () => {
    expect(toEpochSeconds('1752637800')).toBe(1752637800);
    expect(toSplunkTime('1752637800')).toBe('1752637800');
  });

  it('clampBaselineDays enforces [1,2] with a default of 2', () => {
    expect(clampBaselineDays(undefined)).toBe(2);
    expect(clampBaselineDays(1)).toBe(1);
    expect(clampBaselineDays(99)).toBe(2);
  });
});

describe('escapeSplunkValue', () => {
  it('escapes quotes and backslashes and strips newlines', () => {
    expect(escapeSplunkValue('a"b')).toBe('a\\"b');
    expect(escapeSplunkValue('a\\b')).toBe('a\\\\b');
    expect(escapeSplunkValue('a\nb')).toBe('a b');
  });
});
