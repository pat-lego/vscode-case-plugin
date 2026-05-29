import { Thread } from '../types/thread';

export interface QueryResult {
  rows: QueryRow[];
  totalMatched: number;
  error?: string;
  /** Matched Thread objects, only populated for non-stats (raw list) queries. */
  threads?: Thread[];
}

export type QueryRow = Record<string, string | number>;

type FilterFn = (t: Thread) => boolean;

interface StatsCommand { type: 'stats'; fields: string[] }
interface CountCommand { type: 'count' }
interface TopCommand   { type: 'top';   n: number }
type Command = StatsCommand | CountCommand | TopCommand;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a Splunk-inspired pipeline query against a set of parsed threads.
 *
 * Syntax:
 *   [filter] [| where filter] [| stats count [by field[,field2]]] [| top N]
 *
 * Filter predicates (combinable with AND / OR, pipeable with | where):
 *   state=BLOCKED
 *   state!=RUNNABLE
 *   state IN (BLOCKED, WAITING, TIMED_WAITING)
 *   thread=*http-nio*          glob match on thread name
 *   frame=*HikariPool*         glob match on any stack frame
 *   keyframe=*dao*             glob match on the first non-JVM frame
 *   stackdepth>=10             numeric comparison on frame count
 *
 * Comparison operators for numeric fields: >  >=  <  <=  !=
 * String inequality: state!=RUNNABLE
 *
 * Row fields (available in stats and returned for raw results):
 *   thread | state | topframe | keyframe | class | package | method | stackdepth
 *
 * Examples:
 *   state=BLOCKED | stats count by keyframe
 *   thread=*b2c* AND state=WAITING | stats count by keyframe | top 5
 *   state=WAITING | where thread=*b2c* | stats count by keyframe
 *   frame=*ServiceRegistry* | stats count by state
 *   stackdepth>=10 AND state!=RUNNABLE | stats count by keyframe
 *   thread=*b2c* | stats count
 *   | stats count by state
 */
