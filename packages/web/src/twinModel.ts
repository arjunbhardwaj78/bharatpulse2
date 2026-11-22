import type { Asset, City, Incident } from './api';

/**
 * What the 3D city twin shows, worked out from the public city map and the open incidents. Pure: no three.js here.
 * Coordinates are scene units (x east, z south), centred on the wards.
 */
export interface TwinWard { id: string; name: string; zone: string; x: number; z: number; r: number; state: 'ok' | 'hit' | 'risk' }
export interface TwinAsset { id: string; kind: Asset['kind']; name: string; x: number; z: number; suspect: boolean }
export interface TwinPipe { from: string; to: string; pts: [number, number][]; state: 'flow' | 'suspect' | 'dry' }
export interface TwinBeacon { id: string; x: number; z: number; level: string; score: number; held: boolean; reports: number; people: number; family: string; ward?: string; what: string }
export interface TwinModel { wards: TwinWard[]; assets: TwinAsset[]; pipes: TwinPipe[]; beacons: TwinBeacon[]; suspect?: TwinAsset; atRisk: string[]; span: number }

const WHAT: Record<string, string> = { NO_WATER: 'No water', LOW_PRESSURE: 'Low pressure', DIRTY_WATER: 'Dirty water', LEAK: 'Leak', POTHOLE: 'Pothole', WATERLOGGING: 'Waterlogging', SEWAGE_OVERFLOW: 'Sewage', OTHER_WATER: 'Water problem', OTHER_ROAD: 'Road problem' };
export const whatOf = (i: Incident): string => WHAT[Object.entries(i.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTHER_WATER'] ?? 'Problem';

export function twinModel(city: City, incidents: Incident[]): TwinModel {
  const pts = [...city.localities, ...(city.assets ?? [])];
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / Math.max(1, pts.length);
  const lng0 = pts.reduce((s, p) => s + p.lng, 0) / Math.max(1, pts.length);
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const reach = Math.max(400, ...pts.map((p) => Math.hypot((p.lng - lng0) * mx, (p.lat - lat0) * 110_540)));
  const k = 13 / reach; // the town fits in a 13-unit radius
  const xz = (p: { lat: number; lng: number }): [number, number] => [(p.lng - lng0) * mx * k, -(p.lat - lat0) * 110_540 * k];

  // Which zones each pipe serves, directly or through the pipes it feeds (the same walk the Neo4j root-cause query does).
  const assets = city.assets ?? [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const covers = new Map<string, Set<string>>();
  const cover = (id: string, seen = new Set<string>()): Set<string> => {
    if (covers.has(id)) return covers.get(id)!;
    const a = byId.get(id);
    const out = new Set<string>(a?.supplies ?? []);
    if (a && !seen.has(id)) { seen.add(id); for (const f of a.feeds) for (const z of cover(f, seen)) out.add(z); }
    covers.set(id, out);
    return out;
  };

  const nearestWard = (p: { lat: number; lng: number }) => [...city.localities].sort((a, b) => Math.hypot(a.lat - p.lat, a.lng - p.lng) - Math.hypot(b.lat - p.lat, b.lng - p.lng))[0];
  const open = incidents.filter((i) => ['open', 'escalated'].includes(i.status));
  const real = open.filter((i) => !i.trust.needsVerification);
  const hitZones = new Set(real.filter((i) => i.family === 'SUPPLY').map((i) => nearestWard(i.centroid)?.zoneId).filter((z): z is string => !!z));
  let suspectId: string | undefined;
  if (hitZones.size >= 2) {
    const fits = assets.filter((a) => a.kind === 'PIPE' && [...hitZones].every((z) => cover(a.id).has(z))).sort((a, b) => cover(a.id).size - cover(b.id).size);
    suspectId = fits[0]?.id;
  }
  const below = new Set<string>(); // assets downstream of the suspect: water stops there
  const walk = (id: string) => { for (const f of byId.get(id)?.feeds ?? []) if (!below.has(f)) { below.add(f); walk(f); } };
  if (suspectId) walk(suspectId);
  const riskZones = suspectId ? [...cover(suspectId)].filter((z) => !hitZones.has(z)) : [];

  const wardSpacing = (w: { lat: number; lng: number }) => {
    const [x, z] = xz(w);
    const d = Math.min(...city.localities.filter((o) => o !== w).map((o) => { const [a, b] = xz(o); return Math.hypot(a - x, b - z); }));
    return Math.max(1.2, Math.min(3.2, (Number.isFinite(d) ? d : 6) * 0.45));
  };
  const wards: TwinWard[] = city.localities.map((l) => {
    const [x, z] = xz(l);
    return { id: l.id, name: l.name, zone: l.zoneId, x, z, r: wardSpacing(l), state: hitZones.has(l.zoneId) && real.some((i) => i.family === 'SUPPLY' && nearestWard(i.centroid)?.id === l.id) ? 'hit' : riskZones.includes(l.zoneId) || (suspectId && hitZones.has(l.zoneId)) ? 'risk' : 'ok' };
    // a ward with no reports of its own, on the same failed feeder as a ward without water, is at risk
  });
  const tAssets: TwinAsset[] = assets.map((a) => { const [x, z] = xz(a); return { id: a.id, kind: a.kind, name: a.name, x, z, suspect: a.id === suspectId }; });

  // Pipes run along streets: east-west first, then north-south.
  const elbow = (a: [number, number], b: [number, number]): [number, number][] => [a, [b[0], a[1]], b];
  const pipes: TwinPipe[] = [];
  for (const a of assets) {
    const from = xz(a);
    const st: TwinPipe['state'] = below.has(a.id) ? 'dry' : a.id === suspectId ? 'suspect' : 'flow';
    for (const f of a.feeds) { const b = byId.get(f); if (b) pipes.push({ from: a.id, to: f, pts: elbow(from, xz(b)), state: st }); }
    for (const z of a.supplies) for (const l of city.localities.filter((x) => x.zoneId === z)) pipes.push({ from: a.id, to: l.id, pts: elbow(from, xz(l)), state: st });
  }

  const beacons: TwinBeacon[] = open.map((i) => {
    const [x, z] = xz(i.centroid);
    return { id: i.id, x, z, level: i.severity.level, score: Math.round(i.severity.score), held: i.trust.needsVerification, reports: i.complaintCount, people: i.trust.independentSources, family: i.family, ward: nearestWard(i.centroid)?.name, what: whatOf(i) };
  }).sort((a, b) => b.score - a.score);

  return { wards, assets: tAssets, pipes, beacons, suspect: tAssets.find((a) => a.suspect), atRisk: wards.filter((w) => w.state === 'risk').map((w) => w.name), span: 13 };
}
