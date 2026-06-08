/**
 * AEM-specific query tests using mock threads that mirror the real congestion
 * event observed on cm-p126355-e1312293-aem-publish on 2026-05-15 00:27.
 *
 * The mock data reflects the five dominant patterns found in the b2c dumps:
 *   Group A (12 threads): WAITING on Felix ServiceRegistry (OSGi cold-start latch)
 *     - A1 (5): OSGiServiceInjector → ModelAdapterFactory path
 *     - A2 (4): OSGiServiceInjector → Utils.getXFResourceTypes path
 *     - A3 (3): CommonUtils.getServiceFromBundle → ConfigurationUtils path
 *   Group B  (3 threads): TIMED_WAITING on Elasticsearch result queue
 *   Group C  (4 threads): RUNNABLE — ReactServiceImpl recursive JCR tree walk
 *   Group D  (3 threads): RUNNABLE — CFM/ConfigurationUtils per-request adaptation
 *   Group E  (3 threads): non-b2c background threads (scheduler, Felix start-level)
 *
 * Total: 25 threads (22 b2c, 3 non-b2c)
 */

import { describe, it, expect } from 'vitest';
import { executeQuery } from '../../src/query/thread-query';
import { Thread } from '../../src/types/thread';

// ── shared JVM frame prefixes ─────────────────────────────────────────────────

const JVM_PARK = [
  'jdk.internal.misc.Unsafe.park(Native Method)',
  'java.util.concurrent.locks.LockSupport.park(LockSupport.java:221)',
  'java.util.concurrent.locks.AbstractQueuedSynchronizer.acquire(AbstractQueuedSynchronizer.java:754)',
  'java.util.concurrent.locks.AbstractQueuedSynchronizer.acquireSharedInterruptibly(AbstractQueuedSynchronizer.java:1099)',
  'java.util.concurrent.CountDownLatch.await(CountDownLatch.java:230)',
  'org.apache.felix.framework.ServiceRegistry.getService(ServiceRegistry.java:380)',
  'org.apache.felix.framework.Felix.getService(Felix.java:3984)',
];

const JVM_PARK_NANOS = [
  'jdk.internal.misc.Unsafe.park(Native Method)',
  'java.util.concurrent.locks.LockSupport.parkNanos(LockSupport.java:269)',
  'java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject.awaitNanos(AbstractQueuedSynchronizer.java:1763)',
  'java.util.concurrent.LinkedBlockingQueue.poll(LinkedBlockingQueue.java:460)',
];

// ── mock thread factory ───────────────────────────────────────────────────────

function t(
  name: string,
  state: Thread['state'],
  frames: string[],
  keyFrame?: string,
): Thread {
  const kf = keyFrame ??
    frames.find(f => !f.startsWith('jdk.') && !f.startsWith('java.') && !f.startsWith('sun.')) ??
    frames[0] ?? '';
  return { name, state, frames, topFrame: frames[0] ?? '', keyFrame: kf, monitorLines: [], lockedMonitors: [] };
}

function b2c(ip: string, path: string, state: Thread['state'], frames: string[], keyFrame?: string): Thread {
  return t(`${ip} GET /content/b2c/${path} HTTP/1.1`, state, frames, keyFrame);
}

// ── Group A1: WAITING — Felix / OSGiServiceInjector → ModelAdapterFactory ────

const OSGI_INJECTOR_TAIL = [
  'org.apache.sling.models.impl.injectors.OSGiServiceInjector.getService(OSGiServiceInjector.java:124)',
  'org.apache.sling.models.impl.ModelAdapterFactory.injectElement(ModelAdapterFactory.java:535)',
  'org.apache.sling.models.impl.ModelAdapterFactory.createObject(ModelAdapterFactory.java:754)',
  'org.apache.sling.models.impl.ModelAdapterFactory.internalCreateModel(ModelAdapterFactory.java:409)',
  'com.msc.aem.core.models.MscPageImpl.init(MscPageImpl.java:105)',
];

const A1_FRAMES = [...JVM_PARK, ...OSGI_INJECTOR_TAIL];
// keyFrame = first non-JVM = ServiceRegistry.getService
const A1_KEY = 'org.apache.felix.framework.ServiceRegistry.getService(ServiceRegistry.java:380)';

// ── Group A2: WAITING — Felix / Utils.getXFResourceTypes ─────────────────────

const XF_TAIL = [
  'org.apache.sling.models.impl.injectors.OSGiServiceInjector.getService(OSGiServiceInjector.java:124)',
  'com.adobe.cq.wcm.core.components.internal.Utils.getXFResourceTypes(Utils.java:128)',
  'com.adobe.cq.wcm.core.components.internal.models.v1.PageImpl.getComponentsResourceTypes(PageImpl.java:245)',
  'com.msc.aem.core.models.MscPageImpl.getComponentsResourceTypes(MscPageImpl.java:91)',
];

