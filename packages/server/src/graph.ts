import { createHash } from 'node:crypto';
import { haversineMeters, type Complaint } from '@bharatpulse/engine';
import type { City } from './data.js';
import { isActive, type StoredIncident } from './types.js';

export interface GraphNode { id: string; type: 'Incident' | 'Complaint' | 'Reporter' | 'Device' | 'Photo'; label: string; ring?: string }
export interface GraphEdge { from: string; to: string; type: 'FILED' | 'FROM_DEVICE' | 'HAS_PHOTO' | 'PART_OF' }
/** Device ids are client secrets: never show them, only a short fingerprint. */
export const maskDevice = (d: string): string => createHash('sha256').update(d).digest('hex').slice(0, 6);
export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Devices used by more than 2 different reporters (across all history). These collapse into one source. */
  sharedDevices: { deviceId: string; reporters: number }[];
}
export interface Downstream { zone: string; hops: number; localities: string[] }

/** The incident's complaints as a graph. `all` is every complaint, used to count devices across incidents. */
export function buildSubgraph(incidentId: string, members: readonly Complaint[], all: readonly Complaint[]): Subgraph {
  const nodes = new Map<string, GraphNode>([[incidentId, { id: incidentId, type: 'Incident', label: incidentId }]]);
  const edges: GraphEdge[] = [];
  const node = (n: GraphNode): void => void nodes.set(n.id, n);
  for (const c of members) {
    node({ id: c.id, type: 'Complaint', label: c.issueType });
    node({ id: c.reporterId, type: 'Reporter', label: c.reporterId });
    edges.push({ from: c.reporterId, to: c.id, type: 'FILED' }, { from: c.id, to: incidentId, type: 'PART_OF' });
    if (c.deviceId) { const d = `dev:${maskDevice(c.deviceId)}`; node({ id: d, type: 'Device', label: `phone ${maskDevice(c.deviceId)}` }); edges.push({ from: c.id, to: d, type: 'FROM_DEVICE' }); }
    for (const h of c.photoHashes ?? []) { node({ id: `photo:${h}`, type: 'Photo', label: h.slice(0, 8) }); edges.push({ from: c.id, to: `photo:${h}`, type: 'HAS_PHOTO' }); }
  }
  const perDevice = new Map<string, Set<string>>();
  for (const c of all) if (c.deviceId) perDevice.set(c.deviceId, (perDevice.get(c.deviceId) ?? new Set()).add(c.reporterId));
  const sharedDevices = members
    .map((c) => c.deviceId)
    .filter((d, i, a): d is string => !!d && a.indexOf(d) === i && (perDevice.get(d)?.size ?? 0) > 2)
    .map((deviceId) => ({ deviceId: maskDevice(deviceId), reporters: perDevice.get(deviceId)!.size }));
  return { nodes: [...nodes.values()], edges, sharedDevices };
}

/** Localities that lose water next if `zone` fails: follow FEEDS up to `hops` steps (breadth-first, shortest path wins). */
export function downstream(city: City, zone: string, hops: number): Downstream[] {
  const seen = new Map<string, number>([[zone, 0]]);
  let frontier = [zone];
  for (let h = 1; h <= hops; h++) {
    frontier = frontier.flatMap((z) => city.zones.find((x) => x.id === z)?.feeds ?? []).filter((z) => !seen.has(z));
    for (const z of frontier) seen.set(z, h);
  }
  return [...seen].filter(([, h]) => h > 0).map(([z, h]) => ({ zone: z, hops: h, localities: city.localities.filter((l) => l.zoneId === z).map((l) => l.id) }));
}

const WEEK = 7 * 24 * 3_600_000;

/** A road incident within 100 m of a leak that was first reported in the 7 days before it. */
export function findCause(road: StoredIncident, others: readonly StoredIncident[]): StoredIncident['possibleCause'] {
  if (road.incident.family !== 'ROAD') return undefined;
  const hit = others
    .filter((o) => o.incident.family === 'INFRASTRUCTURE' && o.incident.firstReportedAt <= road.incident.lastReportedAt && road.incident.firstReportedAt - o.incident.firstReportedAt <= WEEK)
    .map((o) => ({ o, d: haversineMeters(o.incident.centroid, road.incident.centroid) }))
    .filter(({ d }) => d <= 100)
    .sort((a, b) => a.d - b.d)[0];
  return hit && { incidentId: hit.o.incident.id, distanceM: Math.round(hit.d), confirmed: road.possibleCause?.incidentId === hit.o.incident.id ? road.possibleCause.confirmed : undefined };
}