export function executeQuery(threads: Thread[], query: string): QueryResult {
  try {
    const stages = query.split('|').map(s => s.trim()).filter(Boolean);

    const commands: Command[] = [];
    const filterFns: FilterFn[] = [];
    for (const stage of stages) {
      const lower = stage.toLowerCase();
      if (lower.startsWith('stats ') || lower === 'stats count' || lower.startsWith('top ')) {
        commands.push(parseCommand(stage));
      } else {
        // strip optional leading "where" keyword (Splunk-style)
        const expr = stage.replace(/^where\s+/i, '');
        filterFns.push(parseFilter(expr));
      }
    }
    const filterFn: FilterFn = filterFns.length === 0 ? () => true
             : filterFns.length === 1 ? filterFns[0]
             : (t: Thread) => filterFns.every(fn => fn(t));

    const matched = threads.filter(filterFn);

    if (commands.length === 0) {
      return { rows: matched.map(threadToRow), totalMatched: matched.length, threads: matched };
    }

    let rows: QueryRow[] = matched.map(threadToRow);
    for (const cmd of commands) {
      if (cmd.type === 'stats')  rows = applyStats(rows, cmd.fields);
      else if (cmd.type === 'count') rows = [{ count: rows.length }];
      else if (cmd.type === 'top')   rows = rows.slice(0, cmd.n);
    }

    return { rows, totalMatched: matched.length };
  } catch (e) {
    return { rows: [], totalMatched: 0, error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Filter parsing
// ---------------------------------------------------------------------------

function parseFilter(expr: string): FilterFn {
  if (!expr.trim()) return () => true;

  // OR has lowest precedence: split on " OR " first
  const orGroups = splitKeyword(expr, 'OR');
  const orFns = orGroups.map(group => {
    const andPreds = splitKeyword(group, 'AND');
    const andFns = andPreds.map(p => parsePredicate(p.trim()));
    return (t: Thread) => andFns.every(fn => fn(t));
  });

  return (t: Thread) => orFns.some(fn => fn(t));
}

function splitKeyword(expr: string, kw: string): string[] {
  // Word-boundary split that won't break inside IN(...) values
  return expr.split(new RegExp(`\\s+${kw}\\s+`, 'i'));
}

function parsePredicate(expr: string): FilterFn {
  // field IN (v1, v2, ...)
  const inMatch = expr.match(/^(\w+)\s+IN\s*\(([^)]+)\)/i);
  if (inMatch) {
    const field = inMatch[1].toLowerCase();
    const values = inMatch[2].split(',').map(v => v.trim().toUpperCase());
    return (t) => values.includes((getScalar(t, field) ?? '').toUpperCase());
  }

  // field >=|<=|!=|>|< value  — numeric comparisons and string inequality
  // Must be checked before the = branch because <= and >= contain =
  const cmpMatch = expr.match(/^(\w+)\s*(>=|<=|!=|>|<)\s*(.+)$/);
  if (cmpMatch) {
    const field   = cmpMatch[1].toLowerCase();
    const op      = cmpMatch[2];
    const rawVal  = cmpMatch[3].trim();
    const numVal  = Number(rawVal);
    const numeric = rawVal !== '' && !isNaN(numVal);

    if (numeric) {
      return (t) => {
        const v = Number(getScalar(t, field) ?? '0');
        if (op === '>=') return v >= numVal;
        if (op === '<=') return v <= numVal;
        if (op === '>')  return v >  numVal;
        if (op === '<')  return v <  numVal;
        if (op === '!=') return v !== numVal;
        return false;
      };
    }

    if (op === '!=') {
      // frame is an array field: frame!=*pattern* means "no frame matches"
      if (field === 'frame') {
        const re = globToRegex(rawVal);
        return (t) => !t.frames.some(f => re.test(f));
      }
      // glob inequality on scalar fields: thread!=*b2c* etc.
      if (rawVal.includes('*') || rawVal.includes('?')) {
        const re = globToRegex(rawVal);
        return (t) => !re.test(getScalar(t, field) ?? '');
      }
      const upper = rawVal.toUpperCase();
      return (t) => (getScalar(t, field) ?? '').toUpperCase() !== upper;
    }

    throw new Error(`Operator "${op}" requires a numeric value for field "${field}"`);
  }

  // field=value  (supports glob * and ?)
  const eqMatch = expr.match(/^(\w+)=(.+)$/);
  if (eqMatch) {
    const field   = eqMatch[1].toLowerCase();
    const pattern = eqMatch[2].trim();

    if (field === 'frame') {
      const re = globToRegex(pattern);
      return (t) => t.frames.some(f => re.test(f));
    }

    if (pattern.includes('*') || pattern.includes('?')) {
      const re = globToRegex(pattern);
      return (t) => re.test(getScalar(t, field) ?? '');
    }

    const upper = pattern.toUpperCase();
    return (t) => (getScalar(t, field) ?? '').toUpperCase() === upper;
  }

  throw new Error(`Cannot parse predicate: "${expr}"`);
}

function getScalar(t: Thread, field: string): string | undefined {
  switch (field) {
    case 'state':      return t.state;
    case 'thread':     return t.name;
    case 'keyframe':   return t.keyFrame;
    case 'topframe':   return t.topFrame;
    case 'class':      return extractClass(t.keyFrame);
    case 'package':    return extractPackage(t.keyFrame);
    case 'method':     return extractMethod(t.keyFrame);
    case 'stackdepth': return String(t.frames.length);
    case 'elapsed':    return t.elapsed !== undefined ? String(t.elapsed) : undefined;
    case 'nid':        return t.nid;
    default:           return undefined;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map(seg => seg.split('?').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

function parseCommand(stage: string): Command {
  const lower = stage.toLowerCase().trim();

  // "stats count" with no "by" — simple total count
  if (lower === 'stats count') {
    return { type: 'count' };
  }

  const statsMatch = lower.match(/^stats\s+count\s+by\s+(.+)$/);
  if (statsMatch) {
    const fields = statsMatch[1].split(',').map(f => f.trim().toLowerCase());
    return { type: 'stats', fields };
  }

  const topMatch = lower.match(/^top\s+(\d+)$/);
  if (topMatch) {
    return { type: 'top', n: parseInt(topMatch[1], 10) };
  }

  throw new Error(`Unknown command: "${stage}"`);
}

// ---------------------------------------------------------------------------
// Stats aggregation
// ---------------------------------------------------------------------------

function applyStats(rows: QueryRow[], fields: string[]): QueryRow[] {
  const groups = new Map<string, { key: Record<string, string>; count: number }>();

  for (const row of rows) {
    const keyParts = fields.map(f => String(row[f] ?? ''));
    const key = keyParts.join('\0');

    if (!groups.has(key)) {
      const keyObj: Record<string, string> = {};
      fields.forEach((f, i) => { keyObj[f] = keyParts[i]; });
      groups.set(key, { key: keyObj, count: 0 });
    }
    groups.get(key)!.count++;
  }

  return Array.from(groups.values())
    .map(({ key, count }) => ({ ...key, count }))
    .sort((a, b) => (b.count as number) - (a.count as number));
}

// ---------------------------------------------------------------------------
// Thread → row projection and frame field extraction
// ---------------------------------------------------------------------------

function threadToRow(t: Thread): QueryRow {
  const row: QueryRow = {
    thread:     t.name,
    state:      t.state,
    stackdepth: t.frames.length,
    keyframe:   t.keyFrame,
    class:      extractClass(t.keyFrame),
    package:    extractPackage(t.keyFrame),
    method:     extractMethod(t.keyFrame),
    topframe:   t.topFrame,
  };
  if (t.elapsed !== undefined) row.elapsed = t.elapsed;
  if (t.nid     !== undefined) row.nid     = t.nid;
  return row;
}

function stripSuffix(frame: string): string {
  // Remove (FileName.java:123) or (Native Method) suffix
  return frame.replace(/\(.*?\)$/, '');
}

function extractClass(keyFrame: string): string {
  if (!keyFrame) return '';
  const parts = stripSuffix(keyFrame).split('.');
  // The class is the last uppercase-starting segment; the one after is the method
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && /^[A-Z]/.test(parts[i])) {
      return parts.slice(0, i + 1).join('.');
    }
  }
  return parts.slice(0, -1).join('.');
}

function extractPackage(keyFrame: string): string {
  if (!keyFrame) return '';
  const cls = extractClass(keyFrame);
  const parts = cls.split('.');
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] && /^[A-Z]/.test(parts[i])) {
      return parts.slice(0, i).join('.');
    }
  }
  return cls;
}

function extractMethod(keyFrame: string): string {
  if (!keyFrame) return '';
  return stripSuffix(keyFrame).split('.').pop() ?? '';
}