const A2_FRAMES = [...JVM_PARK, ...XF_TAIL];
const A2_KEY = A1_KEY; // same first non-JVM frame

// ── Group A3: WAITING — Felix / CommonUtils.getServiceFromBundle ──────────────

const COMMON_UTILS_TAIL = [
  'org.apache.felix.framework.BundleContextImpl.getServiceReference(BundleContextImpl.java:349)',
  'com.msc.aem.core.utils.CommonUtils.getServiceFromBundle(CommonUtils.java:49)',
  'com.msc.aem.core.utils.ConfigurationUtils.getConfigurationResolver(ConfigurationUtils.java:51)',
  'com.msc.aem.core.utils.ConfigurationUtils.getB2CCommerceConfigValueMap(ConfigurationUtils.java:120)',
];

const A3_FRAMES = [...JVM_PARK, ...COMMON_UTILS_TAIL];
const A3_KEY = A1_KEY; // same first non-JVM frame

// ── Group B: TIMED_WAITING — Elasticsearch result queue ──────────────────────

const ELASTIC_FRAMES = [
  ...JVM_PARK_NANOS,
  'org.apache.jackrabbit.oak.plugins.index.elastic.query.async.ElasticResultRowAsyncIterator.hasNext(ElasticResultRowAsyncIterator.java:134)',
  'org.apache.jackrabbit.oak.plugins.index.search.spi.query.FulltextIndex$FulltextPathCursor.hasNext(FulltextIndex.java:499)',
  'org.apache.jackrabbit.oak.query.ast.SelectorImpl.nextInternal(SelectorImpl.java:529)',
  'org.apache.jackrabbit.oak.query.impl.QueryImpl.executeQuery(QueryImpl.java:315)',
  'com.msc.aem.core.utils.ContentFragmentUtils.findContentFragmentFromPortCode(ContentFragmentUtils.java:78)',
  'com.msc.aem.core.models.editorial.impl.DynamicCFPageImpl.getAlternateLanguageLinks(DynamicCFPageImpl.java:156)',
];
const B_KEY = 'org.apache.jackrabbit.oak.plugins.index.elastic.query.async.ElasticResultRowAsyncIterator.hasNext(ElasticResultRowAsyncIterator.java:134)';

// ── Group C: RUNNABLE — ReactServiceImpl recursive JCR tree walk ─────────────

const REACT_FRAMES = [
  'org.apache.jackrabbit.oak.segment.CachingSegmentReader.readNode(CachingSegmentReader.java:205)',
  'org.apache.jackrabbit.oak.segment.SegmentNodeState.getChildNode(SegmentNodeState.java:452)',
  'org.apache.jackrabbit.oak.core.MutableTree.createChild(MutableTree.java:91)',
  'org.apache.jackrabbit.oak.core.MutableTree.getChildren(MutableTree.java:178)',
  'org.apache.jackrabbit.oak.jcr.session.NodeImpl.getNodes(NodeImpl.java:577)',
  'com.adobe.cq.wcm.core.components.internal.Utils.getXFResourceTypes(Utils.java:128)',
  'com.msc.aem.core.services.impl.ReactServiceImpl.checkChildrenRecursively(ReactServiceImpl.java:210)',
  'com.msc.aem.core.services.impl.ReactServiceImpl.resolveXfAndChildren(ReactServiceImpl.java:185)',
  'com.msc.aem.core.services.impl.ReactServiceImpl.isBookingFunnelReactComponentUsed(ReactServiceImpl.java:142)',
  'com.msc.aem.core.models.MscPageImpl.addReactAppsBundles(MscPageImpl.java:289)',
  'com.msc.aem.core.models.MscPageImpl.init(MscPageImpl.java:105)',
];
const C_KEY = 'org.apache.jackrabbit.oak.segment.CachingSegmentReader.readNode(CachingSegmentReader.java:205)';

// ── Group D: RUNNABLE — CFM / ConfigurationUtils per-request adaptation ───────

