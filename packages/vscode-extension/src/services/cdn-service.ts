import * as vscode from 'vscode';
import {
  analyzeCdnCacheMisses,
  analyzeCdnText,
  analyzeCdnFile,
  CdnAnalysisInput,
  CdnAnalysisReport,
  CdnFetchOptions
} from '@incident-investigator/core';
import { IILogger, nullLogger } from '../logger';

/** Effective CDN settings resolved from the `investigator.cdn.*` configuration. */
export interface CdnConfig {
  index: string;
  sourcetype: string;
  skyPath: string;
  defaultTier: 'author' | 'publish';
  baseline: boolean;
  baselineDays: number;
  maxEvents: number;
  timeoutMs: number;
}

/**
 * Wraps the core CDN cache-miss analyzer for the VS Code host: resolves settings, validates the
 * required Splunk source, runs `analyzeCdnCacheMisses` (which shells out to `sky splunk query`),
 * and logs to the Incident Investigator output channel.
 */
export class CdnAnalysisService {
  constructor(private log: IILogger = nullLogger) {}

  getConfig(): CdnConfig {
    const cfg = vscode.workspace.getConfiguration('investigator.cdn');
    return {
      index: (cfg.get<string>('splunkIndex') ?? 'dx_aem_edge_prod').trim(),
      sourcetype: (cfg.get<string>('splunkSourcetype') ?? '').trim(),
      skyPath: (cfg.get<string>('skyPath') ?? 'sky').trim() || 'sky',
      defaultTier: cfg.get<'author' | 'publish'>('defaultTier') === 'author' ? 'author' : 'publish',
      baseline: cfg.get<boolean>('fetchBaseline') ?? true,
      baselineDays: cfg.get<number>('baselineDays') ?? 2,
      maxEvents: cfg.get<number>('maxEvents') ?? 100000,
      timeoutMs: (cfg.get<number>('timeoutSeconds') ?? 300) * 1000
    };
  }

  async analyze(input: CdnAnalysisInput, saveRawPath?: string): Promise<CdnAnalysisReport> {
    const cfg = this.getConfig();

    if (!cfg.index) {
      throw new Error('No Splunk index configured. Set "investigator.cdn.splunkIndex" in settings.');
    }

    const opts: CdnFetchOptions = {
      index: cfg.index,
      sourcetype: cfg.sourcetype || undefined,
      skyPath: cfg.skyPath,
      baseline: cfg.baseline,
      baselineDays: cfg.baselineDays,
      maxEvents: cfg.maxEvents,
      timeoutMs: cfg.timeoutMs,
      saveRawPath
    };

    this.log.info('cdn', 'analyze start', {
      service: input.service, tier: input.tier ?? cfg.defaultTier, from: input.from, to: input.to,
      urls: input.urls?.length ?? 0, index: cfg.index, sourcetype: cfg.sourcetype || null, baseline: cfg.baseline
    });

    const started = Date.now();
    const report = await analyzeCdnCacheMisses(input, opts);

    this.log.info('cdn', 'analyze done', {
      ms: Date.now() - started,
      events: report.entryCount,
      miss: report.metrics.missCount,
      verdict: report.verdictId ?? null,
      warnings: report.metrics.warnings.length
    });

    return report;
  }

  /** Analyses a pasted CDN export (raw `sky splunk query` JSON/NDJSON or KV block) — no Splunk call. */
  analyzeText(rawText: string, input: CdnAnalysisInput): CdnAnalysisReport {
    this.log.info('cdn', 'analyze pasted export', { bytes: rawText.length, tier: input.tier ?? 'publish' });
    const report = analyzeCdnText(rawText, input);
    this.log.info('cdn', 'analyze pasted done', { events: report.entryCount, verdict: report.verdictId ?? null });
    return report;
  }

  /** Analyses a saved CDN export file, streaming it line-by-line — no Splunk call. */
  async analyzeFile(filePath: string, input: CdnAnalysisInput): Promise<CdnAnalysisReport> {
    this.log.info('cdn', 'analyze export file', { filePath, tier: input.tier ?? 'publish' });
    const report = await analyzeCdnFile(filePath, input);
    this.log.info('cdn', 'analyze export file done', { events: report.entryCount, verdict: report.verdictId ?? null });
    return report;
  }
}
