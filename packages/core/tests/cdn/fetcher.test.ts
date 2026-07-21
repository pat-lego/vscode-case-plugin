import { describe, it, expect } from 'vitest';
import { explainSplunkError } from '../../src/cdn/fetcher';

// Error shapes below were captured empirically from Node's promisify(execFile) on this platform.

describe('explainSplunkError', () => {
  it('maps a not-logged-in message on STDOUT (empty stderr) to a login hint', () => {
    // This is the exact shape that previously surfaced as a generic "Command failed" error.
    const err = {
      code: 1, killed: false, signal: null,
      stdout: 'Error: not logged in, run sky splunk login\n',
      stderr: '',
      message: 'Command failed: sky splunk query search index=dx_aem_edge_prod ...'
    };
    expect(explainSplunkError(err)).toMatch(/sky splunk login/i);
  });

  it('maps a timeout (killed/SIGTERM) to a timeout hint', () => {
    const err = { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '', message: 'Command failed: ...' };
    expect(explainSplunkError(err)).toMatch(/timed out/i);
  });

  it('maps a maxBuffer overflow to a narrow-the-query hint', () => {
    const err = { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', message: 'stdout maxBuffer length exceeded' };
    expect(explainSplunkError(err)).toMatch(/output buffer|maxEvents/i);
  });

  it('maps a missing binary (ENOENT) to an install/path hint', () => {
    expect(explainSplunkError({ code: 'ENOENT', message: 'spawn sky ENOENT' })).toMatch(/not found on PATH/i);
  });

  it('surfaces the real reason (incl. stdout) for an unclassified failure, truncated', () => {
    const err = { code: 1, killed: false, stdout: 'search parse error: unexpected token', stderr: '', message: 'Command failed: ...' };
    const msg = explainSplunkError(err);
    expect(msg).toMatch(/search parse error/i);
    expect(msg.length).toBeLessThan(900);
  });
});