const CFM_FRAMES = [
  'org.apache.jackrabbit.oak.plugins.memory.MemoryNodeBuilder.getChildNodeNames(MemoryNodeBuilder.java:307)',
  'org.apache.jackrabbit.oak.jcr.session.NodeImpl.getNodes(NodeImpl.java:577)',
  'com.adobe.cq.dam.cfm.impl.CreationHelper.readFragment(CreationHelper.java:156)',
  'com.adobe.cq.dam.cfm.impl.ModelImpl.processScaffold(ModelImpl.java:89)',
  'com.adobe.cq.dam.cfm.impl.CFMAdapterFactory.getAdapter(CFMAdapterFactory.java:67)',
  'com.msc.aem.core.utils.ContentFragmentUtils.getContentFragmentProperty(ContentFragmentUtils.java:45)',
  'com.msc.aem.core.utils.ConfigurationUtils.createShipMapping(ConfigurationUtils.java:89)',
  'com.msc.aem.core.utils.ConfigurationUtils.getB2CCommerceConfigValueMap(ConfigurationUtils.java:120)',
  'com.msc.aem.core.models.MscPageImpl.init(MscPageImpl.java:105)',
];
const D_KEY = 'org.apache.jackrabbit.oak.plugins.memory.MemoryNodeBuilder.getChildNodeNames(MemoryNodeBuilder.java:307)';

// ── Group E: non-b2c background threads ──────────────────────────────────────

const SCHEDULER_FRAMES = [
  'java.lang.Thread.sleep(Native Method)',
  'org.quartz.simpl.SimpleThreadPool$WorkerThread.run(SimpleThreadPool.java:573)',
];

const FELIX_START_FRAMES = [
  'sun.misc.Unsafe.park(Native Method)',
  'java.util.concurrent.locks.LockSupport.park(LockSupport.java:175)',
  'org.apache.felix.framework.Felix$FelixStartLevel.run(Felix.java:2840)',
  'java.lang.Thread.run(Thread.java:840)',
];

// ── Assemble mock thread pool ─────────────────────────────────────────────────

const AEM_THREADS: Thread[] = [
  // A1 — 5 WAITING / Felix / OSGiServiceInjector
  b2c('57.141.0.1',       'ch/de/stay-cruise.model.json',                      'WAITING',        A1_FRAMES, A1_KEY),
  b2c('57.141.0.2',       'de/de/angebote.html',                               'WAITING',        A1_FRAMES, A1_KEY),
  b2c('57.141.0.3',       'gb/en/destinations/asia.model.json',                'WAITING',        A1_FRAMES, A1_KEY),
  b2c('57.141.0.4',       'fr/fr/taxe-de-croisiere.html',                      'WAITING',        A1_FRAMES, A1_KEY),
  b2c('57.141.0.5',       'at/de/kreuzfahrtschiffe/msc-meraviglia.model.json', 'WAITING',        A1_FRAMES, A1_KEY),

  // A2 — 4 WAITING / Felix / getXFResourceTypes
  b2c('66.249.92.201',    'de/de/angebote.model.json',                         'WAITING',        A2_FRAMES, A2_KEY),
  b2c('66.249.92.202',    'fr/fr/ports/port-template.trondheim.html',          'WAITING',        A2_FRAMES, A2_KEY),
  b2c('66.249.92.203',    'ch/de/angebote.html',                               'WAITING',        A2_FRAMES, A2_KEY),
  b2c('66.249.92.204',    'es/es/puertos/port-template.colombo.html',          'WAITING',        A2_FRAMES, A2_KEY),

  // A3 — 3 WAITING / Felix / CommonUtils
  b2c('168.100.149.52',   'de/de/hafen/port-template.constanta.html',          'WAITING',        A3_FRAMES, A3_KEY),
  b2c('168.100.149.53',   'ch/de/hafen/port-template.southampton.html',        'WAITING',        A3_FRAMES, A3_KEY),
  b2c('168.100.149.54',   'de/de/hafen/hamburg.model.json',                    'WAITING',        A3_FRAMES, A3_KEY),

  // B — 3 TIMED_WAITING / Elasticsearch
  b2c('168.100.149.182',  'es/es/puertos/port-template.colombo.html',          'TIMED_WAITING',  ELASTIC_FRAMES, B_KEY),
  b2c('168.100.149.183',  'fr/fr/ports/port-template.kos.html',                'TIMED_WAITING',  ELASTIC_FRAMES, B_KEY),
  b2c('168.100.149.184',  'de/de/hafen/port-template.ceuta.html',              'TIMED_WAITING',  ELASTIC_FRAMES, B_KEY),

  // C — 4 RUNNABLE / ReactServiceImpl JCR walk
  b2c('52.58.146.230',    'eastmed/en/onboard/dining/sweets-ice-creams.html',  'RUNNABLE',       REACT_FRAMES, C_KEY),
  b2c('52.58.146.231',    'de/de/hafen/port-template.ceuta.html',              'RUNNABLE',       REACT_FRAMES, C_KEY),
  b2c('52.58.146.232',    'ch/fr/a-bord/spa-beaute-fitness/sport-fitness.html','RUNNABLE',       REACT_FRAMES, C_KEY),
  b2c('52.58.146.233',    'easterneurope/en/ports/port-template.fort-dauphin.html', 'RUNNABLE',  REACT_FRAMES, C_KEY),

  // D — 3 RUNNABLE / CFM adaptation
  b2c('168.100.149.83',   'easterneurope/en/ports/port-template.hanga-roa-rapa-nui.html', 'RUNNABLE', CFM_FRAMES, D_KEY),
  b2c('35.156.240.123',   'fr/fr/ports/port-template.koper.html',             'RUNNABLE',       CFM_FRAMES, D_KEY),
  b2c('2.18.240.97',      'easterneurope/en/ports/port-template.fort-dauphin.html', 'RUNNABLE', CFM_FRAMES, D_KEY),

  // E — 3 non-b2c background threads
  t('org.quartz.scheduler-1',     'TIMED_WAITING', SCHEDULER_FRAMES),
  t('org.quartz.scheduler-2',     'TIMED_WAITING', SCHEDULER_FRAMES),
  t('FelixStartLevel',            'RUNNABLE',      FELIX_START_FRAMES),
];

