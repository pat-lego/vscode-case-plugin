import { ThreadDumpSignals } from '../../types/signal';
import { Thread } from '../../types/thread';
import { detectFormat } from './detector';
import { parseJstack, parseJstackThreads } from './jstack.parser';
import { parseIbmJ9, parseIbmJ9Threads } from './ibm-j9.parser';
import { parseGeneric } from './generic.parser';

export function parseThreadDump(raw: string, capturedAt?: Date): ThreadDumpSignals {
  const format = detectFormat(raw);
  const timestamp = capturedAt ?? new Date();

  switch (format) {
    case 'jstack':  return parseJstack(raw, timestamp);
    case 'ibm-j9':  return parseIbmJ9(raw, timestamp);
    default:        return parseGeneric(raw, timestamp);
  }
}

export function parseThreadDumpThreads(raw: string): Thread[] {
  const format = detectFormat(raw);
  switch (format) {
    case 'jstack':  return parseJstackThreads(raw);
    case 'ibm-j9':  return parseIbmJ9Threads(raw);
    default:        return [];
  }
}
