import { CdnAnalysisInput, CdnFetchOptions, CdnLogEntry, PopBaseline, SplunkRunner } from './types';
import { parseCdnLogs, parseSplunkResults, parseResultLine } from './parser';
import { buildIncidentQuery, buildBaselineQuery, clampBaselineDays } from './query-builder';

const DEFAULT_SKY_PATH = 'sky';
const DEFAULT_TIMEOUT_MS = 300000;              // 5 min — CDN queries are slow
const DEFAULT_MAX_BUFFER = 1024 * 1024 * 1024;  // 1 GiB — used only by the buffered runner path
const DEFAULT_MAX_EVENTS = 100000;

/**
 * GUI-launched Electron apps (VS Code included) don't source the user's shell profile, so
 * `process.env.PATH` is often missing entries added there — notably a version-managed `node`
 * (nvm/fnm/volta). `sky` itself may resolve fine (e.g. it lives in /usr/local/bin) but then fail
 * internally with "node: command not found" once it shells out to `node`. Resolving the login
 * shell's PATH once and merging it in fixes `sky` and anything else it invokes, without needing a
 * setting for every downstream binary. Cached for the process lifetime; skipped on Windows, which
 * doesn't have this class of issue.
 */
let cachedLoginShellPath: string | null | undefined;

async function resolveLoginShellPath(): Promise<string | undefined> {
  if (cachedLoginShellPath !== undefined) return cachedLoginShellPath ?? undefined;
  if (process.platform === 'win32') {
    cachedLoginShellPath = null;
    return undefined;
  }
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);
    const shell = process.env.SHELL || '/bin/zsh';
    // Login (not interactive) shell: sources ~/.zprofile / ~/.profile (where nvm/fnm/etc. are
    // typically initialised) without the noise/quirks of an interactive shell.
    const { stdout } = await run(shell, ['-lc', 'echo -n "$PATH"'], { timeout: 5000, encoding: 'utf-8' });
    cachedLoginShellPath = stdout.trim() || null;
  } catch {
    cachedLoginShellPath = null;
  }
  return cachedLoginShellPath ?? undefined;
}

/** Builds the env for the `sky` child process, prepending the resolved login-shell PATH if any. */
async function childEnv(): Promise<NodeJS.ProcessEnv> {
  const loginPath = await resolveLoginShellPath();
  if (!loginPath) return process.env;
  const existing = process.env.PATH ?? '';
  return { ...process.env, PATH: existing ? `${loginPath}:${existing}` : loginPath };
}

/**
 * Fetches row-level CDN log events for the incident window via `sky splunk query`.
 * Uses `opts.runner` when provided (tests), otherwise the default `sky` runner.
 */
export async function fetchCdnLogs(input: CdnAnalysisInput, opts: CdnFetchOptions): Promise<CdnLogEntry[]> {
  const runner = opts.runner ?? defaultSplunkRunner(opts);
  const spl = buildIncidentQuery(input, opts);
  const stdout = await runner(spl);
  return parseCdnLogs(stdout);
}

/**
 * Fetches a normal POP-usage baseline (`stats count by server_datacenter`) over the
 * `baselineDays` (max 2) preceding the incident start. Cheap: Splunk does the aggregation.
 */
export async function fetchPopBaseline(input: CdnAnalysisInput, opts: CdnFetchOptions): Promise<PopBaseline> {
  const runner = opts.runner ?? defaultSplunkRunner(opts);
  const spl = buildBaselineQuery(input, opts);
  const stdout = await runner(spl);

  const popCounts: Record<string, number> = {};
  let totalRequests = 0;
  for (const row of parseSplunkResults(stdout)) {
    const pop = (row.server_datacenter ?? '').trim();
    if (!pop) continue;
    const count = parseInt(row.count ?? '0', 10);
    if (!Number.isFinite(count)) continue;
    popCounts[pop] = (popCounts[pop] ?? 0) + count;
    totalRequests += count;
  }

  return { windowDays: clampBaselineDays(opts.baselineDays), totalRequests, popCounts };
}

/**
 * Streams a `sky splunk query` response line-by-line via `spawn`, invoking `onEntry` for each
 * parsed event. The full response is never buffered — memory stays bounded regardless of how many
 * events the CDN returns. Stops early (killing the query) once `maxEvents` have been consumed.
 * Returns the number of events seen and whether the result was truncated at the cap.
 *
 * This is the production path for large CDN volumes. The buffered {@link fetchCdnLogs} remains for
 * callers that inject a runner (tests) or want the events materialised as an array.
 */