// ── sanity — verify dataset totals so assertions below are trustworthy ────────

const B2C_TOTAL  = 22; // groups A1+A2+A3+B+C+D
const WAITING    = 12; // A1+A2+A3
const TIMED_WAIT = 5;  // B (3) + scheduler (2)
const RUNNABLE   = 8;  // C (4) + D (3) + FelixStartLevel (1)

// ── helpers ───────────────────────────────────────────────────────────────────

function count(q: string): number {
  return executeQuery(AEM_THREADS, q).totalMatched;
}

function rows(q: string): ReturnType<typeof executeQuery>['rows'] {
  return executeQuery(AEM_THREADS, q).rows;
}

function topKeyframe(q: string): string {
  const r = rows(q);
  return String(r[0]?.keyframe ?? '');
}

// ── dataset integrity ─────────────────────────────────────────────────────────

describe('AEM mock dataset integrity', () => {
  it('has 25 threads total', () => {
    expect(AEM_THREADS).toHaveLength(25);
  });

  it(`has ${B2C_TOTAL} b2c threads`, () => {
    expect(count('thread=*b2c*')).toBe(B2C_TOTAL);
  });

  it(`has ${WAITING} WAITING threads`, () => {
    expect(count('state=WAITING')).toBe(WAITING);
  });

  it(`has ${TIMED_WAIT} TIMED_WAITING threads`, () => {
    expect(count('state=TIMED_WAITING')).toBe(TIMED_WAIT);
  });

  it(`has ${RUNNABLE} RUNNABLE threads`, () => {
    expect(count('state=RUNNABLE')).toBe(RUNNABLE);
  });
});

// ── basic b2c filtering ───────────────────────────────────────────────────────

describe('b2c thread filtering', () => {
  it('thread=*b2c* matches all b2c threads', () => {
    expect(count('thread=*b2c*')).toBe(B2C_TOTAL);
  });

  it('thread=*b2c* AND state=WAITING matches all Felix-waiting b2c threads', () => {
    expect(count('thread=*b2c* AND state=WAITING')).toBe(12);
  });

  it('thread=*b2c* AND state=TIMED_WAITING matches Elasticsearch b2c threads', () => {
    expect(count('thread=*b2c* AND state=TIMED_WAITING')).toBe(3);
  });

  it('thread=*b2c* AND state=RUNNABLE matches active b2c render threads', () => {
    expect(count('thread=*b2c* AND state=RUNNABLE')).toBe(7);
  });

  it('| where thread=*b2c* syntax works the same as AND', () => {
    expect(count('state=WAITING | where thread=*b2c*')).toBe(12);
  });

  it('multiple piped where clauses compose as AND', () => {
    const r1 = count('thread=*b2c* | where state=WAITING | where frame=*ServiceRegistry*');
    const r2 = count('thread=*b2c* AND state=WAITING AND frame=*ServiceRegistry*');
    expect(r1).toBe(r2);
    expect(r1).toBe(12);
  });

  it('state=BLOCKED returns 0 in this dataset', () => {
    expect(count('state=BLOCKED')).toBe(0);
  });
});

// ── stack frame filtering ─────────────────────────────────────────────────────

