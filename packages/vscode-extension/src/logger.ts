import * as vscode from 'vscode';

export interface IILogger {
  debug(component: string, msg: string, ctx?: Record<string, unknown>): void;
  info(component: string, msg: string, ctx?: Record<string, unknown>): void;
  warn(component: string, msg: string, ctx?: Record<string, unknown>): void;
  error(component: string, msg: string, ctx?: Record<string, unknown>): void;
}

export const nullLogger: IILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

export function createLogger(out: vscode.OutputChannel): IILogger {
  const write = (level: string, component: string, msg: string, ctx?: Record<string, unknown>) => {
    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    const ctxStr = ctx && Object.keys(ctx).length > 0 ? '  ' + JSON.stringify(ctx) : '';
    out.appendLine(`[${ts}] [${level}] [${component}] ${msg}${ctxStr}`);
  };
  return {
    debug: (c, m, ctx) => write('DEBUG', c, m, ctx),
    info:  (c, m, ctx) => write('INFO ', c, m, ctx),
    warn:  (c, m, ctx) => write('WARN ', c, m, ctx),
    error: (c, m, ctx) => {
      write('ERROR', c, m, ctx);
      console.error(`[II][${c}] ${m}`, ctx ?? '');
    },
  };
}
