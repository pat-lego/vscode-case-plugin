import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('vscode', () => import('./__mocks__/vscode'));

import { CaseManager } from './case-manager';
import * as vscode from 'vscode';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ii-test-'));
}

function makeContext(activeCaseId: string | null = null) {
  return {
    globalState: {
      get: vi.fn().mockReturnValue(activeCaseId),
      update: vi.fn(),
    },
  } as unknown as vscode.ExtensionContext;
}

/**
 * Override the workspace.getConfiguration mock so `casePaths` returns the given
 * array. This must be called before constructing CaseManager.
 */
function mockCasePaths(paths: string[]) {
  (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
    get: vi.fn((key: string) => {
      if (key === 'casePaths') return paths;
      return undefined;
    }),
  });
}

const tmpDirs: string[] = [];

function makeTmpDirTracked(): string {
  const d = makeTmpDir();
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  vi.resetAllMocks();
  // Restore default mock after each test
  (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CaseManager.resolveCase', () => {
  it('fires onActiveChangeEmitter when a case is resolved', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-1', 'Test Case');

    const fired: Array<string | null> = [];
    cm.onActiveChange(id => fired.push(id));

    cm.resolveCase('CASE-1', 'Fixed the bug', 'PL');

    expect(fired.length).toBeGreaterThanOrEqual(1);
  });

  it('persists resolved status to disk (integration)', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);

    // Create the case with the first manager
    const ctx1 = makeContext();
    const cm1 = new CaseManager(ctx1);
    cm1.createCase('CASE-2', 'Integration Case');
    cm1.resolveCase('CASE-2', 'Resolved', 'PL');

    // Spin up a second manager reading the same directory
    mockCasePaths([tmpDir]);
    const ctx2 = makeContext();
    const cm2 = new CaseManager(ctx2);

    const c = cm2.getAllCases().find(c => c.id === 'CASE-2');
    expect(c).toBeDefined();
    expect(c!.status).toBe('resolved');
  });
});

describe('CaseManager.reloadFromDisk', () => {
  it('picks up notes edited externally (e.g. in another editor)', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-5', 'Reload Test', undefined, 'original notes');
    expect(cm.getSession('CASE-5')!.meta.notes).toBe('original notes');

    // Simulate an external process (another editor, git, etc.) rewriting the
    // MD file directly, bypassing CaseManager entirely.
    const mdPath = path.join(tmpDir, 'CASE-5', 'CASE-5.md');
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const externallyEdited = raw.replace('original notes', 'edited externally on disk');
    fs.writeFileSync(mdPath, externallyEdited, 'utf-8');

    // Without a reload, the in-memory session still shows the stale value.
    expect(cm.getSession('CASE-5')!.meta.notes).toBe('original notes');

    const ok = cm.reloadFromDisk('CASE-5');
    expect(ok).toBe(true);
    expect(cm.getSession('CASE-5')!.meta.notes).toBe('edited externally on disk');
  });

  it('returns false for an unknown case', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    expect(cm.reloadFromDisk('NOPE')).toBe(false);
  });
});

describe('CaseManager.removeEvidence', () => {
  it('deletes the stored .txt file for ev- prefixed evidence items', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-3', 'Evidence Test');
    // Manually write a .txt file to simulate stored evidence
    const caseDir = path.join(tmpDir, 'CASE-3');
    const storedFile = path.join(caseDir, 'ev-001.txt');
    fs.writeFileSync(storedFile, 'raw content', 'utf-8');

    cm.addEvidence('CASE-3', {
      id: 'ev-001',
      type: 'log-export',
      source: 'test',
      capturedAt: new Date(),
      filePath: '',
      rawContent: 'raw content',
    });

    expect(fs.existsSync(storedFile)).toBe(true);
    cm.removeEvidence('CASE-3', 'ev-001');
    expect(fs.existsSync(storedFile)).toBe(false);
  });

  it('deletes the original file for disk- prefixed evidence items', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-4', 'Disk Evidence Test');
    const caseDir = path.join(tmpDir, 'CASE-4');

    // Write a non-MD file in the case dir to simulate disk-scanned evidence
    const diskFile = path.join(caseDir, 'thread.tdump');
    fs.writeFileSync(diskFile, 'thread dump data', 'utf-8');

    cm.addEvidence('CASE-4', {
      id: 'disk-thread.tdump',
      type: 'thread-dump',
      source: 'thread.tdump',
      capturedAt: new Date(),
      filePath: diskFile,
    });

    expect(fs.existsSync(diskFile)).toBe(true);
    cm.removeEvidence('CASE-4', 'disk-thread.tdump');
    expect(fs.existsSync(diskFile)).toBe(false);
  });
});