describe('frame= stack filtering', () => {
  it('frame=*ServiceRegistry* matches all Felix-waiting threads', () => {
    // A1 (5) + A2 (4) + A3 (3) = 12
    expect(count('frame=*ServiceRegistry*')).toBe(12);
  });

  it('frame=*ElasticResultRowAsyncIterator* matches only Elastic threads', () => {
    expect(count('frame=*ElasticResultRowAsyncIterator*')).toBe(3);
  });

  it('frame=*ReactServiceImpl* matches only React JCR walk threads', () => {
    expect(count('frame=*ReactServiceImpl*')).toBe(4);
  });

  it('frame=*processScaffold* matches only CFM adaptation threads', () => {
    expect(count('frame=*processScaffold*')).toBe(3);
  });

  it('frame=*CommonUtils* matches CommonUtils-path Felix threads', () => {
    // Only A3 threads have CommonUtils.getServiceFromBundle
    expect(count('frame=*CommonUtils*')).toBe(3);
  });

  it('frame=*OSGiServiceInjector* matches A1 and A2 (not A3)', () => {
    // A1 (5) + A2 (4) = 9; A3 goes via BundleContextImpl not OSGiServiceInjector
    expect(count('frame=*OSGiServiceInjector*')).toBe(9);
  });

  it('frame=*getXFResourceTypes* narrows to A2 (XF path) only', () => {
    expect(count('frame=*getXFResourceTypes*')).toBe(4 + 4); // A2 (4) + C React (4 — also has getXFResourceTypes)
  });

  it('frame=*MscPageImpl* matches A1, A2, React and CFM threads', () => {
    // A1 (5): MscPageImpl.init via OSGiServiceInjector path
    // A2 (4): MscPageImpl.getComponentsResourceTypes via XF path
    // C  (4): MscPageImpl.addReactAppsBundles + MscPageImpl.init
    // D  (3): MscPageImpl.init via CFM path
    expect(count('frame=*MscPageImpl*')).toBe(5 + 4 + 4 + 3);
  });

  it('frame=*ConfigurationUtils* matches A3 (CommonUtils path) + D (CFM path)', () => {
    // A3 has ConfigurationUtils.getConfigurationResolver
    // D has ConfigurationUtils.createShipMapping and getB2CCommerceConfigValueMap
    expect(count('frame=*ConfigurationUtils*')).toBe(3 + 3);
  });

  it('frame=*ContentFragmentUtils* matches B (Elastic) + D (CFM)', () => {
    // B has ContentFragmentUtils.findContentFragmentFromPortCode
    // D has ContentFragmentUtils.getContentFragmentProperty
    expect(count('frame=*ContentFragmentUtils*')).toBe(3 + 3);
  });

  it('non-b2c threads are excluded when frame + thread filters are combined', () => {
    expect(count('thread=*b2c* AND frame=*ServiceRegistry*')).toBe(12);
    // No non-b2c thread has ServiceRegistry, so same result
    expect(count('frame=*ServiceRegistry*')).toBe(12);
  });
});

// ── stats count (no by) ───────────────────────────────────────────────────────

describe('| stats count', () => {
  it('returns a single row with the total matched count', () => {
    const r = rows('thread=*b2c* | stats count');
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(B2C_TOTAL);
  });

  it('counts WAITING b2c threads', () => {
    const r = rows('thread=*b2c* AND state=WAITING | stats count');
    expect(r[0].count).toBe(12);
  });

  it('counts Elasticsearch b2c threads', () => {
    const r = rows('frame=*ElasticResultRowAsyncIterator* | stats count');
    expect(r[0].count).toBe(3);
  });

  it('| stats count on full set returns total thread count', () => {
    const r = rows('| stats count');
    expect(r[0].count).toBe(25);
  });

  it('totalMatched is consistent with stats count result', () => {
    const result = executeQuery(AEM_THREADS, 'thread=*b2c* AND state=WAITING | stats count');
    expect(result.totalMatched).toBe(12);
    expect(result.rows[0].count).toBe(12);
  });
});

// ── stats count by keyframe ───────────────────────────────────────────────────

describe('stats count by keyframe', () => {
  it('all WAITING b2c threads group under ServiceRegistry.getService', () => {
    const r = rows('thread=*b2c* AND state=WAITING | stats count by keyframe');
    expect(r).toHaveLength(1);
    expect(r[0].count).toBe(12);
    expect(String(r[0].keyframe)).toContain('ServiceRegistry.getService');
  });

  it('b2c threads produce 4 distinct keyframes', () => {
    // ServiceRegistry (12), ElasticResultRowAsyncIterator (3),
    // CachingSegmentReader (4), MemoryNodeBuilder (3)
    const r = rows('thread=*b2c* | stats count by keyframe');
    expect(r).toHaveLength(4);
  });

  it('ServiceRegistry keyframe has highest count among b2c threads', () => {
    const r = rows('thread=*b2c* | stats count by keyframe');
    expect(String(r[0].keyframe)).toContain('ServiceRegistry');
    expect(r[0].count).toBe(12);
  });

  it('non-WAITING b2c threads contribute distinct keyframes', () => {
    const r = rows('thread=*b2c* AND state!=WAITING | stats count by keyframe');
    // Elastic (3), React (4), CFM (3) → 3 distinct keyframes, no ServiceRegistry
    expect(r).toHaveLength(3);
    expect(r.some(row => String(row.keyframe).includes('ServiceRegistry'))).toBe(false);
  });

  it('| stats count by keyframe output is sorted by count descending', () => {
    const r = rows('| stats count by keyframe');
    for (let i = 1; i < r.length; i++) {
      expect(Number(r[i - 1].count)).toBeGreaterThanOrEqual(Number(r[i].count));
    }
  });
});

