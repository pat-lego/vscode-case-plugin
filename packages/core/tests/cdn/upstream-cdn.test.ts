import { describe, it, expect } from 'vitest';
import { resolveUpstreamCdn, nameMatchesProvider, CnameResolver } from '../../src/cdn/upstream-cdn';

describe('resolveUpstreamCdn', () => {
  it('matches Akamai after one CNAME hop (edgekey.net)', async () => {
    const resolveCname: CnameResolver = async host =>
      host === 'www.macnica.com' ? ['www.macnica.com.edgekey.net'] : Promise.reject(new Error('NXDOMAIN'));

    const match = await resolveUpstreamCdn('www.macnica.com', resolveCname);
    expect(match).not.toBeNull();
    expect(match!.provider).toBe('akamai');
    expect(match!.hostname).toBe('www.macnica.com');
    expect(match!.chain).toEqual(['www.macnica.com.edgekey.net']);
  });

  it('walks a multi-hop chain to a known suffix (edgekey.net -> akamaiedge.net)', async () => {
    const resolveCname: CnameResolver = async host => {
      if (host === 'shop.example.com') return ['shop.example.com.edgekey.net'];
      if (host === 'shop.example.com.edgekey.net') return ['e123.a.akamaiedge.net'];
      throw new Error('NXDOMAIN');
    };

    const match = await resolveUpstreamCdn('shop.example.com', resolveCname);
    expect(match!.provider).toBe('akamai');
    expect(match!.chain).toEqual(['shop.example.com.edgekey.net']); // matched at the first known hop
  });

  it('matches Cloudflare, Fastly, and CloudFront delegations', async () => {
    const cases: Array<[string, string]> = [
      ['foo.cdn.cloudflare.net', 'cloudflare'],
      ['foo.fastly.net', 'fastly'],
      ['d111111abcdef8.cloudfront.net', 'amazon']
    ];
    for (const [target, provider] of cases) {
      const resolveCname: CnameResolver = async () => [target];
      const match = await resolveUpstreamCdn('www.example.com', resolveCname);
      expect(match?.provider).toBe(provider);
    }
  });

  it('returns null when there is no CNAME (an A record origin, e.g. self-hosted)', async () => {
    const resolveCname: CnameResolver = async () => { throw new Error('ENODATA'); };
    expect(await resolveUpstreamCdn('www.example.com', resolveCname)).toBeNull();
  });

  it('returns null when the CNAME chain never reaches a known CDN', async () => {
    const resolveCname: CnameResolver = async host =>
      host === 'www.example.com' ? ['internal-lb.corp-network.example'] : Promise.reject(new Error('ENODATA'));
    expect(await resolveUpstreamCdn('www.example.com', resolveCname)).toBeNull();
  });

  it('returns null for a blank hostname without calling the resolver', async () => {
    let called = false;
    const resolveCname: CnameResolver = async () => { called = true; return []; };
    expect(await resolveUpstreamCdn('', resolveCname)).toBeNull();
    expect(called).toBe(false);
  });

  it('gives up after a bounded number of hops rather than looping forever', async () => {
    let hops = 0;
    const resolveCname: CnameResolver = async () => { hops++; return [`hop-${hops}.corp-network.example`]; };
    const match = await resolveUpstreamCdn('www.example.com', resolveCname);
    expect(match).toBeNull();
    expect(hops).toBeLessThanOrEqual(10);
  });
});

describe('nameMatchesProvider', () => {
  it('matches the provider keyword as a whole word, case-insensitively', () => {
    expect(nameMatchesProvider('akamai international b.v.', 'akamai')).toBe(true);
    expect(nameMatchesProvider('AKAMAI TECHNOLOGIES INC', 'akamai')).toBe(true);
    expect(nameMatchesProvider('comcast cable', 'akamai')).toBe(false);
  });

  it('does not match a provider keyword as a substring of an unrelated word', () => {
    // Guards against a naive substring match treating "fastlyworld" as containing "fastly".
    expect(nameMatchesProvider('fastlyworld networks', 'fastly')).toBe(false);
  });
});
