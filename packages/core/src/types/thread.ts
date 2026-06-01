import { ThreadState } from './signal';

export interface Thread {
  name: string;
  state: ThreadState;
  frames: string[];
  /** Raw monitor annotation lines from the dump (e.g. "- locked <0x…>", "- waiting to lock <0x…>"). */
  monitorLines: string[];
  topFrame: string;
  keyFrame: string;
  waitingOnMonitor?: string;
  waitingOnMonitorClass?: string;
  lockedMonitors: string[];
  /** Native OS thread ID (e.g. "0x3900" or "14310") — jstack only */
  nid?: string;
  /** Seconds since the thread was started, from the jstack header */
  elapsed?: number;
}