// ── stats count by state ──────────────────────────────────────────────────────

describe('stats count by state', () => {
  it('reports correct counts per state for full dataset', () => {
    const r = rows('| stats count by state');
    const find = (s: string) => Number(r.find(row => row.state === s)?.count ?? 0);
    expect(find('WAITING')).toBe(WAITING);
    expect(find('TIMED_WAITING')).toBe(TIMED_WAIT);
    expect(find('RUNNABLE')).toBe(RUNNABLE);
  });

  it('b2c threads: WAITING is the dominant state', () => {
    const r = rows('thread=*b2c* | stats count by state');
    expect(r[0].state).toBe('WAITING');
    expect(r[0].count).toBe(12);
  });

  it('frame=*ServiceRegistry* threads are all WAITING', () => {
    const r = rows('frame=*ServiceRegistry* | stats count by state');
    expect(r).toHaveLength(1);
    expect(r[0].state).toBe('WAITING');
  });
});

// ── stats count by class / package / method ───────────────────────────────────

describe('stats count by class, package, method', () => {
  it('WAITING b2c threads all share ServiceRegistry class', () => {
    const r = rows('thread=*b2c* AND state=WAITING | stats count by class');
    expect(r).toHaveLength(1);
    expect(r[0].class).toBe('org.apache.felix.framework.ServiceRegistry');
    expect(r[0].count).toBe(12);
  });

  it('WAITING b2c threads all share org.apache.felix.framework package', () => {
    const r = rows('thread=*b2c* AND state=WAITING | stats count by package');
    expect(r).toHaveLength(1);
    expect(r[0].package).toBe('org.apache.felix.framework');
  });

  it('WAITING b2c threads all share getService method', () => {
    const r = rows('thread=*b2c* AND state=WAITING | stats count by method');
    expect(r).toHaveLength(1);
    expect(r[0].method).toBe('getService');
    expect(r[0].count).toBe(12);
  });

  it('TIMED_WAITING b2c threads group under ElasticResultRowAsyncIterator class', () => {
    const r = rows('thread=*b2c* AND state=TIMED_WAITING | stats count by class');
    expect(r).toHaveLength(1);
    expect(String(r[0].class)).toContain('ElasticResultRowAsyncIterator');
  });
});

// ── top N ─────────────────────────────────────────────────────────────────────

describe('| top N', () => {
  it('top 3 limits results to 3 rows', () => {
    const r = rows('| stats count by keyframe | top 3');
    expect(r).toHaveLength(3);
  });

  it('top 1 returns the keyframe with the highest count', () => {
    const r = rows('thread=*b2c* | stats count by keyframe | top 1');
    expect(r).toHaveLength(1);
    expect(String(r[0].keyframe)).toContain('ServiceRegistry');
  });

  it('top N larger than result set returns all rows', () => {
    const r = rows('thread=*b2c* | stats count by keyframe | top 100');
    expect(r).toHaveLength(4); // only 4 distinct keyframes in b2c threads
  });
});

// ── multi-field stats ─────────────────────────────────────────────────────────

describe('stats count by multiple fields', () => {
  it('count by state, keyframe produces one row per (state, keyframe) pair', () => {
    const r = rows('thread=*b2c* | stats count by state, keyframe');
    // WAITING/ServiceRegistry (12), TIMED_WAITING/Elastic (3), RUNNABLE/CachingSegmentReader (4), RUNNABLE/MemoryNodeBuilder (3)
    expect(r).toHaveLength(4);
  });

  it('WAITING + ServiceRegistry row has count 12', () => {
    const r = rows('thread=*b2c* | stats count by state, keyframe');
    const row = r.find(x => x.state === 'WAITING');
    expect(row).toBeDefined();
    expect(row!.count).toBe(12);
    expect(String(row!.keyframe)).toContain('ServiceRegistry');
  });
});

// ── stackdepth field ──────────────────────────────────────────────────────────