// ---------------------------------------------------------------------------------------------
// Graph features. Neo4jStore answers these with Cypher (see cypher.ts); the functions below give the
// same answers in plain TypeScript for MemoryStore (tests, no-database demo). The smoke script compares both.
// ---------------------------------------------------------------------------------------------

/** Two accounts linked by a shared phone, a shared photo, or by reporting together in places far apart. */
export interface Link { a: string; b: string; via: 'DEVICE' | 'PHOTO' | 'CO_REPORTING' }
export interface Ring { id: string; accounts: string[]; via: string[] }

/** How far apart two incidents must be before "the same people reported both" looks like a hired crowd, not neighbours. */
export const FAR_M = 2000;

/** Memory version of Q.deviceAndPhotoLinks + Q.coReportingLinks. */
export function linksFrom(complaints: readonly Complaint[], incidents: readonly StoredIncident[]): Link[] {
  const out = new Map<string, Link>();
  const add = (a: string, b: string, via: Link['via']) => { if (a === b) return; const [x, y] = a < b ? [a, b] : [b, a]; out.set(`${x}|${y}|${via}`, { a: x, b: y, via }); };
  const by = new Map<string, Set<string>>();
  for (const c of complaints) {
    const keys = [...(c.deviceId ? [`DEVICE|${c.deviceId}`] : []), ...(c.photoHashes ?? []).map((h) => `PHOTO|${h}`)];
    for (const k of keys) by.set(k, (by.get(k) ?? new Set()).add(c.reporterId));
  }
  for (const [k, set] of by) { const rs = [...set]; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) add(rs[i], rs[j], k.split('|')[0] as Link['via']); }

  const reporterOf = new Map(complaints.map((c) => [c.id, c.reporterId]));
  const live = incidents.filter((s) => s.status !== 'merged');
  const shared = new Map<string, StoredIncident[]>();
  for (const s of live) {
    const rs = [...new Set(s.incident.complaintIds.map((id) => reporterOf.get(id)).filter((r): r is string => !!r))].sort();
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const k = `${rs[i]}|${rs[j]}`; shared.set(k, [...(shared.get(k) ?? []), s]); }
  }
  for (const [k, list] of shared) {
    if (list.length < 2) continue;
    const far = list.some((x) => list.some((y) => haversineMeters(x.incident.centroid, y.incident.centroid) > FAR_M));
    if (far) { const [a, b] = k.split('|'); add(a, b, 'CO_REPORTING'); }
  }
  return [...out.values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.via.localeCompare(y.via));
}

/**
 * Groups linked accounts into rings (connected components). Only rings of 3+ accounts are returned:
 * two people sharing a phone is a family; three or more accounts tied together is a pattern.
 */
export function ringsFrom(links: readonly Link[], min = 3): Ring[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const l of links) { parent.set(l.a, parent.get(l.a) ?? l.a); parent.set(l.b, parent.get(l.b) ?? l.b); const [ra, rb] = [find(l.a), find(l.b)]; if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
  const groups = new Map<string, { accounts: Set<string>; via: Set<string> }>();
  for (const l of links) { const r = find(l.a); const g = groups.get(r) ?? { accounts: new Set(), via: new Set() }; g.accounts.add(l.a).add(l.b); g.via.add(l.via); groups.set(r, g); }
  return [...groups.entries()].filter(([, g]) => g.accounts.size >= min).map(([root, g]) => ({ id: `ring:${createHash('sha256').update(root).digest('hex').slice(0, 8)}`, accounts: [...g.accounts].sort(), via: [...g.via].sort() })).sort((a, b) => b.accounts.length - a.accounts.length || a.id.localeCompare(b.id));
}

/** One possible failure point in the water network, and which affected zones it explains. */
export interface Suspect { assetId: string; name: string; kind: string; covers: string[]; distance: number }
export interface RootCause {
  /** Zones with a trusted, open water-supply or water-quality incident. */
  zonesHit: string[];
  incidents: string[];
  /** Best first: explains the most zones, and is closest to them. */
  suspects: Suspect[];
  /** Wards fed by the top suspect that have not complained yet: warn them before they call. */
  atRisk: { localityId: string; name: string; zone: string }[];
}

const WATER_FAMILIES = ['SUPPLY', 'QUALITY'];
export const isRootCauseIncident = (s: StoredIncident): boolean => isActive(s) && WATER_FAMILIES.includes(s.incident.family) && !s.incident.trust.needsVerification;

/** Every zone an asset reaches, with the fewest hops (FEEDS between assets, then SUPPLIES into a zone). */
export function reach(city: City, assetId: string): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set([assetId]);
  let frontier = [assetId];
  for (let d = 1; d <= 6 && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const a = city.assets.find((x) => x.id === id);
      if (!a) continue;
      for (const z of a.supplies) if (!out.has(z)) out.set(z, d);
      for (const f of a.feeds) if (!seen.has(f)) { seen.add(f); next.push(f); }
    }
    frontier = next;
  }
  return out;
}

