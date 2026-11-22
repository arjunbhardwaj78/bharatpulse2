import { FAMILY_OF, type Complaint } from './types.js';

export interface DedupeResult {
  kept: Complaint[];
  removed: Complaint[];
}

/**
 * One household can report the same problem many times, and a single angry
 * reporter must not be able to fake an outage. For each (reporter, issue family)
 * we keep the first complaint and drop repeats inside the window. A repeat
 * after the window counts again, because the problem is clearly still there.
 */
export function dedupeByReporter(complaints: readonly Complaint[], windowMs: number): DedupeResult {
  const sorted = [...complaints].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const lastKept = new Map<string, number>();
  const kept: Complaint[] = [];
  const removed: Complaint[] = [];

  for (const c of sorted) {
    const key = `${c.reporterId}|${FAMILY_OF[c.issueType]}`;
    const previous = lastKept.get(key);
    if (previous !== undefined && c.createdAt - previous <= windowMs) {
      removed.push(c);
    } else {
      lastKept.set(key, c.createdAt);
      kept.push(c);
    }
  }
  return { kept, removed };
}
