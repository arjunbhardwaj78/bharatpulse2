import { cfgFor, type EngineConfig } from './config.js';
import { centroid, haversineMeters, radiusAround } from './geo.js';
import { FAMILY_OF, type Cluster, type Complaint, type IssueFamily, type IssueType, type RoadClass } from './types.js';

export interface ClusterOutput {
  clusters: Cluster[];
  /** Complaints that did not join any cluster (too few neighbours). */
  noise: Complaint[];
}

const UNVISITED = -2;
const NOISE = -1;

const byTimeThenId = (a: Complaint, b: Complaint): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/**
 * Spatio-temporal DBSCAN, run separately for each issue family.
 *
 * Two complaints are neighbours when they are within `epsMeters` AND within
 * `timeWindowMs` of each other. A complaint with at least `minComplaints`
 * neighbours (counting itself) is a "core" point and starts or grows a cluster.
 * Complaints reachable from a core point join its cluster; the rest are noise.
 *
 * Why DBSCAN: we do not know how many incidents exist in advance, and outages
 * are irregular shapes (a pipe run, not a circle). It also naturally ignores
 * lone complaints. Because neighbours chain together, an outage that spreads
 * along a street stays one incident.
 *
 * Radius, time window and minimum size are per family (see `cfgFor`): a pothole
 * is a 40 m spot that stays for weeks, a pipe failure is a wide area for hours.
 *
 * Complexity is O(n^2) per family, fine for a city-ward window of a few
 * thousand live complaints. A spatial grid index is the upgrade path.
 */
export function clusterComplaints(complaints: readonly Complaint[], cfg: EngineConfig): ClusterOutput {
  const byFamily = new Map<IssueFamily, Complaint[]>();
  for (const c of complaints) {
    const family = FAMILY_OF[c.issueType];
    const list = byFamily.get(family);
    if (list) list.push(c);
    else byFamily.set(family, [c]);
  }

  const clusters: Cluster[] = [];
  const noise: Complaint[] = [];

  const families = [...byFamily.keys()].sort();
  for (const family of families) {
    const points = [...(byFamily.get(family) as Complaint[])].sort(byTimeThenId);
    const labels = dbscan(points, cfgFor(cfg, family));

    const groups = new Map<number, Complaint[]>();
    labels.forEach((label, i) => {
      if (label === NOISE) {
        noise.push(points[i]);
        return;
      }
      const group = groups.get(label);
      if (group) group.push(points[i]);
      else groups.set(label, [points[i]]);
    });
    for (const members of groups.values()) clusters.push(buildCluster(family, members));
  }

  clusters.sort((a, b) => a.id.localeCompare(b.id));
  noise.sort(byTimeThenId);
  return { clusters, noise };
}

function dbscan(points: readonly Complaint[], cfg: EngineConfig): number[] {
  const labels: number[] = new Array(points.length).fill(UNVISITED);

  const neighboursOf = (i: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < points.length; j++) {
      if (
        Math.abs(points[j].createdAt - points[i].createdAt) <= cfg.timeWindowMs &&
        haversineMeters(points[i], points[j]) <= cfg.epsMeters
      ) {
        out.push(j);
      }
    }
    return out; // includes i itself
  };

  let clusterId = 0;
  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== UNVISITED) continue;

    const seeds = neighboursOf(i);
    if (seeds.length < cfg.minComplaints) {
      labels[i] = NOISE;
      continue;
    }

    labels[i] = clusterId;
    const queue = seeds.filter((j) => j !== i);
    for (let head = 0; head < queue.length; head++) {
      const j = queue[head];
      if (labels[j] === NOISE) labels[j] = clusterId; // border point: reachable, not core
      if (labels[j] !== UNVISITED) continue;
      labels[j] = clusterId;
      const next = neighboursOf(j);
      if (next.length >= cfg.minComplaints) queue.push(...next);
    }
    clusterId++;
  }
  return labels;
}

function buildCluster(family: IssueFamily, members: readonly Complaint[]): Cluster {
  const center = centroid(members);
  const issueBreakdown: Partial<Record<IssueType, number>> = {};
  for (const m of members) issueBreakdown[m.issueType] = (issueBreakdown[m.issueType] ?? 0) + 1;

  const reportedAt = members.map((m) => m.createdAt); // members arrive time-sorted
  return {
    ...(family === 'ROAD' && { road: roadFacts(members) }),
    id: `${family}:${members[0].id}`,
    family,
    complaintIds: members.map((m) => m.id),
    reportedAt,
    issueBreakdown,
    centroid: center,
    radiusMeters: radiusAround(center, members),
    complaintCount: members.length,
    firstReportedAt: reportedAt[0],
    lastReportedAt: reportedAt[reportedAt.length - 1],
  };
}

const ROAD_RANK: Record<RoadClass, number> = { LOCAL: 0, MAIN: 1, HIGHWAY: 2 };

function roadFacts(members: readonly Complaint[]): NonNullable<Cluster['road']> {
  const roadClass = members.reduce<RoadClass>((best, m) => (ROAD_RANK[m.roadClass ?? 'LOCAL'] > ROAD_RANK[best] ? (m.roadClass as RoadClass) : best), 'LOCAL');
  return {
    size: Math.max(1, ...members.map((m) => m.size ?? 1)),
    roadClass,
    nearFacility: members.some((m) => m.nearFacility),
    photoShare: members.filter((m) => m.photoHashes?.length).length / members.length,
  };
}
