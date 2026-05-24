import { ThreadDumpFormat } from '../../types/signal';

export function detectFormat(raw: string): ThreadDumpFormat {
  if (isIbmJ9(raw)) return 'ibm-j9';
  if (isJstack(raw)) return 'jstack';
  return 'generic';
}

function isJstack(raw: string): boolean {
  return /^"[^"]+"\s+#\d+/.test(raw) ||
    /java\.lang\.Thread\.State:/.test(raw);
}

function isIbmJ9(raw: string): boolean {
  return raw.includes('Java dump') ||
    raw.includes('1TISIGINFO') ||
    raw.includes('3XMTHREADINFO');
}
