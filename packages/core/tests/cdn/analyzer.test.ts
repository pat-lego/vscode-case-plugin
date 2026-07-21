import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { analyzeCdnCacheMisses, analyzeCdnEntries, analyzeCdnText, analyzeCdnFile } from '../../src/cdn/analyzer';
import { CdnAnalysisInput, CdnFetchOptions, SplunkRunner } from '../../src/cdn/types';
import { CnameResolver } from '../../src/cdn/upstream-cdn';
import { botColdPopEntries, uniqueUrlBurstEntries, cloudBurstEntries, toRaw } from './helpers';

const INPUT: CdnAnalysisInput = {
  service: 'cm-p53812-e590634',
  from: '2026-07-16T03:30:00Z',
  to: '2026-07-16T04:00:00Z',
  urls: ['/crawl/*']
};

const incidentJson = JSON.stringify(botColdPopEntries(50, 3, 'XYZ').map(toRaw));
const baselineJson = JSON.stringify([
  { server_datacenter: 'BMA', count: '120000' },
  { server_datacenter: 'FRA', count: '79950' },
  { server_datacenter: 'XYZ', count: '50' }
]);

// No-CNAME fake resolver — keeps these tests off the network and deterministic; the DNS
// cross-check itself is covered separately in upstream-cdn.test.ts and classifier.test.ts.
const noCname: CnameResolver = async () => { throw new Error('no CNAME record'); };

function makeOpts(runner: SplunkRunner, extra: Partial<CdnFetchOptions> = {}): CdnFetchOptions {
  return { index: 'dx_aem_engineering', sourcetype: 'cdn', runner, resolveCname: noCname, ...extra };
}

describe('analyzeCdnCacheMisses — end to end (mock runner)', () => {
  it('fetches incident + baseline and reaches the bot-cold-pop verdict', async () => {
    const seen: string[] = [];
    const runner: SplunkRunner = async spl => {
      seen.push(spl);
      return spl.includes('stats count by server_datacenter') ? baselineJson : incidentJson;
    };

    const report = await analyzeCdnCacheMisses(INPUT, makeOpts(runner));

    expect(report.entryCount).toBe(150);
    expect(report.verdictId).toBe('cdn-bot-cold-pop');
    expect(report.baselineUsed).toBe(true);
    expect(report.summary).toMatch(/likely cause/i);
    // incident query carries the service + field projection; a baseline query was also run
    expect(seen.some(s => s.includes('aem_service="cm-p53812-e590634"') && s.includes('| fields'))).toBe(true);
    expect(seen.some(s => s.includes('stats count by server_datacenter'))).toBe(true);
  });

  it('degrades gracefully when the baseline query fails', async () => {
    const runner: SplunkRunner = async spl => {
      if (spl.includes('stats count by server_datacenter')) throw new Error('splunk baseline boom');
      return incidentJson;
    };

    const report = await analyzeCdnCacheMisses(INPUT, makeOpts(runner));

    expect(report.entryCount).toBe(150);
    expect(report.baselineUsed).toBe(false);
    expect(report.metrics.warnings.join(' ')).toMatch(/baseline/i);
  });

  it('skips the baseline query when baseline is disabled', async () => {
    const seen: string[] = [];
    const runner: SplunkRunner = async spl => {
      seen.push(spl);
      return incidentJson;
    };

    await analyzeCdnCacheMisses(INPUT, makeOpts(runner, { baseline: false }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('stats count by server_datacenter');
  });

  it('reports an empty result cleanly', async () => {
    const runner: SplunkRunner = async () => '[]';
    const report = await analyzeCdnCacheMisses(INPUT, makeOpts(runner));
    expect(report.entryCount).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.summary).toMatch(/no cdn log events/i);
  });
});

describe('analyzeCdnEntries — pure path', () => {
  it('classifies already-fetched entries without any fetching', () => {
    const report = analyzeCdnEntries(uniqueUrlBurstEntries(200), INPUT);
    expect(report.verdictId).toBe('cdn-unique-url-burst');
    expect(report.entryCount).toBe(200);
  });
});

describe('analyzeCdnText — offline pasted export', () => {
  it('analyses NDJSON (streaming result lines)', async () => {
    const ndjson = uniqueUrlBurstEntries(200)
      .map(e => JSON.stringify({ preview: false, result: toRaw(e) }))
      .join('\n');
    const report = await analyzeCdnText(ndjson, INPUT, undefined, noCname);
    expect(report.entryCount).toBe(200);
    expect(report.verdictId).toBe('cdn-unique-url-burst');
  });

  it('analyses a JSON array export', async () => {
    const arr = JSON.stringify(uniqueUrlBurstEntries(120).map(toRaw));
    const report = await analyzeCdnText(arr, INPUT, undefined, noCname);
    expect(report.entryCount).toBe(120);
    expect(report.verdictId).toBe('cdn-unique-url-burst');
  });
});

describe('analyzeCdnText — upstream-CDN DDoS false positive', () => {
  // Reproduces a real incident: www.macnica.com is fronted by Akamai (CNAME -> ...edgekey.net),
  // so origin-fetch traffic from Akamai's ASN is expected, not a botnet — the classifier must
  // rule this out once DNS confirms Akamai is the origin's own CDN, per the same shape of burst
  // `cloudBurstEntries()` already uses to exercise the (still-valid) genuine cloud-ASN case.
  const macnicaEntries = () => cloudBurstEntries().map(e => ({ ...e, originHost: 'www.macnica.com' }));
  const akamaiDns: CnameResolver = async host =>
    host === 'www.macnica.com' ? ['www.macnica.com.edgekey.net'] : Promise.reject(new Error('no CNAME record'));

  it('suppresses the DDoS finding when the flagged ASN matches the origin\'s own DNS-confirmed CDN', async () => {
    const report = await analyzeCdnText(JSON.stringify(macnicaEntries().map(toRaw)), INPUT, undefined, akamaiDns);
    expect(report.findings.find(f => f.signatureId === 'cdn-ddos-pattern')).toBeUndefined();
  });

  it('still flags the burst when DNS does not confirm a matching upstream CDN', async () => {
    const report = await analyzeCdnText(JSON.stringify(macnicaEntries().map(toRaw)), INPUT, undefined, noCname);
    const f = report.findings.find(fnd => fnd.signatureId === 'cdn-ddos-pattern');
    expect(f).toBeDefined();
    expect(f!.evidence.join(' ').toLowerCase()).toContain('akamai');
  });
});

describe('analyzeCdnFile — offline saved export', () => {
  it('streams an NDJSON export file', async () => {
    const file = path.join(tmpdir(), `cdn-ndjson-${Date.now()}.json`);
    const ndjson = botColdPopEntries(50, 3, 'XYZ')
      .map(e => JSON.stringify({ preview: false, result: toRaw(e) }))
      .join('\n');
    writeFileSync(file, ndjson, 'utf-8');
    try {
      const report = await analyzeCdnFile(file, INPUT, undefined, noCname); // no baseline offline -> in-window rarity
      expect(report.entryCount).toBe(150);
      expect(report.metrics.botMissShare).toBe(1);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('falls back to whole-file parse for a JSON array export', async () => {
    const file = path.join(tmpdir(), `cdn-array-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(uniqueUrlBurstEntries(80).map(toRaw)), 'utf-8');
    try {
      const report = await analyzeCdnFile(file, INPUT, undefined, noCname);
      expect(report.entryCount).toBe(80);
      expect(report.verdictId).toBe('cdn-unique-url-burst');
    } finally {
      rmSync(file, { force: true });
    }
  });
});
