import type { Complaint } from '@bharatpulse/engine';
import type { Downstream, Link, Overview, Ring, RootCause, Subgraph } from './graph.js';
import type { Checkin, Notice, Profile, StoredIncident } from './types.js';

export interface WardStatus { ward: string; name: string; zone: string; zoneName: string; fedBy: string[]; suppliedBy: string[]; incidents: StoredIncident[] }

/**
 * Everything the service needs from storage. Async on purpose: the in-memory
 * version could be sync, but the Neo4j version cannot, and the service
 * should not care which one it gets. Both must give the same answers (scripts/smoke.ts compares them).
 */
export interface IncidentStore {
  readonly kind: 'neo4j' | 'memory';
  /** Throws if a complaint with the same id already exists. */
  addComplaint(complaint: Complaint): Promise<void>;
  /** Complaints with createdAt >= since, oldest first. */
  complaintsSince(since: number): Promise<Complaint[]>;
  /** Complaints since `since` within `radius` metres of a point (Neo4j: point index). Oldest first. */
  complaintsNear(lat: number, lng: number, radius: number, since: number): Promise<Complaint[]>;
  /** Every incident, any status. Proof photos are NOT included (use getIncident). */
  listIncidents(): Promise<StoredIncident[]>;
  /** One incident, with its proof photo. */
  getIncident(id: string): Promise<StoredIncident | undefined>;
  /** Insert or replace by `incident.id`. A record whose proof has no `photo` keeps the stored photo. */
  saveIncidents(records: readonly StoredIncident[]): Promise<void>;
  /** Saves a diary answer (one per person per day: a second answer replaces the first). */
  addCheckin(c: Checkin): Promise<void>;
  checkinsSince(since: number): Promise<Checkin[]>;
  saveNotice(n: Notice): Promise<void>;
  listNotices(): Promise<Notice[]>;
  deleteNotice(id: string): Promise<boolean>;
  /** Removes complaints, incidents, people and confirmations (not the town or caches). Used to reset sample data. */
  clear(): Promise<void>;
  /** Records "this reporter also has the problem" on an incident or a single report. False if already recorded (the lock is here, not in the UI). */
  confirm(reporterId: string, targetId: string): Promise<boolean>;
  hasConfirmed(reporterId: string, targetId: string): Promise<boolean>;
  /** Reporters who confirmed an incident. */
  confirmers(incidentId: string): Promise<string[]>;
  /** Everything (incidents and reports) one reporter confirmed. */
  confirmedBy(reporterId: string): Promise<string[]>;
  getReporter(id: string): Promise<Profile | undefined>;
  saveReporter(id: string, p: Profile): Promise<void>;

  // ---- graph questions ----
  /** The incident as a graph (reporters, devices, photos). */
  subgraph(incidentId: string): Promise<Subgraph>;
  /** Localities hit next if a zone fails. */
  downstream(zone: string, hops: number): Promise<Downstream[]>;
  /** Accounts tied together by a shared phone or photo, or by reporting together in far-apart places. */
  links(): Promise<Link[]>;
  /** Which open incidents each ring reported into. */
  ringTargets(rings: readonly Ring[]): Promise<{ ring: string; incident: string }[]>;
  /** Trace open, trusted water incidents up the water network. */
  rootCause(): Promise<RootCause>;
  /** What if this asset fails: every ward fed by it, through any pipes in between (Q.atRisk with nothing excluded). */
  impact(assetId: string): Promise<{ localityId: string; name: string; zone: string }[]>;
  wardStatus(ward: string): Promise<WardStatus | undefined>;
  /** Network, wards, open incidents and rings for the officer Graph page. */
  overview(rings: readonly Ring[]): Promise<Overview>;

  /** Small key-value cache (translated language packs). */
  getCache(id: string): Promise<string | undefined>;
  setCache(id: string, value: string): Promise<void>;
}
