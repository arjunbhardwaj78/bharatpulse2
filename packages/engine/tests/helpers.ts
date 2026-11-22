import { MINUTE } from '../src/config.js';
import type { Cluster, Complaint, IssueType } from '../src/types.js';

/** A fixed "now" (12 Oct 2026, 12:00 UTC) so every test is reproducible. */
export const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
/** A point in Mathura, used as the centre of every test scenario. */
export const BASE = { lat: 27.4924, lng: 77.6737 };

const METRES_PER_DEG_LAT = 111_195;

interface Spec {
  id: string;
  reporter?: string;
  type?: IssueType;
  /** Metres north / east of BASE. */
  north?: number;
  east?: number;
  minutesAgo?: number;
  extra?: Partial<Complaint>;
}

export function complaint(spec: Spec): Complaint {
  const dLat = (spec.north ?? 0) / METRES_PER_DEG_LAT;
  const dLng = (spec.east ?? 0) / (METRES_PER_DEG_LAT * Math.cos((BASE.lat * Math.PI) / 180));
  return {
    id: spec.id,
    reporterId: spec.reporter ?? `user-${spec.id}`,
    issueType: spec.type ?? 'NO_WATER',
    lat: BASE.lat + dLat,
    lng: BASE.lng + dLng,
    createdAt: NOW - (spec.minutesAgo ?? 0) * MINUTE,
    ...spec.extra,
  };
}

/** `count` complaints spread within `spreadM` metres, reported across `spanMin` minutes. */
export function group(prefix: string, count: number, o: { north?: number; east?: number; spreadM?: number; minutesAgo?: number; spanMin?: number; type?: IssueType; extra?: (i: number) => Partial<Complaint> } = {}): Complaint[] {
  return Array.from({ length: count }, (_, i) =>
    complaint({
      id: `${prefix}${i + 1}`,
      type: o.type,
      extra: o.extra?.(i),
      north: (o.north ?? 0) + ((i * (o.spreadM ?? 100)) / Math.max(1, count - 1)),
      east: o.east ?? 0,
      minutesAgo: (o.minutesAgo ?? 30) + ((count - 1 - i) * (o.spanMin ?? 20)) / Math.max(1, count - 1),
    }),
  );
}

export function fakeCluster(o: Partial<Cluster> & { recent?: number; ageMin?: number } = {}): Cluster {
  const count = o.complaintCount ?? 10;
  const first = NOW - (o.ageMin ?? 60) * MINUTE;
  const recent = o.recent ?? 0;
  const reportedAt = Array.from({ length: count }, (_, i) =>
    i >= count - recent ? NOW - 5 * MINUTE : first + i * MINUTE,
  ).sort((a, b) => a - b);
  return {
    id: 'SUPPLY:c1',
    family: 'SUPPLY',
    complaintIds: reportedAt.map((_, i) => `c${i + 1}`),
    reportedAt,
    issueBreakdown: { NO_WATER: count },
    centroid: BASE,
    radiusMeters: 200,
    complaintCount: count,
    firstReportedAt: reportedAt[0],
    lastReportedAt: reportedAt[reportedAt.length - 1],
    ...o,
  } as Cluster;
}