describe('CaseManager evidence file existence checks', () => {
  it('drops evidence whose backing file was deleted outside the extension when reloading from disk', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-6', 'Evidence Existence Test');
    const caseDir = path.join(tmpDir, 'CASE-6');
    const imgPath = path.join(caseDir, 'screenshot.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-bytes'));

    cm.addEvidence('CASE-6', {
      id: 'ev-img-1',
      type: 'screenshot',
      source: 'local-file',
      capturedAt: new Date(),
      filePath: imgPath,
    });
    expect(cm.getSession('CASE-6')!.meta.evidence.some(e => e.id === 'ev-img-1')).toBe(true);

    // Simulate the file being deleted outside the extension (Finder, git, etc.)
    fs.unlinkSync(imgPath);

    expect(cm.reloadFromDisk('CASE-6')).toBe(true);
    expect(cm.getSession('CASE-6')!.meta.evidence.some(e => e.id === 'ev-img-1')).toBe(false);
  });

  it('prunes evidence whose backing file has vanished during refreshDiskEvidence', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-7', 'Refresh Evidence Test');
    const caseDir = path.join(tmpDir, 'CASE-7');
    const imgPath = path.join(caseDir, 'shot.png');
    fs.writeFileSync(imgPath, Buffer.from('fake-png-bytes'));

    cm.addEvidence('CASE-7', {
      id: 'ev-img-2',
      type: 'screenshot',
      source: 'local-file',
      capturedAt: new Date(),
      filePath: imgPath,
    });

    fs.unlinkSync(imgPath);

    cm.refreshDiskEvidence('CASE-7');
    expect(cm.getSession('CASE-7')!.meta.evidence.some(e => e.id === 'ev-img-2')).toBe(false);
  });

  it('keeps text evidence whose content is already cached in memory even if the stored file is missing', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-8', 'Cached Content Test');
    cm.addEvidence('CASE-8', {
      id: 'ev-log-1',
      type: 'log-export',
      source: 'test',
      capturedAt: new Date(),
      filePath: '',
      rawContent: 'log content already in memory',
    });

    expect(cm.reloadFromDisk('CASE-8')).toBe(true);
    expect(cm.getSession('CASE-8')!.meta.evidence.some(e => e.id === 'ev-log-1')).toBe(true);
  });
});

describe('CaseManager.reopenCase', () => {
  it('changes status back to open and saves to disk', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx = makeContext();
    const cm = new CaseManager(ctx);

    cm.createCase('CASE-5', 'Reopen Test');
    cm.resolveCase('CASE-5', 'Fixed', 'PL');

    let s = cm.getAllCases().find(c => c.id === 'CASE-5');
    expect(s?.status).toBe('resolved');

    cm.reopenCase('CASE-5');
    s = cm.getAllCases().find(c => c.id === 'CASE-5');
    expect(s?.status).toBe('open');

    // Verify it persisted to disk
    mockCasePaths([tmpDir]);
    const ctx2 = makeContext();
    const cm2 = new CaseManager(ctx2);
    const c = cm2.getAllCases().find(c => c.id === 'CASE-5');
    expect(c?.status).toBe('open');
  });
});

describe('CaseManager.getAllCases', () => {
  it('returns cases sorted by updatedAt descending', () => {
    vi.useFakeTimers();
    try {
      const tmpDir = makeTmpDirTracked();
      mockCasePaths([tmpDir]);
      const ctx = makeContext();
      const cm = new CaseManager(ctx);

      vi.setSystemTime(new Date('2024-01-01T10:00:00Z'));
      cm.createCase('CASE-ALPHA', 'First Case');
      cm.updateNotes('CASE-ALPHA', 'note alpha');

      vi.setSystemTime(new Date('2024-01-01T10:00:01Z'));
      cm.createCase('CASE-BETA', 'Second Case');
      cm.updateNotes('CASE-BETA', 'note beta');

      const all = cm.getAllCases();
      // BETA was updated last, should be first
      const ids = all.map(c => c.id);
      const alphaIdx = ids.indexOf('CASE-ALPHA');
      const betaIdx = ids.indexOf('CASE-BETA');
      expect(betaIdx).toBeLessThan(alphaIdx);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CaseManager.pickDefaultActiveCase', () => {
  it('does not pick a resolved case as the default active case', () => {
    const tmpDir = makeTmpDirTracked();
    mockCasePaths([tmpDir]);
    const ctx1 = makeContext();
    const cm1 = new CaseManager(ctx1);

    // Create two cases; resolve one, keep one open
    cm1.createCase('CASE-OPEN', 'Open Case');
    cm1.createCase('CASE-RESOLVED', 'Resolved Case');
    cm1.resolveCase('CASE-RESOLVED', 'Done', 'PL');

    // Simulate restarting with CASE-RESOLVED as the saved active case
    mockCasePaths([tmpDir]);
    const ctx2 = makeContext('CASE-RESOLVED');
    const cm2 = new CaseManager(ctx2);

    // The active case should fall back to the open one, not the resolved one
    const activeId = cm2.getActiveCaseId();
    expect(activeId).toBe('CASE-OPEN');
  });
});
