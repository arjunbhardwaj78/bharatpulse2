import type { Incident } from '@bharatpulse/engine';
import { isActive, type StoredIncident } from './types.js';

export interface ReconcileInput {
  /** What the engine just detected (its ids are NOT stable, we ignore them for matching). */
  clusters: readonly Incident[];
  /** Everything in storage, any status. */
  stored: readonly StoredIncident[];
  now: number;
}

const oldestFirst = (a: StoredIncident, b: StoredIncident): number =>
  a.detectedAt - b.detectedAt || a.incident.id.localeCompare(b.incident.id);

/**
 * Decides which freshly detected cluster IS which stored incident.
 *
 * The engine forgets everything between runs, so it can only say "here are the
 * groups right now". We match groups to stored incidents by SHARED COMPLAINTS:
 * a complaint belongs to at most one active incident, so if a new group contains
 * complaints that an active incident already had, it is that incident.
 *
 *  - no overlap with any active incident -> NEW incident (takes the engine's id)
 *  - overlaps one                        -> same incident, snapshot refreshed
 *  - overlaps several (two grew together)-> the OLDEST survives, the rest become 'merged'
 *  - one incident split into two groups  -> the group sharing the most complaints keeps the id,
 *                                           the other becomes a new incident
 *  - active incident with no group left  -> 'resolved' with resolution 'expired'
 *
 * Pure function: returns the records to save, touches nothing.
 */
export function reconcile({ clusters, stored, now }: ReconcileInput): StoredIncident[] {
  const active = stored.filter(isActive).sort(oldestFirst);
  const byId = new Map(active.map((s) => [s.incident.id, s]));
  const takenIds = new Set(stored.map((s) => s.incident.id));

  // complaint id -> the active incident that currently owns it
  const ownerOf = new Map<string, string>();
  for (const s of active) for (const cid of s.incident.complaintIds) ownerOf.set(cid, s.incident.id);

  // overlap[k] = how many complaints cluster k shares with each active incident
  const overlap: Map<string, number>[] = clusters.map((cluster) => {
    const counts = new Map<string, number>();
    for (const cid of cluster.complaintIds) {
      const sid = ownerOf.get(cid);
      if (sid && byId.get(sid)!.incident.family === cluster.family) counts.set(sid, (counts.get(sid) ?? 0) + 1);
    }
    return counts;
  });

  // Each stored incident is claimed by exactly one cluster: the one sharing the most complaints.
  const claims = new Map<number, string[]>();
  for (const s of active) {
    let best = -1;
    let bestCount = 0;
    clusters.forEach((cluster, k) => {
      const count = overlap[k].get(s.incident.id) ?? 0;
      if (count === 0) return;
      const better =
        best === -1 ||
        count > bestCount ||
        (count === bestCount &&
          (cluster.firstReportedAt < clusters[best].firstReportedAt ||
            (cluster.firstReportedAt === clusters[best].firstReportedAt && cluster.id < clusters[best].id)));
      if (better) {
        best = k;
        bestCount = count;
      }
    });
    if (best !== -1) claims.set(best, [...(claims.get(best) ?? []), s.incident.id]);
  }

  const out: StoredIncident[] = [];
  const claimed = new Set<string>();

  clusters.forEach((cluster, k) => {
    const mine = (claims.get(k) ?? []).map((id) => byId.get(id)!).sort(oldestFirst);

    if (mine.length === 0) {
      const id = uniqueId(cluster.id, takenIds);
      takenIds.add(id);
      out.push({ incident: { ...cluster, id }, status: 'open', detectedAt: now, updatedAt: now });
      return;
    }

    const [survivor, ...absorbed] = mine;
    const escalated = mine.some((s) => s.status === 'escalated');
    out.push({
      ...survivor,
      incident: { ...cluster, id: survivor.incident.id },
      status: escalated ? 'escalated' : 'open',
      updatedAt: now,
    });
    for (const a of absorbed) {
      out.push({ ...a, status: 'merged', mergedInto: survivor.incident.id, updatedAt: now });
    }
    for (const s of mine) claimed.add(s.incident.id);
  });

  for (const s of active) {
    if (claimed.has(s.incident.id)) continue;
    out.push({ ...s, status: 'resolved', resolution: 'expired', resolvedAt: now, updatedAt: now });
  }
  return out;
}

function uniqueId(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  let n = 2;
  while (taken.has(`${wanted}#${n}`)) n++;
  return `${wanted}#${n}`;
}
