import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

vi.mock('vscode', () => import('./__mocks__/vscode'));

// Mock the `ws` package so the default-exported WebSocket class has static
// readyState constants (WebSocket.OPEN, etc.), matching the real module's shape.
vi.mock('ws', () => {
  const WS = { OPEN: 1, CONNECTING: 0, CLOSING: 2, CLOSED: 3 };
  const WebSocketClass = Object.assign(function () {}, WS);
  return {
    default: WebSocketClass,
    WebSocketServer: vi.fn().mockReturnValue({ on: vi.fn(), close: vi.fn() }),
  };
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFakeWs() {
  const sent: string[] = [];
  return {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => sent.push(data)),
    sent,
  };
}

function makeServices(activeCaseId: string | null = 'case-001', casePath = '') {
  const session = {
    meta: { id: activeCaseId ?? '', title: 'Test Case', evidence: [] },
    casePath,
  };
  const caseManager = {
    getActiveCaseId: vi.fn().mockReturnValue(activeCaseId),
    getSession: vi.fn().mockReturnValue(activeCaseId ? session : undefined),
    getActiveSession: vi.fn().mockReturnValue(activeCaseId ? session : undefined),
    onActiveChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    addEvidence: vi.fn(),
  };
  const analysisService = {
    processEvidence: vi.fn().mockReturnValue({ evidenceItem: { id: 'ev-1', type: 'screenshot' }, findings: [] }),
  };
  return { caseManager, analysisService };
}

// Dynamically import BridgeServer so the vscode mock is in place first.
async function makeBridge(activeCaseId: string | null = 'case-001', casePath = '') {
  const { BridgeServer } = await import('./bridge-server');
  const { caseManager, analysisService } = makeServices(activeCaseId, casePath);
  const bridge = new BridgeServer(caseManager as any, analysisService as any);
  return { bridge, caseManager, analysisService };
}

// ── BridgeServer.handleMessage ───────────────────────────────────────────────

describe('BridgeServer.handleMessage', () => {
  it('responds to ping with pong', async () => {
    const { bridge } = await makeBridge();
    const ws = makeFakeWs();
    (bridge as any)['handleMessage'](ws, { type: 'ping' });

    expect(ws.send).toHaveBeenCalledOnce();
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'pong' });
  });

  it('returns error when no active case', async () => {
    const { bridge } = await makeBridge(null);
    const ws = makeFakeWs();
    (bridge as any)['handleMessage'](ws, { type: 'screenshot', name: 'shot.png', data: 'data:image/png;base64,abc=' });

    const response = JSON.parse(ws.sent[0]);
    expect(response.type).toBe('error');
    expect(response.message).toContain('No active case');
  });

  it('processes a text capture and sends captureAck', async () => {
    const { bridge, analysisService } = await makeBridge();
    const ws = makeFakeWs();
    (bridge as any)['handleMessage'](ws, {
      type: 'capture',
      name: 'splunk-12h00.log',
      content: 'error: OutOfMemory',
      source: 'splunk',
    });

    expect(analysisService.processEvidence).toHaveBeenCalledWith(
      'case-001',
      'splunk-12h00.log',
      'error: OutOfMemory',
      ''
    );
    const ack = JSON.parse(ws.sent[0]);
    expect(ack.type).toBe('captureAck');
    expect(ack.name).toBe('splunk-12h00.log');
  });

  it('processes a screenshot capture and writes a file', async () => {
    const tmpDir = os.tmpdir();
    // Remove any leftover from a prior run so uniqueFilePath always lands on the base name.
    for (const f of fs.readdirSync(tmpDir).filter(f => f.startsWith('screenshot-1234'))) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    const { bridge, analysisService } = await makeBridge('case-001', '');

    const pngBase64 = Buffer.from('PNG_PLACEHOLDER').toString('base64');
    const dataUrl = `data:image/png;base64,${pngBase64}`;
    const ws = makeFakeWs();

    (bridge as any)['handleMessage'](ws, {
      type: 'screenshot',
      name: 'screenshot-1234.png',
      data: dataUrl,
      mimeType: 'image/png',
    });

    // File should be written to tmpdir (no casePath configured)
    const written = path.join(tmpDir, 'screenshot-1234.png');
    expect(fs.existsSync(written)).toBe(true);
    const buf = fs.readFileSync(written);
    expect(buf.toString()).toBe('PNG_PLACEHOLDER');

    expect(analysisService.processEvidence).toHaveBeenCalledWith(
      'case-001',
      'screenshot-1234.png',
      '',
      written
    );
    const ack = JSON.parse(ws.sent[0]);
    expect(ack.type).toBe('captureAck');
    expect(ack.name).toBe('screenshot-1234.png');
  });

  it('uses casePath directory when session has one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
    const { bridge } = await makeBridge('case-001', dir);
    const ws = makeFakeWs();

    const pngBase64 = Buffer.from('IMG').toString('base64');
    (bridge as any)['handleMessage'](ws, {
      type: 'screenshot',
      name: 'shot.png',
      data: `data:image/png;base64,${pngBase64}`,
    });

    const expected = path.join(dir, 'case-001', 'shot.png');
    expect(fs.existsSync(expected)).toBe(true);

    // cleanup
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT write a file for invalid (non-data:) dataUrl', async () => {
    const { bridge, analysisService } = await makeBridge();
    const ws = makeFakeWs();
    (bridge as any)['handleMessage'](ws, {
      type: 'screenshot',
      name: 'bad.png',
      data: 'https://evil.example.com/img.png',
    });

    // processEvidence is still called (with empty filePath), but no file written outside tmpdir
    expect(analysisService.processEvidence).toHaveBeenCalledWith('case-001', 'bad.png', '', '');
  });

  it('fires VS Code notification after a successful capture', async () => {
    const vscode = await import('./__mocks__/vscode');
    const { bridge } = await makeBridge();
    const ws = makeFakeWs();
    (bridge as any)['handleMessage'](ws, {
      type: 'capture',
      name: 'log.txt',
      content: 'hello',
    });

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('log.txt')
    );
  });
});