/** Memory version of Q.rootCause + Q.atRisk. */
export function rootCauseFrom(city: City, incidents: readonly StoredIncident[], wardOfPoint: (lat: number, lng: number) => { id: string; zoneId: string } | undefined): RootCause {
  const hit = incidents.filter(isRootCauseIncident).map((s) => ({ s, ward: wardOfPoint(s.incident.centroid.lat, s.incident.centroid.lng) })).filter((x) => x.ward);
  const zonesHit = [...new Set(hit.map((x) => x.ward!.zoneId))].sort();
  const suspects: Suspect[] = zonesHit.length === 0 ? [] : city.assets.map((a) => {
    const r = reach(city, a.id);
    const covers = zonesHit.filter((z) => r.has(z));
    return { assetId: a.id, name: a.name, kind: a.kind, covers, distance: covers.reduce((t, z) => t + r.get(z)!, 0) };
  }).filter((x) => x.covers.length > 0).sort((a, b) => b.covers.length - a.covers.length || a.distance - b.distance || a.assetId.localeCompare(b.assetId)).slice(0, 3);
  const hitLocalities = new Set(hit.map((x) => x.ward!.id));
  const top = suspects[0];
  const atRisk = top ? city.localities.filter((l) => reach(city, top.assetId).has(l.zoneId) && !hitLocalities.has(l.id)).map((l) => ({ localityId: l.id, name: l.name, zone: l.zoneId })) : [];
  return { zonesHit, incidents: hit.map((x) => x.s.incident.id).sort(), suspects, atRisk };
}

/** The whole picture for the officer's Graph page: water network, wards, open incidents, and fake-report rings. */
export interface OverviewNode { id: string; type: 'Asset' | 'Zone' | 'Locality' | 'Incident' | 'Ring' | 'Reporter' | 'Device' | 'Photo'; label: string; kind?: string; level?: string; flag?: string; lat?: number; lng?: number }
export interface OverviewEdge { from: string; to: string; type: string }
export interface Overview { nodes: OverviewNode[]; edges: OverviewEdge[] }

/** Memory version of the overview queries. `rings` comes from ringsFrom(linksFrom(...)). */
export function overviewFrom(city: City, incidents: readonly StoredIncident[], complaints: readonly Complaint[], rings: readonly Ring[], wardOfPoint: (lat: number, lng: number) => { id: string } | undefined): Overview {
  const nodes: OverviewNode[] = [];
  const edges: OverviewEdge[] = [];
  for (const a of city.assets) { nodes.push({ id: a.id, type: 'Asset', label: a.name, kind: a.kind, lat: a.lat, lng: a.lng }); for (const f of a.feeds) edges.push({ from: a.id, to: f, type: 'FEEDS' }); for (const z of a.supplies) edges.push({ from: a.id, to: z, type: 'SUPPLIES' }); }
  for (const z of city.zones) nodes.push({ id: z.id, type: 'Zone', label: z.name });
  for (const l of city.localities) { nodes.push({ id: l.id, type: 'Locality', label: l.name, lat: l.lat, lng: l.lng }); edges.push({ from: l.id, to: l.zoneId, type: 'PART_OF' }); }
  const ringOf = new Map<string, string>();
  for (const r of rings) for (const a of r.accounts) ringOf.set(a, r.id);
  const reporterOf = new Map(complaints.map((c) => [c.id, c]));
  for (const s of incidents.filter(isActive)) {
    const id = s.incident.id;
    const issue = Object.entries(s.incident.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.incident.family;
    nodes.push({ id, type: 'Incident', label: issue, kind: s.incident.family, level: s.incident.severity.level, flag: s.incident.trust.needsVerification ? 'unverified' : undefined, lat: s.incident.centroid.lat, lng: s.incident.centroid.lng });
    const w = wardOfPoint(s.incident.centroid.lat, s.incident.centroid.lng);
    if (w) edges.push({ from: id, to: w.id, type: 'AFFECTS' });
    const ringsHere = new Set(s.incident.complaintIds.map((c) => ringOf.get(reporterOf.get(c)?.reporterId ?? '')).filter((r): r is string => !!r));
    for (const r of ringsHere) edges.push({ from: r, to: id, type: 'TARGETS' });
  }
  for (const r of rings) {
    nodes.push({ id: r.id, type: 'Ring', label: `${r.accounts.length} linked accounts`, kind: r.via.join(', ') });
  }
  return { nodes, edges };
}
