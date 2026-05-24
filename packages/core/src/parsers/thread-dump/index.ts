import { ThreadDumpSignals } from '../../types/signal';
import { detectFormat } from './detector';
import { parseJstack } from './jstack.parser';
import { parseIbmJ9 } from './ibm-j9.parser';
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
