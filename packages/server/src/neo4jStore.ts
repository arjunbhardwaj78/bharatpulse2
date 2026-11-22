import { createHash } from 'node:crypto';
import { FAMILY_OF, haversineMeters, type Complaint } from '@bharatpulse/engine';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import { Q, SCHEMA, TENANT_LABELS } from './cypher.js';
import { CITY, wardOf, type City } from './data.js';
import { FAR_M, type Downstream, type GraphEdge, type GraphNode, type Link, type Overview, type OverviewNode, type Ring, type RootCause, type Subgraph } from './graph.js';
import type { IncidentStore, WardStatus } from './store.js';
import type { Checkin, Notice, Profile, StoredIncident } from './types.js';

const num = (v: unknown): number => (neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : (v as number));
/** Phones are stored as a one-way fingerprint: the graph only needs "same phone or not". */
const deviceKey = (d: string): string => createHash('sha256').update(d).digest('hex').slice(0, 16);
const parse = <T>(s: unknown): T => JSON.parse(String(s)) as T;

/** Connection settings, from the variables in Aura's credentials file. */
export interface Neo4jConfig { uri: string; user: string; password: string; database?: string }
const SCHEMES = ['neo4j+s', 'neo4j+ssc', 'neo4j', 'bolt+s', 'bolt+ssc', 'bolt'];
/** The host of a Neo4j URI, for logs and messages (never the credentials). */
export const hostOf = (uri: string): string => uri.replace(/^[a-z0-9+.-]+:\/\//i, '').replace(/^[^@/]*@/, '').split(/[/:?]/)[0];

/**
 * Reads NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD and NEO4J_DATABASE. NEO4J_USER (older .env files, render.yaml)
 * still works as the username. Returns undefined when NEO4J_URI is empty; throws a clear error when it is set but unusable.
 */
export function neo4jConfigFromEnv(env: Record<string, string | undefined> = process.env): Neo4jConfig | undefined {
  const uri = env.NEO4J_URI?.trim();
  if (!uri) return undefined;
  const scheme = uri.includes('://') ? uri.slice(0, uri.indexOf('://')).toLowerCase() : '';
  if (!SCHEMES.includes(scheme)) throw new Error(`NEO4J_URI must start with neo4j+s:// for Neo4j Aura (allowed: ${SCHEMES.map((x) => `${x}://`).join(', ')}).`);
  const host = hostOf(uri);
  if (/\.neo4j\.io$/i.test(host) && !/\+s(sc)?$/.test(scheme)) throw new Error(`Neo4j Aura only accepts encrypted connections: set NEO4J_URI=neo4j+s://${host}`);
  const password = env.NEO4J_PASSWORD ?? '';
  if (!password) throw new Error('NEO4J_URI is set but NEO4J_PASSWORD is empty. Use the password from the credentials file Aura gave you when the instance was created.');
  return { uri, user: env.NEO4J_USERNAME?.trim() || env.NEO4J_USER?.trim() || 'neo4j', password, database: env.NEO4J_DATABASE?.trim() || undefined };
}

/** The database each driver talks to (NEO4J_DATABASE; undefined = the instance's default, "neo4j" on Aura). */
const DATABASE = new WeakMap<Driver, string | undefined>();

/** Turns a driver error into a message that says what to fix. Never includes the password. */
function explain(e: unknown, uri: string, database: string | undefined): string {
  const code = (e as { code?: string }).code ?? '';
  const host = hostOf(uri);
  if (code === 'Neo.ClientError.Security.Unauthorized') return `Neo4j at ${host} refused the username or password. Check NEO4J_USERNAME and NEO4J_PASSWORD against your Aura credentials file.`;
  if (code === 'Neo.ClientError.Security.AuthenticationRateLimit') return `Neo4j at ${host} is blocking sign-in after too many wrong passwords. Wait a few minutes, then check NEO4J_PASSWORD.`;
  if (code === 'Neo.ClientError.Database.DatabaseNotFound') return `Database "${database}" does not exist on ${host}. An Aura instance has one database, normally "neo4j": set NEO4J_DATABASE=neo4j or leave it empty.`;
  if (code === 'ServiceUnavailable' || code === 'SessionExpired') return `Could not reach Neo4j at ${host}. Check NEO4J_URI, that the Aura instance is running (a paused Aura Free instance must be resumed in console.neo4j.io), and that this network allows outgoing connections on port 7687. (${(e as Error).message})`;
  return `Neo4j at ${host}: ${(e as Error).message}${code ? ` (${code})` : ''}`;
}

/**
 * Neo4j Aura storage (neo4j+s://, NEO4J_DATABASE on every query and session). The graph is the product here:
 *  - complaints, reporters, phones, photos, wards, zones and the water network are nodes with real properties
 *    (point locations with a spatial index, timestamps with a range index), so the questions below are Cypher, not code;
 *  - fake-report rings, root cause up the water network, downstream impact, "did the last fix hold" and the
 *    incident graph are all answered by the queries in cypher.ts.
 * Complaints and incidents also keep their full JSON in `data`, so reading one back into the engine is one lookup.
 * Run `npm run neo4j:smoke` once with your credentials: it checks every answer against MemoryStore.
 */
export class Neo4jStore implements IncidentStore {
  readonly kind = 'neo4j' as const;
  private readonly database: string | undefined;
  private constructor(private readonly driver: Driver, private readonly city: City, readonly tenant: string) { this.database = DATABASE.get(driver); }

  /**
   * One driver for the whole platform; every city gets its own store on it (see forTenant). Checks the connection and
   * credentials first and creates the indexes/constraints (additive only: `IF NOT EXISTS`, nothing is dropped).
   * On any failure the driver is closed and the error says what to fix.
   */
  static async openDriver(uri: string, user: string, password: string, database?: string): Promise<Driver> {
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { disableLosslessIntegers: true });
    DATABASE.set(driver, database);
    try {
      await driver.verifyConnectivity({ database });
    } catch (e) {
      await driver.close().catch(() => undefined);
      throw new Error(explain(e, uri, database), { cause: e });
    }
    try {
      const legacy = (await driver.executeQuery(Q.legacyIdConstraints, {}, { routing: neo4j.routing.READ, database })).records
        .filter((r) => TENANT_LABELS.includes(r.get('label') as string)).map((r) => r.get('name') as string);
      if (legacy.length) console.warn(`Neo4j: constraint(s) ${legacy.join(', ')} make ids unique across ALL cities, so a second city or partner organisation cannot be saved. They are left untouched. If an older BharatPulse build created them, remove them in the Aura console: ${legacy.map((n) => `DROP CONSTRAINT ${n};`).join(' ')}`);
      for (const s of SCHEMA) await driver.executeQuery(s, {}, { routing: neo4j.routing.WRITE, database });
    } catch (e) {
      await driver.close().catch(() => undefined);
      throw new Error(`Connected to Neo4j at ${hostOf(uri)}, but setting up the indexes failed: ${(e as Error).message}`, { cause: e });
    }
    return driver;
  }

  /** A store that only ever sees one city's nodes (every query filters on `tenant`). Seeds that city's map. */
  static async forTenant(driver: Driver, city: City, tenant: string): Promise<Neo4jStore> {
    const store = new Neo4jStore(driver, city, tenant);
    await store.init();
    return store;
  }

  static async connect(uri: string, user: string, password: string, city: City = CITY, tenant = 'demo'): Promise<Neo4jStore> {
    return Neo4jStore.forTenant(await Neo4jStore.openDriver(uri, user, password), city, tenant);
  }

  close(): Promise<void> {
    return this.driver.close();
  }

  private async read(query: string, params: Record<string, unknown> = {}) {
    return (await this.driver.executeQuery(query, { ...params, tenant: this.tenant }, { routing: neo4j.routing.READ, database: this.database })).records;
  }

  private async write(query: string, params: Record<string, unknown> = {}) {
    return (await this.driver.executeQuery(query, { ...params, tenant: this.tenant }, { routing: neo4j.routing.WRITE, database: this.database })).records;
  }

  private async init(): Promise<void> {
    const c = this.city;
    await this.write(Q.seedZones, { zones: c.zones });
    await this.write(Q.seedZoneFeeds, { zones: c.zones });
    await this.write(Q.seedLocalities, { ls: c.localities });
    const near = (f: { lat: number; lng: number }) => [...c.localities].sort((a, b) => haversineMeters(f, a) - haversineMeters(f, b))[0].id;
    await this.write(Q.seedFacilities, { fs: c.facilities.map((f) => ({ ...f, locality: near(f) })) });
    await this.write(Q.seedAssets, { assets: c.assets });
    await this.write(Q.seedAssetFeeds, { assets: c.assets });
    await this.write(Q.seedAssetSupplies, { assets: c.assets });
  }

  async addComplaint(c: Complaint): Promise<void> {
    try {
      await this.write(Q.addComplaint, {
        id: c.id, reporterId: c.reporterId, createdAt: c.createdAt, issueType: c.issueType, family: FAMILY_OF[c.issueType], lat: c.lat, lng: c.lng,
        text: c.text ?? null, textEn: c.textEn ?? null, language: c.language ?? null,
        deviceId: c.deviceId ? deviceKey(c.deviceId) : null, localityId: c.localityId ?? null, photos: c.photoHashes ?? [], data: JSON.stringify(c),
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'Neo.ClientError.Schema.ConstraintValidationFailed') throw new Error(`complaint ${c.id} already exists`);
      throw e;
    }
  }

  async complaintsSince(since: number): Promise<Complaint[]> {
    return (await this.read(Q.complaintsSince, { since })).map((r) => parse<Complaint>(r.get('data')));
  }

  async complaintsNear(lat: number, lng: number, radius: number, since: number): Promise<Complaint[]> {
    return (await this.read(Q.complaintsNear, { lat, lng, radius, since })).map((r) => parse<Complaint>(r.get('data')));
  }

  async listIncidents(): Promise<StoredIncident[]> {
    return (await this.read(Q.listIncidents)).map((r) => parse<StoredIncident>(r.get('data')));
  }

  async getIncident(id: string): Promise<StoredIncident | undefined> {
    const row = (await this.read(Q.getIncident, { id }))[0];
    if (!row) return undefined;
    const s = parse<StoredIncident>(row.get('data'));
    const photo = row.get('photo') as string | null;
    if (s.proof && photo) s.proof.photo = photo;
    return s;
  }

  /** All records in ONE transaction, each step batched with UNWIND (a handful of round trips, whatever the count). */
  async saveIncidents(records: readonly StoredIncident[]): Promise<void> {
    if (records.length === 0) return;
    const ward = (s: StoredIncident) => wardOf(this.city, s.incident.centroid.lat, s.incident.centroid.lng)?.id;
    const rows = records.map((r) => ({
      id: r.incident.id, status: r.status, family: r.incident.family, level: r.incident.severity.level, score: r.incident.severity.score,
      sources: r.incident.trust.independentSources, needsVerification: r.incident.trust.needsVerification, firstReportedAt: r.incident.firstReportedAt,
      lat: r.incident.centroid.lat, lng: r.incident.centroid.lng,
      data: JSON.stringify({ ...r, proof: r.proof && { ...r.proof, photo: undefined } }),
    }));
    const ids = records.map((r) => r.incident.id);
    const members = records.flatMap((r) => r.incident.complaintIds.map((c) => ({ c, i: r.incident.id })));
    const affects = records.map((r) => ({ i: r.incident.id, l: ward(r) })).filter((x) => x.l);
    const causes = records.filter((r) => r.possibleCause).map((r) => ({ from: r.incident.id, to: r.possibleCause!.incidentId, d: r.possibleCause!.distanceM }));
    const photos = records.filter((r) => r.proof?.photo).map((r) => ({ id: r.incident.id, photo: r.proof!.photo }));
    const noProof = records.filter((r) => !r.proof).map((r) => r.incident.id);
    const session = this.driver.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.executeWrite(async (tx: ManagedTransaction) => {
        await tx.run(Q.upsertIncidents, { rows, tenant: this.tenant });
        await tx.run(Q.dropIncidentLinks, { ids, tenant: this.tenant });
        await tx.run(Q.linkMembers, { pairs: members, tenant: this.tenant });
        await tx.run(Q.linkAffects, { pairs: affects, tenant: this.tenant });
        if (causes.length) await tx.run(Q.linkCauses, { pairs: causes, tenant: this.tenant });
        if (photos.length) await tx.run(Q.setProofPhotos, { rows: photos, tenant: this.tenant });
        if (noProof.length) await tx.run(Q.clearProofPhotos, { ids: noProof, tenant: this.tenant });
      });
    } finally {
      await session.close();
    }
  }

  async clear(): Promise<void> {
    await this.write(Q.clear);
  }

  async addCheckin(c: Checkin): Promise<void> {
    await this.write(Q.addCheckin, { id: c.id, at: c.at, status: c.status, date: c.date, reporterId: c.reporterId, wardId: c.wardId ?? null, data: JSON.stringify(c) });
  }

  async checkinsSince(since: number): Promise<Checkin[]> {
    return (await this.read(Q.checkinsSince, { since })).map((r) => parse<Checkin>(r.get('data')));
  }

  async saveNotice(n: Notice): Promise<void> {
    await this.write(Q.saveNotice, { id: n.id, startsAt: n.startsAt, endsAt: n.endsAt, kind: n.kind, wardIds: n.wardIds, data: JSON.stringify(n) });
  }

  async listNotices(): Promise<Notice[]> {
    return (await this.read(Q.listNotices)).map((r) => parse<Notice>(r.get('data')));
  }

  async deleteNotice(id: string): Promise<boolean> {
    return (await this.write(Q.deleteNotice, { id })).length > 0;
  }

  async confirm(reporterId: string, targetId: string): Promise<boolean> {
    const asIncident = await this.write(Q.confirm, { reporterId, incidentId: targetId });
    const rows = asIncident.length ? asIncident : await this.write(Q.confirmComplaint, { reporterId, incidentId: targetId });
    return rows[0]?.get('fresh') === true;
  }

  async hasConfirmed(reporterId: string, targetId: string): Promise<boolean> {
    return (await this.read(Q.hasConfirmed, { reporterId, incidentId: targetId })).length > 0;
  }

  async confirmers(incidentId: string): Promise<string[]> {
    return (await this.read(Q.confirmers, { incidentId })).map((r) => r.get('id') as string);
  }

  async confirmedBy(reporterId: string): Promise<string[]> {
    return (await this.read(Q.confirmedBy, { reporterId })).map((r) => r.get('id') as string);
  }

  async getReporter(id: string): Promise<Profile | undefined> {
    const r = (await this.read(Q.getReporter, { id }))[0];
    if (!r || r.get('firstSeen') === null) return undefined;
    return { firstSeen: num(r.get('firstSeen')), confirmedResolved: num(r.get('confirmedResolved') ?? 0), lostDisputes: num(r.get('lostDisputes') ?? 0) };
  }

  async saveReporter(id: string, p: Profile): Promise<void> {
    await this.write(Q.saveReporter, { id, ...p });
  }

  /** Built from Cypher rows, not from stored JSON. */
  async subgraph(incidentId: string): Promise<Subgraph> {
    const rows = await this.read(Q.incidentGraph, { incidentId });
    const nodes = new Map<string, GraphNode>([[incidentId, { id: incidentId, type: 'Incident', label: incidentId }]]);
    const edges: GraphEdge[] = [];
    for (const r of rows) {
      const c = r.get('complaint') as string;
      const rep = r.get('reporter') as string;
      const dev = r.get('device') as string | null;
      nodes.set(c, { id: c, type: 'Complaint', label: r.get('issueType') as string });
      nodes.set(rep, { id: rep, type: 'Reporter', label: rep });
      edges.push({ from: rep, to: c, type: 'FILED' }, { from: c, to: incidentId, type: 'PART_OF' });
      if (dev) { const d = `dev:${dev.slice(0, 6)}`; nodes.set(d, { id: d, type: 'Device', label: `phone ${dev.slice(0, 6)}` }); edges.push({ from: c, to: d, type: 'FROM_DEVICE' }); }
      for (const h of r.get('photos') as string[]) { nodes.set(`photo:${h}`, { id: `photo:${h}`, type: 'Photo', label: h.slice(0, 8) }); edges.push({ from: c, to: `photo:${h}`, type: 'HAS_PHOTO' }); }
    }
    const shared = await this.read(Q.sharedDevices, { incidentId });
    return { nodes: [...nodes.values()], edges, sharedDevices: shared.map((r) => ({ deviceId: (r.get('deviceId') as string).slice(0, 6), reporters: num(r.get('reporters')) })) };
  }

  async downstream(zone: string, hops: number): Promise<Downstream[]> {
    const rows = await this.read(Q.downstream, { zone, hops: Math.min(3, Math.max(1, Math.floor(hops))) });
    return rows.map((r) => ({ zone: r.get('zone') as string, hops: num(r.get('hops')), localities: [...(r.get('localities') as string[])].sort() }));
  }

  async links(): Promise<Link[]> {
    const [a, b] = await Promise.all([this.read(Q.deviceAndPhotoLinks), this.read(Q.coReportingLinks, { farM: FAR_M })]);
    return [...a, ...b]
      .map((r) => ({ a: r.get('a') as string, b: r.get('b') as string, via: r.get('via') as Link['via'] }))
      .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b) || x.via.localeCompare(y.via));
  }

  async ringTargets(rings: readonly Ring[]): Promise<{ ring: string; incident: string }[]> {
    if (rings.length === 0) return [];
    return (await this.read(Q.ringTargets, { rings: rings.map((r) => ({ id: r.id, accounts: r.accounts })) })).map((r) => ({ ring: r.get('ring') as string, incident: r.get('incident') as string }));
  }

  async rootCause(): Promise<RootCause> {
    const rows = await this.read(Q.rootCause);
    if (rows.length === 0) return { zonesHit: [], incidents: [], suspects: [], atRisk: [] };
    const first = rows[0];
    const hitLocalities = first.get('hitLocalities') as string[];
    const suspects = rows.map((r) => ({ assetId: r.get('assetId') as string, name: r.get('name') as string, kind: r.get('kind') as string, covers: [...(r.get('covers') as string[])].sort(), distance: num(r.get('distance')) }));
    const atRisk = (await this.read(Q.atRisk, { assetId: suspects[0].assetId, hitLocalities })).map((r) => ({ localityId: r.get('localityId') as string, name: r.get('name') as string, zone: r.get('zone') as string }));
    return { zonesHit: [...(first.get('zonesHit') as string[])].sort(), incidents: [...(first.get('incidents') as string[])].sort(), suspects, atRisk };
  }

  async impact(assetId: string): Promise<{ localityId: string; name: string; zone: string }[]> {
    return (await this.read(Q.atRisk, { assetId, hitLocalities: [] })).map((r) => ({ localityId: r.get('localityId') as string, name: r.get('name') as string, zone: r.get('zone') as string }));
  }

  async wardStatus(ward: string): Promise<WardStatus | undefined> {
    const r = (await this.read(Q.wardStatus, { ward }))[0];
    if (!r) return undefined;
    return {
      ward: r.get('ward') as string, name: r.get('name') as string, zone: r.get('zone') as string, zoneName: r.get('zoneName') as string,
      fedBy: [...(r.get('fedBy') as string[])].sort(), suppliedBy: [...(r.get('suppliedBy') as string[])].sort(),
      incidents: (r.get('incidents') as string[]).map((d) => parse<StoredIncident>(d)),
    };
  }

  async overview(rings: readonly Ring[]): Promise<Overview> {
    const [net, places, incs, targets] = await Promise.all([this.read(Q.overviewNetwork), this.read(Q.overviewPlaces), this.read(Q.overviewIncidents), this.ringTargets(rings)]);
    const nodes: OverviewNode[] = [];
    const edges: Overview['edges'] = [];
    for (const r of net) {
      nodes.push({ id: r.get('id'), type: 'Asset', label: r.get('name'), kind: r.get('kind'), lat: r.get('lat'), lng: r.get('lng') });
      for (const o of (r.get('out') as ({ to: string; type: string } | null)[]).filter((x): x is { to: string; type: string } => !!x)) edges.push({ from: r.get('id'), to: o.to, type: o.type });
    }
    const zones = new Map<string, string>();
    for (const r of places) {
      zones.set(r.get('zone'), r.get('zoneName'));
      nodes.push({ id: r.get('id'), type: 'Locality', label: r.get('name'), lat: r.get('lat'), lng: r.get('lng') });
      edges.push({ from: r.get('id'), to: r.get('zone'), type: 'PART_OF' });
    }
    for (const z of this.city.zones) if (!zones.has(z.id)) zones.set(z.id, z.name);
    for (const [id, name] of [...zones].sort()) nodes.unshift({ id, type: 'Zone', label: name });
    for (const r of incs) {
      const s = parse<StoredIncident>(r.get('data'));
      const issue = Object.entries(s.incident.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? s.incident.family;
      nodes.push({ id: s.incident.id, type: 'Incident', label: issue, kind: s.incident.family, level: s.incident.severity.level, flag: s.incident.trust.needsVerification ? 'unverified' : undefined, lat: s.incident.centroid.lat, lng: s.incident.centroid.lng });
      if (r.get('locality')) edges.push({ from: s.incident.id, to: r.get('locality'), type: 'AFFECTS' });
    }
    for (const t of targets) edges.push({ from: t.ring, to: t.incident, type: 'TARGETS' });
    for (const r of rings) nodes.push({ id: r.id, type: 'Ring', label: `${r.accounts.length} linked accounts`, kind: r.via.join(', ') });
    return { nodes, edges };
  }

  async getCache(id: string): Promise<string | undefined> {
    const r = (await this.read(Q.getCache, { id }))[0];
    return r ? (r.get('value') as string) : undefined;
  }

  async setCache(id: string, value: string): Promise<void> {
    await this.write(Q.setCache, { id, value });
  }
}

