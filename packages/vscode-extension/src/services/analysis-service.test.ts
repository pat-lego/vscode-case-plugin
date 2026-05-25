import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectEvidenceType, extractTimestamp, AnalysisService } from './analysis-service';

// ── detectEvidenceType ──────────────────────────────────────────────────────

describe('detectEvidenceType', () => {
  it('identifies screenshots by extension', () => {
    expect(detectEvidenceType('screenshot-123.png', '')).toBe('screenshot');
    expect(detectEvidenceType('capture.jpg', '')).toBe('screenshot');
    expect(detectEvidenceType('img.jpeg', '')).toBe('screenshot');
    expect(detectEvidenceType('img.gif', '')).toBe('screenshot');
  });

  it('identifies thread dumps by filename keywords', () => {
    expect(detectEvidenceType('threaddump-1.txt', '')).toBe('thread-dump');
    expect(detectEvidenceType('thread-dump.txt', '')).toBe('thread-dump');
    expect(detectEvidenceType('thread_dump.log', '')).toBe('thread-dump');
    expect(detectEvidenceType('app.tdump', '')).toBe('thread-dump');
  });

  it('identifies thread dumps by jstack content', () => {
    const jstackContent = '"main" #1 prio=5 os_prio=0 tid=0x1 nid=0x1 in Object.wait()\n   java.lang.Thread.State: WAITING';
    expect(detectEvidenceType('dump.log', jstackContent)).toBe('thread-dump');
  });

  it('identifies thread dumps by IBM J9 content', () => {
    const ibmContent = '3XMTHREADINFO "main" J9VMThread:0x1';
    expect(detectEvidenceType('dump.log', ibmContent)).toBe('thread-dump');
  });

  it('identifies top output by content', () => {
    expect(detectEvidenceType('top.txt', 'top - 10:00:00 up 1 day, load average: 0.1')).toBe('top-output');
  });

  it('falls back to log-export for unknown content', () => {
    expect(detectEvidenceType('output.log', 'some random log line')).toBe('log-export');
    expect(detectEvidenceType('data.txt', '')).toBe('log-export');
  });
});

// ── extractTimestamp ────────────────────────────────────────────────────────

describe('extractTimestamp', () => {
  it('parses jstack timestamp at line start', () => {
    const content = '2024-01-15 14:32:45\n"main" #1 prio=5';
    const result = extractTimestamp(content);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(15);
  });

  it('parses IBM J9 timestamp', () => {
    const content = '1TIDATETIME    Date: 2024/03/20 at 08:15:30:000';
    const result = extractTimestamp(content);
    expect(result.getFullYear()).toBe(2024);
    expect(result.getMonth()).toBe(2); // March
    expect(result.getDate()).toBe(20);
  });

  it('returns current time when no timestamp found', () => {
    const before = Date.now();
    const result = extractTimestamp('no timestamp here');
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(Date.now() + 10);
  });
});

// ── AnalysisService.processEvidence ────────────────────────────────────────

vi.mock('vscode', () => import('./__mocks__/vscode'));

describe('AnalysisService.processEvidence', () => {
  let caseManager: ReturnType<typeof makeCaseManagerMock>;
  let signatureService: { getAll: ReturnType<typeof vi.fn> };
  let service: AnalysisService;

  function makeCaseManagerMock() {
    const evidence: unknown[] = [];
    return {
      getSession: vi.fn().mockReturnValue({ threadDumpSignals: [], findings: [] }),
      addEvidence: vi.fn().mockImplementation((_id: string, item: unknown) => evidence.push(item)),
      updateFindings: vi.fn(),
      evidence,
    };
  }

  beforeEach(() => {
    caseManager = makeCaseManagerMock();
    signatureService = { getAll: vi.fn().mockReturnValue([]) };
    service = new AnalysisService(caseManager as never, signatureService as never);
  });

  it('adds a screenshot evidence item without rawContent', () => {
    const { evidenceItem } = service.processEvidence('case-1', 'screenshot-123.png', '', '/tmp/screenshot-123.png');

    expect(evidenceItem.type).toBe('screenshot');
    expect(evidenceItem.filePath).toBe('/tmp/screenshot-123.png');
    expect(evidenceItem.rawContent).toBeUndefined();
    expect(caseManager.addEvidence).toHaveBeenCalledWith('case-1', evidenceItem, undefined);
  });

  it('adds a text capture with rawContent', () => {
    const content = 'some log line\nanother line';
    const { evidenceItem } = service.processEvidence('case-1', 'capture.log', content, '');

    expect(evidenceItem.type).toBe('log-export');
    expect(evidenceItem.rawContent).toBe(content);
    expect(evidenceItem.filePath).toBe('');
  });

  it('returns empty findings when no thread dumps present', () => {
    const { findings } = service.processEvidence('case-1', 'screenshot.png', '', '/tmp/s.png');
    expect(findings).toEqual([]);
  });

  it('runs signature matching when thread dump signals exist', async () => {
    // Use a real parsed signal rather than a handcrafted stub so extractSignals is satisfied.
    const { parseThreadDump } = await import('@incident-investigator/core');
    const jstack = [
      '2024-01-15 14:32:45',
      '"main" #1 prio=5 os_prio=0 tid=0x1 nid=0x1 in Object.wait() [0x1]',
      '   java.lang.Thread.State: WAITING (on object monitor)',
      '\tat java.lang.Object.wait(Native Method)',
    ].join('\n');
    const signal = parseThreadDump(jstack, new Date('2024-01-15T14:32:45'));
    caseManager.getSession.mockReturnValue({ threadDumpSignals: [signal], findings: [] });

    const { findings } = service.processEvidence('case-1', 'dump.tdump', jstack, '');
    expect(signatureService.getAll).toHaveBeenCalled();
    expect(caseManager.updateFindings).toHaveBeenCalledWith('case-1', findings);
  });

  it('generates a unique evidence ID on each call', () => {
    const { evidenceItem: a } = service.processEvidence('case-1', 'a.log', 'a', '');
    const { evidenceItem: b } = service.processEvidence('case-1', 'b.log', 'b', '');
    expect(a.id).not.toBe(b.id);
  });
});