describe('stackdepth field', () => {
  it('reports the number of frames in a thread row', () => {
    // A1 threads (OSGiServiceInjector + ModelAdapterFactory) have exactly 12 frames
    const r = executeQuery(AEM_THREADS, 'frame=*ModelAdapterFactory* AND state=WAITING').rows;
    expect(r).toHaveLength(5); // A1 group only
    for (const row of r) {
      expect(Number(row.stackdepth)).toBe(A1_FRAMES.length); // 12
    }
  });

  it('stackdepth>=10 matches threads with long stacks', () => {
    // A1/A2/A3 (12 frames), B (10 frames), C (11 frames) → all b2c except D (9 frames)
    const deep = count('thread=*b2c* AND stackdepth>=10');
    const shallow = count('thread=*b2c* AND stackdepth<10');
    expect(deep + shallow).toBe(B2C_TOTAL);
    expect(shallow).toBe(3); // only group D (CFM, 9 frames)
  });

  it('stackdepth<5 matches only short-stack non-b2c threads', () => {
    // scheduler (2 frames), FelixStartLevel (4 frames) → neither is b2c
    const r = executeQuery(AEM_THREADS, 'stackdepth<5');
    expect(r.rows.every(row => !String(row.thread).includes('b2c'))).toBe(true);
  });

  it('stackdepth stats count by stackdepth works as a numeric group-by', () => {
    const r = rows('thread=*b2c* | stats count by stackdepth');
    // A1=A2=A3 same depth (12), B (10), C (11), D (9)
    expect(r.length).toBeGreaterThan(1);
    const depthValues = r.map(row => Number(row.stackdepth));
    expect(depthValues.every(d => !isNaN(d))).toBe(true);
  });
});

// ── comparison operators ──────────────────────────────────────────────────────

describe('comparison operators', () => {
  it('state!=RUNNABLE excludes RUNNABLE threads', () => {
    const nonRunnable = count('state!=RUNNABLE');
    expect(nonRunnable).toBe(WAITING + TIMED_WAIT);
  });

  it('state!=WAITING excludes WAITING threads', () => {
    expect(count('state!=WAITING')).toBe(25 - WAITING);
  });

  it('stackdepth>10 matches threads with more than 10 frames', () => {
    // A1/A2/A3 have 12 frames, C has 11 frames — all >10
    const r = executeQuery(AEM_THREADS, 'stackdepth>10');
    expect(r.rows.every(row => Number(row.stackdepth) > 10)).toBe(true);
  });

  it('stackdepth<=4 matches only very shallow threads', () => {
    const r = executeQuery(AEM_THREADS, 'stackdepth<=4');
    expect(r.rows.every(row => Number(row.stackdepth) <= 4)).toBe(true);
    expect(r.totalMatched).toBeGreaterThan(0);
  });

  it('state!=RUNNABLE AND thread=*b2c* gives WAITING + TIMED_WAITING b2c', () => {
    expect(count('state!=RUNNABLE AND thread=*b2c*')).toBe(12 + 3);
  });

  it('numeric != works: stackdepth!=12 excludes all 12-frame threads', () => {
    const r = executeQuery(AEM_THREADS, 'stackdepth!=12');
    expect(r.rows.every(row => Number(row.stackdepth) !== 12)).toBe(true);
  });
});

// ── OR logic ─────────────────────────────────────────────────────────────────

describe('OR predicates', () => {
  it('WAITING OR TIMED_WAITING covers all non-RUNNABLE threads', () => {
    expect(count('state=WAITING OR state=TIMED_WAITING')).toBe(WAITING + TIMED_WAIT);
  });

  it('frame=*ReactServiceImpl* OR frame=*processScaffold* covers groups C and D', () => {
    expect(count('frame=*ReactServiceImpl* OR frame=*processScaffold*')).toBe(4 + 3);
  });
});

// ── state IN ─────────────────────────────────────────────────────────────────

describe('state IN (...)', () => {
  it('IN (WAITING, TIMED_WAITING) matches all non-RUNNABLE threads', () => {
    expect(count('state IN (WAITING, TIMED_WAITING)')).toBe(WAITING + TIMED_WAIT);
  });

  it('IN (BLOCKED) returns 0 in this dataset', () => {
    expect(count('state IN (BLOCKED)')).toBe(0);
  });
});

// ── raw row output ────────────────────────────────────────────────────────────