/** Where the list of cities (tenants) is kept in Neo4j: one :Tenant node each. */
export class Neo4jTenantRegistry {
  constructor(private readonly driver: Driver) {}
  async load(): Promise<string[]> {
    return (await this.driver.executeQuery(Q.listTenants, {}, { routing: neo4j.routing.READ, database: DATABASE.get(this.driver) })).records.map((r) => r.get('data') as string);
  }
  async save(id: string, name: string, createdAt: number, data: string): Promise<void> {
    await this.driver.executeQuery(Q.saveTenant, { id, name, createdAt, data }, { routing: neo4j.routing.WRITE, database: DATABASE.get(this.driver) });
  }
  async linkPartner(to: string, toAsset: string, from: string, fromAsset: string): Promise<void> {
    await this.driver.executeQuery(Q.linkPartner, { to, toAsset, from, fromAsset }, { routing: neo4j.routing.WRITE, database: DATABASE.get(this.driver) });
  }
  async crossCity(ids: string[]): Promise<{ account: string; cities: string[] }[]> {
    if (ids.length === 0) return [];
    const res = await this.driver.executeQuery(Q.crossCityAccounts, { ids }, { routing: neo4j.routing.READ, database: DATABASE.get(this.driver) });
    return res.records.map((r) => ({ account: r.get('account') as string, cities: r.get('cities') as string[] }));
  }
}