export async function streamCdnLogs(
  input: CdnAnalysisInput,
  opts: CdnFetchOptions,
  onEntry: (entry: CdnLogEntry) => void
): Promise<{ count: number; truncated: boolean }> {
  const spl = buildIncidentQuery(input, opts);
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;   // 0 => unlimited
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const skyPath = opts.skyPath ?? DEFAULT_SKY_PATH;

  const { spawn } = await import('child_process');
  const readline = await import('readline');
  const rawOut = opts.saveRawPath ? (await import('fs')).createWriteStream(opts.saveRawPath, { encoding: 'utf-8' }) : null;

  const env = await childEnv();

  return new Promise((resolve, reject) => {
    const child = spawn(skyPath, ['splunk', 'query', spl], { stdio: ['ignore', 'pipe', 'pipe'], env });

    let count = 0;
    let truncated = false;
    let timedOut = false;
    let errBuf = '';
    let outHead = '';
    let done = false;

    const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); if (rawOut) rawOut.end(); fn(); } };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);

    child.on('error', err => finish(() => reject(wrapRunnerError(err))));
    child.stderr.on('data', (d: Buffer) => { if (errBuf.length < 8192) errBuf += d.toString(); });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', line => {
      if (done || truncated) return;
      if (rawOut) rawOut.write(line + '\n');
      if (outHead.length < 2048) outHead += line + '\n';
      const entry = parseResultLine(line);
      if (!entry) return;
      onEntry(entry);
      count++;
      if (maxEvents > 0 && count >= maxEvents) {
        truncated = true;
        child.kill('SIGTERM'); // we have enough — stop the expensive query
      }
    });

    child.on('close', (code, signal) => {
      if (truncated) return finish(() => resolve({ count, truncated: true }));
      if (timedOut) return finish(() => reject(wrapRunnerError({ killed: true, signal: 'SIGTERM' })));
      if (code === 0) return finish(() => resolve({ count, truncated: false }));
      finish(() => reject(wrapRunnerError({ code, signal, stdout: outHead, stderr: errBuf, message: `Command failed (exit ${code})` })));
    });
  });
}

/**
 * Streams a saved CDN export **file** line-by-line (the natural `sky splunk query > out.json`
 * NDJSON format), invoking `onEntry` per parsed event without loading the whole file. Returns the
 * number of events parsed; 0 means the file was not NDJSON (caller should fall back to whole-file
 * parsing for a JSON array / KV block).
 */
export async function streamCdnFile(filePath: string, onEntry: (entry: CdnLogEntry) => void): Promise<number> {
  const fs = await import('fs');
  const readline = await import('readline');

  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    stream.on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => {
      const entry = parseResultLine(line);
      if (entry) { onEntry(entry); count++; }
    });
    rl.on('close', () => resolve(count));
    rl.on('error', reject);
  });
}

/**
 * The default runner: shells out to `sky splunk query '<SPL>'` with `execFile` (no shell, so the
 * SPL is passed as a single argument — no shell-injection surface). Buffers the whole response, so
 * prefer {@link streamCdnLogs} for large CDN volumes. Surfaces a clear, actionable error when the
 * Splunk session is not authenticated.
 */
export function defaultSplunkRunner(opts: CdnFetchOptions): SplunkRunner {
  return async (spl: string): Promise<string> => {
    // Lazy-require so the pure parts of this module import cleanly in any environment and tests
    // that inject a runner never pull in child_process.
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);

    try {
      const { stdout } = await run(
        opts.skyPath ?? DEFAULT_SKY_PATH,
        ['splunk', 'query', spl],
        {
          timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
          encoding: 'utf-8',
          env: await childEnv()
        }
      );
      return stdout;
    } catch (err) {
      throw wrapRunnerError(err);
    }
  };
}

/** Turns raw execFile failures into actionable errors (missing binary, auth, timeout, oversize). */
function wrapRunnerError(err: unknown): Error {
  return new Error(explainSplunkError(err));
}

/**
 * Maps an execFile failure to an actionable message. `sky` reports many failures — including
 * "not logged in" — on **stdout** with an empty stderr, so stdout must be inspected too
 * (otherwise the real reason is lost behind Node's generic "Command failed: …" message).
 */
export function explainSplunkError(err: unknown): string {
  const e = err as {
    code?: string | number; killed?: boolean; signal?: string;
    stdout?: string; stderr?: string; message?: string;
  };
  const stderr = (e.stderr ?? '').toString();
  const stdout = (e.stdout ?? '').toString();
  const haystack = `${stderr}\n${stdout}\n${e.message ?? ''}`;

  if (e.code === 'ENOENT') {
    return '`sky` CLI not found on PATH. Install it or set investigator.cdn.skyPath.';
  }
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(e.message ?? '')) {
    return 'CDN result exceeded the output buffer. Narrow the time window / URL filter, or lower investigator.cdn.maxEvents.';
  }
  if (e.killed || e.signal === 'SIGTERM') {
    return 'Splunk query timed out. Narrow the time window / URL set, or raise investigator.cdn.timeoutSeconds.';
  }
  if (/\b(not\s+logged\s*in|login|authenticat|unauthor(?:ized|ised)?|session\s+expired|credential|invalid\s+session)\b/i.test(haystack)) {
    return 'Splunk session not authenticated. Run `sky splunk login` in a terminal, then retry.';
  }
  const detail = (stderr.trim() || stdout.trim() || e.message || String(err)).slice(0, 800);
  return `sky splunk query failed: ${detail}`;
}