describe('raw row output (no stats)', () => {
  it('returns one row per matched thread', () => {
    const r = rows('thread=*b2c* AND state=WAITING');
    expect(r).toHaveLength(12);
  });

  it('row contains the expected fields', () => {
    const r = rows('thread=*b2c* AND frame=*ReactServiceImpl*');
    const row = r[0];
    expect(row).toHaveProperty('thread');
    expect(row).toHaveProperty('state');
    expect(row).toHaveProperty('keyframe');
    expect(row).toHaveProperty('topframe');
    expect(row).toHaveProperty('class');
    expect(row).toHaveProperty('package');
    expect(row).toHaveProperty('method');
    expect(row).toHaveProperty('stackdepth');
  });

  it('keyframe field is lowercase in row output', () => {
    const r = rows('thread=*b2c* AND state=WAITING');
    // key must be "keyframe" not "keyFrame" — consistent with stats output
    expect(Object.keys(r[0])).toContain('keyframe');
    expect(Object.keys(r[0])).not.toContain('keyFrame');
  });

  it('topframe field is lowercase in row output', () => {
    const r = rows('thread=*b2c*');
    expect(Object.keys(r[0])).toContain('topframe');
    expect(Object.keys(r[0])).not.toContain('topFrame');
  });

  it('keyframe value is correct for WAITING threads', () => {
    const r = rows('thread=*b2c* AND state=WAITING');
    for (const row of r) {
      expect(String(row.keyframe)).toContain('ServiceRegistry.getService');
    }
  });

  it('keyframe value is correct for Elasticsearch threads', () => {
    const r = rows('frame=*ElasticResultRowAsyncIterator*');
    for (const row of r) {
      expect(String(row.keyframe)).toContain('ElasticResultRowAsyncIterator');
    }
  });
});

// ── representative investigation queries ─────────────────────────────────────
// These mirror the exact queries you'd run when triaging the b2c congestion event.

describe('representative investigation queries', () => {
  it('Q: how many b2c threads and what states?', () => {
    const r = rows('thread=*b2c* | stats count by state');
    expect(r[0].state).toBe('WAITING');
    expect(r[0].count).toBe(12);
    expect(r.find(x => x.state === 'RUNNABLE')?.count).toBe(7);
    expect(r.find(x => x.state === 'TIMED_WAITING')?.count).toBe(3);
  });

  it('Q: what are b2c threads stuck on (top keyframes)?', () => {
    const r = rows('thread=*b2c* | stats count by keyframe | top 5');
    expect(r[0].count).toBe(12); // Felix latch is dominant
    expect(String(r[0].keyframe)).toContain('ServiceRegistry');
  });

  it('Q: which OSGi call path is most congested?', () => {
    // The three Felix paths all share the same keyframe, so differentiate by frame
    const osgi  = count('frame=*OSGiServiceInjector*');
    const cu    = count('frame=*CommonUtils*');
    expect(osgi).toBe(9);  // A1 + A2
    expect(cu).toBe(3);    // A3
  });

  it('Q: what packages do RUNNABLE b2c threads spend time in?', () => {
    const r = rows('thread=*b2c* AND state=RUNNABLE | stats count by package');
    // C threads: org.apache.jackrabbit.oak.segment
    // D threads: org.apache.jackrabbit.oak.plugins.memory
    const oakPkgs = r.filter(row => String(row.package).startsWith('org.apache.jackrabbit'));
    expect(oakPkgs.length).toBeGreaterThan(0);
    const totalRunnable = r.reduce((s, row) => s + Number(row.count), 0);
    expect(totalRunnable).toBe(7);
  });

  it('Q: are any b2c threads doing Elasticsearch queries?', () => {
    const r = rows('thread=*b2c* AND frame=*ElasticResultRowAsyncIterator* | stats count');
    expect(r[0].count).toBe(3);
  });

  it('Q: full triage summary — count by state and keyframe', () => {
    const r = rows('thread=*b2c* | stats count by state, keyframe');
    expect(r).toHaveLength(4); // 4 distinct (state, keyframe) combinations
    const waitingRow = r.find(row => row.state === 'WAITING');
    expect(waitingRow?.count).toBe(12);
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe('error handling', () => {
  it('invalid predicate returns error, not a crash', () => {
    const r = executeQuery(AEM_THREADS, 'foo!!!bar');
    expect(r.error).toBeDefined();
    expect(r.rows).toHaveLength(0);
    expect(r.totalMatched).toBe(0);
  });

  it('unknown command returns error', () => {
    const r = executeQuery(AEM_THREADS, '| sort by state');
    expect(r.error).toBeDefined();
  });

  it('numeric operator with non-numeric value returns error', () => {
    const r = executeQuery(AEM_THREADS, 'stackdepth>foo');
    expect(r.error).toBeDefined();
  });

  it('empty query returns all threads', () => {
    expect(executeQuery(AEM_THREADS, '').totalMatched).toBe(25);
  });

  it('whitespace-only query returns all threads', () => {
    expect(executeQuery(AEM_THREADS, '   ').totalMatched).toBe(25);
  });
});
