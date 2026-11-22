import { haversineMeters, type Complaint } from '@bharatpulse/engine';
import { CITY, wardOf, type City } from './data.js';
import { buildSubgraph, downstream, linksFrom, overviewFrom, rootCauseFrom, type Downstream, type Link, type Overview, type Ring, type RootCause, type Subgraph, reach } from './graph.js';
import type { IncidentStore, WardStatus } from './store.js';
import { isActive, type Checkin, type Notice, type Profile, type StoredIncident } from './types.js';

/**
 * Keeps everything in RAM. Used for tests and the no-setup demo; data is lost on restart.
 * Gives the same answers as Neo4jStore (the graph questions use the TypeScript versions in graph.ts).
 * Returns copies so a caller can never change stored data by accident.
 */
export class MemoryStore implements IncidentStore {
  readonly kind = 'memory' as const;
  private complaints = new Map<string, Complaint>();
  private incidents = new Map<string, StoredIncident>();
  private confirmed = new Set<string>();
  private checkins = new Map<string, Checkin>();
  private notices = new Map<string, Notice>();
  private reporters = new Map<string, Profile>();
  private cache = new Map<string, string>();

  constructor(private readonly city: City = CITY) {}

  private ward = (lat: number, lng: number) => wardOf(this.city, lat, lng);

  async addComplaint(complaint: Complaint): Promise<void> {
    if (this.complaints.has(complaint.id)) throw new Error(`complaint ${complaint.id} already exists`);
    this.complaints.set(complaint.id, structuredClone(complaint));
    if (!this.reporters.has(complaint.reporterId)) this.reporters.set(complaint.reporterId, { firstSeen: complaint.createdAt, confirmedResolved: 0, lostDisputes: 0 });
  }

  async complaintsSince(since: number): Promise<Complaint[]> {
    return [...this.complaints.values()]
      .filter((c) => c.createdAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((c) => structuredClone(c));
  }

  async complaintsNear(lat: number, lng: number, radius: number, since: number): Promise<Complaint[]> {
    return (await this.complaintsSince(since)).filter((c) => haversineMeters({ lat, lng }, c) <= radius);
  }

  async listIncidents(): Promise<StoredIncident[]> {
    return [...this.incidents.values()].map((s) => {
      const copy = structuredClone(s);
      if (copy.proof) delete copy.proof.photo;
      return copy;
    });
  }

  async getIncident(id: string): Promise<StoredIncident | undefined> {
    const found = this.incidents.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async saveIncidents(records: readonly StoredIncident[]): Promise<void> {
    for (const r of records) {
      const copy = structuredClone(r);
      const old = this.incidents.get(r.incident.id);
      if (copy.proof && !copy.proof.photo && old?.proof?.photo) copy.proof.photo = old.proof.photo;
      this.incidents.set(r.incident.id, copy);
    }
  }

  async clear(): Promise<void> {
    this.complaints.clear();
    this.incidents.clear();
    this.confirmed.clear();
    this.checkins.clear();
    this.notices.clear();
    this.reporters.clear();
  }

  async addCheckin(c: Checkin): Promise<void> {
    this.checkins.set(c.id, c);
  }

  async checkinsSince(since: number): Promise<Checkin[]> {
    return [...this.checkins.values()].filter((c) => c.at >= since).sort((a, b) => a.at - b.at);
  }

  async saveNotice(n: Notice): Promise<void> {
    this.notices.set(n.id, n);
  }

  async listNotices(): Promise<Notice[]> {
    return [...this.notices.values()].sort((a, b) => a.startsAt - b.startsAt);
  }

  async deleteNotice(id: string): Promise<boolean> {
    return this.notices.delete(id);
  }

  async confirm(reporterId: string, targetId: string): Promise<boolean> {
    if (!this.incidents.has(targetId) && !this.complaints.has(targetId)) return false;
    const key = `${reporterId}|${targetId}`;
    if (this.confirmed.has(key)) return false;
    this.confirmed.add(key);
    return true;
  }

  async hasConfirmed(reporterId: string, targetId: string): Promise<boolean> {
    return this.confirmed.has(`${reporterId}|${targetId}`);
  }

  async confirmers(incidentId: string): Promise<string[]> {
    return [...this.confirmed].filter((k) => k.endsWith(`|${incidentId}`)).map((k) => k.split('|')[0]).sort();
  }

  async confirmedBy(reporterId: string): Promise<string[]> {
    return [...this.confirmed].filter((k) => k.startsWith(`${reporterId}|`)).map((k) => k.slice(reporterId.length + 1));
  }

  async getReporter(id: string): Promise<Profile | undefined> {
    const p = this.reporters.get(id);
    return p && { ...p };
  }

  async saveReporter(id: string, p: Profile): Promise<void> {
    const old = this.reporters.get(id);
    this.reporters.set(id, { ...p, firstSeen: old?.firstSeen ?? p.firstSeen });
  }

  async subgraph(incidentId: string): Promise<Subgraph> {
    const ids = new Set(this.incidents.get(incidentId)?.incident.complaintIds);
    const all = [...this.complaints.values()];
    return buildSubgraph(incidentId, all.filter((c) => ids.has(c.id)).sort((a, b) => a.id.localeCompare(b.id)), all);
  }

  async downstream(zone: string, hops: number): Promise<Downstream[]> {
    return downstream(this.city, zone, hops);
  }

  async links(): Promise<Link[]> {
    return linksFrom([...this.complaints.values()], [...this.incidents.values()]);
  }

  async ringTargets(rings: readonly Ring[]): Promise<{ ring: string; incident: string }[]> {
    const out: { ring: string; incident: string }[] = [];
    for (const r of rings) {
      const accounts = new Set(r.accounts);
      for (const s of this.incidents.values()) {
        if (isActive(s) && s.incident.complaintIds.some((id) => accounts.has(this.complaints.get(id)?.reporterId ?? ''))) out.push({ ring: r.id, incident: s.incident.id });
      }
    }
    return out;
  }

  async impact(assetId: string): Promise<{ localityId: string; name: string; zone: string }[]> {
    const zones = reach(this.city, assetId);
    return this.city.localities.filter((l) => zones.has(l.zoneId)).map((l) => ({ localityId: l.id, name: l.name, zone: l.zoneId })).sort((a, b) => a.localityId.localeCompare(b.localityId));
  }

  async rootCause(): Promise<RootCause> {
    return rootCauseFrom(this.city, [...this.incidents.values()], this.ward);
  }

  async wardStatus(ward: string): Promise<WardStatus | undefined> {
    const l = this.city.localities.find((x) => x.id === ward);
    if (!l) return undefined;
    const z = this.city.zones.find((x) => x.id === l.zoneId);
    return {
      ward: l.id, name: l.name, zone: l.zoneId, zoneName: z?.name ?? l.zoneId,
      fedBy: this.city.zones.filter((u) => u.feeds.includes(l.zoneId)).map((u) => u.id),
      suppliedBy: this.city.assets.filter((a) => a.supplies.includes(l.zoneId)).map((a) => a.name),
      incidents: (await this.listIncidents()).filter((s) => isActive(s) && this.ward(s.incident.centroid.lat, s.incident.centroid.lng)?.id === l.id),
    };
  }

  async overview(rings: readonly Ring[]): Promise<Overview> {
    const o = overviewFrom(this.city, [...this.incidents.values()], [...this.complaints.values()], rings, this.ward);
    return o;
  }

  async getCache(id: string): Promise<string | undefined> {
    return this.cache.get(id);
  }

  async setCache(id: string, value: string): Promise<void> {
    this.cache.set(id, value);
  }
}
