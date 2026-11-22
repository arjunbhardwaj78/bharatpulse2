import { MINUTE, type Incident, type IssueFamily } from '@bharatpulse/engine';
import type { StoredIncident } from '../src/types.js';

/** 12 Oct 2026, 12:00 UTC. Every test starts here so results are reproducible. */
export const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
export const BASE = { lat: 27.4924, lng: 77.6737 };
const METRES_PER_DEG_LAT = 111_195;

/** A clock the test controls. */
export class FakeClock {
  constructor(public time = T0) {}
  now = (): number => this.time;
  advance(minutes: number): void {
    this.time += minutes * MINUTE;
  }
}

/** Body of a POST /complaints, placed `north` metres north of BASE. */
export function body(reporter: string, north = 0, type = 'NO_WATER') {
  return { reporterId: reporter, issueType: type, lat: BASE.lat + north / METRES_PER_DEG_LAT, lng: BASE.lng };
}

/** Sequential, predictable complaint ids: c1, c2, ... */
export function counterIds(): () => string {
  let n = 0;
  return () => `c${++n}`;
}

/** Awaits a promise that should fail and returns the error. */
export async function failure(promise: Promise<unknown>): Promise<{ statusCode?: number; code?: string; details?: unknown }> {
  try {
    await promise;
  } catch (e) {
    return e as { statusCode?: number; code?: string; details?: unknown };
  }
  throw new Error('expected the promise to fail, but it succeeded');
}

/** A hand-made engine incident, just enough for reconcile tests. */
export function fakeIncident(id: string, complaintIds: string[], o: { family?: IssueFamily; firstReportedAt?: number; score?: number } = {}): Incident {
  return {
    id,
    family: o.family ?? 'SUPPLY',
    complaintIds,
    reportedAt: complaintIds.map((_, i) => (o.firstReportedAt ?? T0) + i),
    issueBreakdown: { NO_WATER: complaintIds.length },
    centroid: BASE,
    radiusMeters: 100,
    complaintCount: complaintIds.length,
    firstReportedAt: o.firstReportedAt ?? T0,
    lastReportedAt: (o.firstReportedAt ?? T0) + complaintIds.length,
    severity: { score: o.score ?? 50, level: 'HIGH', factors: [], base: o.score ?? 50, credibility: 1 },
    trust: { rawReports: 3, independentSources: 3, trustedSources: 3, nEff: 3, credibility: 1, needsVerification: false, bands: { TRUSTED: 3, REVIEW: 0, LIKELY_FAKE: 0 }, authenticity: [] },
    recommendedAction: 'test',
  };
}

export function fakeStored(id: string, complaintIds: string[], o: Partial<StoredIncident> & { family?: IssueFamily } = {}): StoredIncident {
  const { family, ...rest } = o;
  return { incident: fakeIncident(id, complaintIds, { family }), status: 'open', detectedAt: T0, updatedAt: T0, ...rest };
}

/** A fake Sarvam API: `routes` maps a path ("/translate") to the JSON it answers (or a function of the request body). */
export function fakeSarvamFetch(routes: Record<string, unknown | ((body: unknown) => unknown)>, seen: { path: string; body: unknown }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    seen.push({ path, body });
    const r = routes[path];
    if (r === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(typeof r === 'function' ? (r as (b: unknown) => unknown)(body) : r));
  }) as unknown as typeof fetch;
}
