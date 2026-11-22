import { createHash, randomUUID } from 'node:crypto';
import { cfgFor, detectIncidents, FAMILY_OF, haversineMeters, MINUTE, resolveConfig, type Complaint, type ConfigOverrides } from '@bharatpulse/engine';
import { ask, type Answer } from './ask.js';
import type { Auth } from './auth.js';
import { findCause, ringsFrom, type Ring } from './graph.js';
import { nearestLocality, placeholderPhoto, understand } from './intake.js';
import { buildPack } from './langpack.js';
import { LANGUAGES, type Sarvam } from './sarvam.js';
import { sampleDataset } from './scenarios.js';
import { AppError } from './errors.js';
import { CITY, DIRECTORY, wardOf, type City } from './data.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import { reconcile } from './reconcile.js';
import type { IncidentStore } from './store.js';
import { isActive, type Checkin, type Notice, type Profile, type Role, type StoredIncident } from './types.js';
import { act, escalateIfOverdue, isFinished, newWorkflow, type ActInput } from './workflow.js';
import { parseComplaintInput } from './validation.js';

/** How close you must be to confirm a problem: a neighbourhood for water, a few steps for a pothole (GPS is rarely better than 50-100 m). */
export const CONFIRM_M = { ROAD: 300, WATER: 1500 } as const;
const confirmRadius = (family: string): number => (family === 'ROAD' ? CONFIRM_M.ROAD : CONFIRM_M.WATER);

const DAY_MS = 86_400_000;
/** The calendar date in India, which is what "today" means to a household. */
const istDate = (t: number): string => new Date(t + 19_800_000).toISOString().slice(0, 10);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const FINISHED = ['RESOLVED', 'CONFIRMED', 'CLOSED'];
export interface SupplyWard { id: string; name: string; people: number; total: number; reliability: number; badDays: number; chronic: boolean }
export interface Repeat { count: number; lastFixedAt: number }
const NOTICE_KINDS = ['WATER_CUT', 'ROAD_WORK', 'OTHER'];

export interface NearbyItem { lat: number; lng: number; mine?: boolean; kind: 'incident' | 'report' | 'fixed'; id: string; issueType: string; family: string; reports: number; people: number; lastAt: number; distanceM: number; stage?: string }
export interface RiskZone { zone: string; name: string; level: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[] }
export interface PublicSummary { moreWards: number; scope?: { lat: number; lng: number; km: number }; totals: { reports: number; open: number; fixed: number; avgHours: number | null }; wards: { id: string; name: string; open: number; fixed: number; avgHours: number | null }[]; recentlyFixed: { id: string; issueType: string; ward?: string; hours: number | null; hasProof: boolean }[] }
const mainIssue = (s: StoredIncident): string => Object.entries(s.incident.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTHER_WATER';

export interface PendingReport { id: string; issueType: Complaint['issueType']; createdAt: number; lat: number; lng: number; localityId?: string; address?: string; text?: string }
const toPublic = (c: Complaint): PendingReport => ({ id: c.id, issueType: c.issueType, createdAt: c.createdAt, lat: c.lat, lng: c.lng, localityId: c.localityId, address: c.address, text: c.text });

export interface ServiceOptions {
  clock?: () => number;
  /** Complaints older than this are ignored when re-running the engine. */
  windowMs?: number;
  engine?: ConfigOverrides;
  /** Per-reporter limit on complaints. */
  rateLimit?: { max: number; windowMs: number };
  /** Let callers set `createdAt` (demo simulator only). */
  allowClientTimestamps?: boolean;
  idGenerator?: () => string;
  /** Kept for compatibility; reporter history now lives in the store (the Reporter node in Neo4j). */
  auth?: Auth;
  /**
   * Re-running detection on every read is wasteful against a remote database. Reads within this many ms of the last
   * run reuse it, unless something was written since. 0 (tests) = always re-run. The server uses 10 s.
   */
  recomputeTtlMs?: number;
  sarvam?: Sarvam;
  /** This city's wards, zones and water network (multi-city: one service per city). */
  city?: City;
  /** Called once for every incident the engine detects for the first time (webhooks). */
  onNewIncident?: (s: StoredIncident) => void;
  /**
   * The platform's shared watchlist (multi-city). `record` hands this city's rings to it after every graph refresh;
   * `ringFor` returns a ring another city found for this account, so a hired crowd is held on its first report here.
   */
  network?: { record: (rings: Ring[]) => void; ringFor: (reporterId: string) => Ring | undefined };
}

export interface SubmitResult {
  complaint: Complaint;
  /** The active incident this complaint is part of right now, or null if it is still isolated. */
  incidentId: string | null;
}

/** Runs one async job at a time, so two requests can never reconcile at once. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class IncidentService {
  private readonly clock: () => number;
  private readonly windowMs: number;
  private readonly limiter: SlidingWindowLimiter;
  private readonly mutex = new Mutex();
  private readonly newId: () => string;
  readonly city: City;
  private lastRun = -Infinity;
  private dirty = true;
  /** reporterId -> ring, from the graph. Refreshed by every recompute. */
  private ringOf = new Map<string, Ring>();
  private ringList: Ring[] = [];

  constructor(
    private readonly store: IncidentStore,
    private readonly opts: ServiceOptions = {},
  ) {
    this.clock = opts.clock ?? Date.now;
    this.windowMs = opts.windowMs ?? 15 * 24 * 3_600_000; // roads stay relevant for 14 days
    this.newId = opts.idGenerator ?? randomUUID;
    this.city = opts.city ?? CITY;
    const rl = opts.rateLimit ?? { max: 5, windowMs: 10 * MINUTE };
    this.limiter = new SlidingWindowLimiter(rl.max, rl.windowMs);
  }

  /** Validate, rate-limit, store, then re-run detection. */
  submitComplaint(body: unknown, extra: Partial<Complaint> = {}): Promise<SubmitResult> {
    return this.mutex.run(async () => {
      const now = this.clock();
      const input = parseComplaintInput(body, {
        now,
        windowMs: this.windowMs,
        allowClientTimestamps: this.opts.allowClientTimestamps ?? false,
      });

      const waitMs = this.limiter.tryConsume(input.reporterId, now);
      if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000);
        throw new AppError(429, 'rate_limited', 'Too many complaints from this reporter, try again later', { retryAfterSeconds: seconds }, { 'retry-after': String(seconds) });
      }

      const complaint: Complaint = { id: this.newId(), ...input, ...extra };
      await this.store.addComplaint(complaint);
      this.dirty = true;
      const active = await this.recompute(now);
      const incident = active.find((s) => s.incident.complaintIds.includes(complaint.id));
      return { complaint, incidentId: incident ? incident.incident.id : null };
    });
  }

  /** Active incidents, highest severity first. Re-runs detection first so scores reflect "now". */
  listActive(): Promise<StoredIncident[]> {
    return this.mutex.run(() => this.recompute(this.clock()));
  }

  getIncident(id: string): Promise<StoredIncident> {
    return this.mutex.run(async () => {
      await this.recompute(this.clock());
      return this.mustFind(id);
    });
  }

  /**
   * Plug-in mode: complaints exported from a city's existing portal (CPGRAMS, a state 1916 portal, a call centre)
   * arrive here in a batch. Each one is translated to English (Sarvam), classified, linked into the graph like our
   * own reports, and detection runs once for the batch. Re-sending the same externalId is skipped (idempotent).
   */
  ingest(items: unknown, sourceIn: unknown): Promise<{ accepted: number; duplicates: number; rejected: { index: number; reason: string }[]; activeIncidents: number }> {
    return this.mutex.run(async () => {
      if (!Array.isArray(items) || items.length === 0 || items.length > 200) throw new AppError(400, 'validation_error', 'complaints must be an array of 1 to 200 items');
      const source = typeof sourceIn === 'string' && /^[\w .-]{2,40}$/.test(sourceIn) ? sourceIn.trim() : 'portal';
      const now = this.clock();
      const sha = (x: string) => createHash('sha256').update(x).digest('hex');
      const rejected: { index: number; reason: string }[] = [];
      let accepted = 0;
      let duplicates = 0;
      for (const [index, raw] of items.entries()) {
        const it = (raw ?? {}) as Record<string, unknown>;
        const externalId = typeof it.externalId === 'string' || typeof it.externalId === 'number' ? String(it.externalId).slice(0, 80) : '';
        if (!externalId) { rejected.push({ index, reason: 'externalId is required' }); continue; }
        const at = typeof it.createdAt === 'string' ? Date.parse(it.createdAt) : typeof it.createdAt === 'number' ? it.createdAt : now;
        const text = typeof it.text === 'string' ? it.text.slice(0, 500) : '';
        const u = text ? await understand(text, this.opts.sarvam, typeof it.language === 'string' ? it.language : undefined) : undefined;
        const issueType = typeof it.issueType === 'string' ? it.issueType : u?.issueType ?? (it.category === 'ROAD' ? 'OTHER_ROAD' : 'OTHER_WATER');
        try {
          const input = parseComplaintInput({ reporterId: `ext:${source}:${sha(String(it.reporter ?? externalId)).slice(0, 12)}`, issueType, lat: it.lat, lng: it.lng, createdAt: Number.isFinite(at) ? Math.min(at, now) : now, text: text || undefined }, { now, windowMs: this.windowMs, allowClientTimestamps: true });
          const c: Complaint = { id: `ext-${sha(`${source}|${externalId}`).slice(0, 16)}`, ...input, textEn: u?.textEn, language: u?.language, localityId: nearestLocality(input.lat, input.lng, this.city) };
          try { await this.store.addComplaint(c); accepted++; } catch { duplicates++; }
        } catch (e) {
          rejected.push({ index, reason: e instanceof AppError ? (e.details as { field: string; message: string }[] | undefined)?.map((d) => `${d.field}: ${d.message}`).join('; ') ?? e.message : 'invalid' });
        }
      }
      this.dirty = true;
      const active = await this.recompute(now);
      return { accepted, duplicates, rejected, activeIncidents: active.length };
    });
  }

  /** Internal (tests, scripts): close an incident without the officer workflow. There is NO HTTP route for this. */
  resolve(id: string): Promise<StoredIncident> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const found = await this.mustFind(id);
      this.assertActive(found, 'resolve');
      const updated: StoredIncident = { ...found, status: 'resolved', resolution: 'manual', resolvedAt: now, updatedAt: now };
      await this.store.saveIncidents([updated]);
      this.dirty = true;
      return updated;
    });
  }

  /** Internal (tests, scripts): flag an incident as escalated. There is NO HTTP route for this. */
  escalate(id: string): Promise<StoredIncident> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const found = await this.mustFind(id);
      this.assertActive(found, 'escalate');
      const updated: StoredIncident = { ...found, status: 'escalated', updatedAt: now };
      await this.store.saveIncidents([updated]);
      this.dirty = true;
      return updated;
    });
  }

  /** Every incident that is not merged (officers also need finished ones, to await the citizen's confirmation). */
  listAll(): Promise<StoredIncident[]> {
    return this.mutex.run(async () => {
      await this.recompute(this.clock());
      return (await this.store.listIncidents()).filter((s) => s.status !== 'merged');
    });
  }

  /** One workflow step by an officer or a citizen. Rules live in workflow.ts. */
  act(id: string, input: ActInput, reporterId?: string, proofPhoto?: string): Promise<StoredIncident> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const found = await this.mustFind(id);
      if (found.status === 'merged') throw new AppError(409, 'incident_merged', 'Incident was merged into another', { mergedInto: found.mergedInto });
      if (found.resolution === 'expired') throw new AppError(409, 'incident_expired', 'Every report aged out, nothing to act on');
      if (input.role === 'CITIZEN' && !(await this.reportersOf(found)).includes(reporterId ?? '')) throw new AppError(403, 'forbidden', 'Only people who reported this can do that');

      const workflow = act(found.workflow ?? newWorkflow(found.incident, now), input, now);
      if (input.action === 'dispute') workflow.disputedBy = reporterId;
      const updated: StoredIncident = { ...found, workflow, updatedAt: now };
      if (input.action === 'resolve' && proofPhoto) updated.proof = { photo: proofPhoto, hash: input.proofHash ?? '', by: input.role, at: now };
      if (input.action === 'reject-proof') delete updated.proof;
      if (isFinished(workflow.stage) && found.status !== 'resolved') Object.assign(updated, { status: 'resolved', resolution: 'manual', resolvedAt: now });
      if (!isFinished(workflow.stage) && found.status === 'resolved') {
        updated.status = 'open';
        delete updated.resolution;
        delete updated.resolvedAt;
      }
      if (input.action === 'confirm') for (const r of await this.reportersOf(found)) await this.bump(r, 'confirmedResolved', now);
      if (input.action === 'decide-dispute' && input.decision === 'uphold' && workflow.disputedBy) await this.bump(workflow.disputedBy, 'lostDisputes', now);
      await this.store.saveIncidents([updated]);
      this.dirty = true;
      return updated;
    });
  }

  /** "Me too" on an incident: an OTP-verified neighbour confirms it. One per reporter per incident, enforced by the store. */
  metoo(reporterId: string, incidentId: string, lat: number, lng: number, extra: Partial<Complaint> = {}): Promise<StoredIncident> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      return this.metooIncident(reporterId, await this.mustFind(incidentId), lat, lng, extra, now);
    });
  }

  /** "Me too" on anything shown in "problems near you": an incident, or a report that has not become one yet. */
  metooAny(reporterId: string, id: string, lat: number, lng: number, extra: Partial<Complaint> = {}): Promise<{ incidentId: string | null }> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const incident = await this.store.getIncident(id);
      if (incident) return { incidentId: (await this.metooIncident(reporterId, incident, lat, lng, extra, now)).incident.id };

      const singles = await this.pendingRaw(now);
      const c = singles.find((x) => x.id === id);
      if (!c) throw new AppError(404, 'not_found', 'That report is no longer open');
      const family = FAMILY_OF[c.issueType];
      const radius = cfgFor(resolveConfig(this.opts.engine), family).epsMeters;
      if (haversineMeters({ lat, lng }, c) > confirmRadius(family)) throw new AppError(403, 'too_far', 'You must be near the problem to confirm it');
      const group = singles.filter((o) => FAMILY_OF[o.issueType] === family && haversineMeters(o, c) <= radius);
      if (await this.store.hasConfirmed(reporterId, id)) throw new AppError(409, 'already_confirmed', 'Already confirmed');
      if (group.some((o) => o.reporterId === reporterId)) throw new AppError(409, 'own_report', 'You already reported this');
      if (this.limiter.tryConsume(`metoo:${reporterId}`, now) > 0) throw new AppError(429, 'rate_limited', 'Too many confirmations, try again later');
      if (!(await this.store.confirm(reporterId, id))) throw new AppError(409, 'already_confirmed', 'Already confirmed');
      const complaint: Complaint = { id: this.newId(), reporterId, issueType: c.issueType, lat: c.lat, lng: c.lng, createdAt: now, localityId: wardOf(this.city, c.lat, c.lng)?.id, ...extra, ...(await this.trustFacts(reporterId, now)) };
      await this.store.addComplaint(complaint);
      this.dirty = true;
      await this.recompute(now);
      const formed = (await this.store.listIncidents()).find((s) => s.status !== 'merged' && s.incident.complaintIds.includes(complaint.id));
      return { incidentId: formed?.incident.id ?? null };
    });
  }

  private async metooIncident(reporterId: string, found: StoredIncident, lat: number, lng: number, extra: Partial<Complaint>, now: number): Promise<StoredIncident> {
    const incidentId = found.incident.id;
    this.assertActive(found, 'confirm');
    if (haversineMeters({ lat, lng }, found.incident.centroid) > confirmRadius(found.incident.family)) throw new AppError(403, 'too_far', 'You must be near the problem to confirm it');
    if (await this.store.hasConfirmed(reporterId, incidentId)) throw new AppError(409, 'already_confirmed', 'Already confirmed');
    if ((await this.reportersOf(found)).includes(reporterId)) throw new AppError(409, 'own_report', 'You already reported this');
    if (this.limiter.tryConsume(`metoo:${reporterId}`, now) > 0) throw new AppError(429, 'rate_limited', 'Too many confirmations, try again later');
    if (!(await this.store.confirm(reporterId, incidentId))) throw new AppError(409, 'already_confirmed', 'Already confirmed');
    const [dominant] = Object.entries(found.incident.issueBreakdown).sort((a, b) => b[1] - a[1]);
    const complaint: Complaint = { id: this.newId(), reporterId, issueType: dominant[0] as Complaint['issueType'], lat: found.incident.centroid.lat, lng: found.incident.centroid.lng, createdAt: now, localityId: wardOf(this.city, found.incident.centroid.lat, found.incident.centroid.lng)?.id, ...extra, ...(await this.trustFacts(reporterId, now)) };
    await this.store.addComplaint(complaint);
    this.dirty = true;
    await this.recompute(now);
    return this.mustFind(incidentId);
  }

  /** Public view of what is happening near a point: open incidents and single reports that have not become one yet. */
  nearby(lat: number, lng: number, radius = 2000, me?: string): Promise<NearbyItem[]> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const items: NearbyItem[] = [];
      const incidents = await this.store.listIncidents();
      const mineDone = new Set(me ? await this.store.confirmedBy(me) : []);
      const used = new Set(incidents.filter((s) => s.status !== 'merged').flatMap((s) => s.incident.complaintIds));
      const myComplaints = new Set(me ? (await this.store.complaintsSince(now - this.windowMs)).filter((c) => c.reporterId === me).map((c) => c.id) : []);
      // Incidents whose every report looks fake are not shown to the public (officers still see them).
      for (const s of incidents.filter((x) => isActive(x) && x.incident.trust.independentSources > 0)) {
        const d = haversineMeters({ lat, lng }, s.incident.centroid);
        if (d <= radius + s.incident.radiusMeters / 2) items.push({ lat: round3(s.incident.centroid.lat), lng: round3(s.incident.centroid.lng), mine: !!me && (s.incident.complaintIds.some((c) => myComplaints.has(c)) || mineDone.has(s.incident.id)), kind: 'incident', id: s.incident.id, issueType: mainIssue(s), family: s.incident.family, reports: s.incident.complaintCount, people: s.incident.trust.independentSources, lastAt: s.incident.lastReportedAt, distanceM: Math.round(d), stage: s.workflow?.stage });
      }
      // Single reports near the point, straight from the spatial index (a little wider, so groups at the edge stay whole).
      const singles = (await this.store.complaintsNear(lat, lng, radius + 600, now - this.windowMs)).filter((c) => !used.has(c.id));
      const eps = (f: Complaint['issueType']) => cfgFor(resolveConfig(this.opts.engine), FAMILY_OF[f]).epsMeters;
      const taken = new Set<string>();
      for (const c of singles) {
        if (taken.has(c.id)) continue;
        const group = singles.filter((o) => !taken.has(o.id) && FAMILY_OF[o.issueType] === FAMILY_OF[c.issueType] && haversineMeters(o, c) <= eps(c.issueType));
        group.forEach((o) => taken.add(o.id));
        const d = Math.min(...group.map((o) => haversineMeters({ lat, lng }, o)));
        if (d <= radius) items.push({ lat: round3(group[0].lat), lng: round3(group[0].lng), mine: !!me && (group.some((o) => o.reporterId === me) || mineDone.has(group[0].id)), kind: 'report', id: group[0].id, issueType: group[0].issueType, family: FAMILY_OF[c.issueType], reports: group.length, people: new Set(group.map((o) => o.reporterId)).size, lastAt: Math.max(...group.map((o) => o.createdAt)), distanceM: Math.round(d) });
      }
      for (const s of incidents.filter((x) => x.status !== 'merged' && FINISHED.includes(x.workflow?.stage ?? '') && !x.workflow?.rejection && x.resolvedAt && now - x.resolvedAt < 30 * DAY_MS)) {
        const d = haversineMeters({ lat, lng }, s.incident.centroid);
        if (d <= radius) items.push({ lat: round3(s.incident.centroid.lat), lng: round3(s.incident.centroid.lng), kind: 'fixed', id: s.incident.id, issueType: mainIssue(s), family: s.incident.family, reports: s.incident.complaintCount, people: s.incident.trust.independentSources, lastAt: s.resolvedAt!, distanceM: Math.round(d) });
      }
      return items.sort((a, b) => a.distanceM - b.distanceM);
    });
  }

  /** What a shared "confirm this problem" link points at: an incident or a report, with a place rounded to about 100 m. */
  publicItem(id: string): Promise<{ kind: 'incident' | 'report'; issueType: string; family: string; reports: number; lat: number; lng: number } | undefined> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const round = (n: number) => Math.round(n * 1000) / 1000;
      const inc = await this.store.getIncident(id);
      if (inc && isActive(inc)) return { kind: 'incident' as const, issueType: mainIssue(inc), family: inc.incident.family, reports: inc.incident.complaintCount, lat: round(inc.incident.centroid.lat), lng: round(inc.incident.centroid.lng) };
      const c = (await this.pendingRaw(now)).find((x) => x.id === id);
      return c && { kind: 'report' as const, issueType: c.issueType, family: FAMILY_OF[c.issueType], reports: 1, lat: round(c.lat), lng: round(c.lng) };
    });
  }

  /** "Did water come today?" One answer per person per day; a second answer the same day replaces the first. */
  checkin(reporterId: string, status: Checkin['status'], lat: number, lng: number): Promise<Checkin> {
    return this.mutex.run(async () => {
      const now = this.clock();
      const date = istDate(now);
      const c: Checkin = { id: `${reporterId}|${date}`, reporterId, date, status, lat: round3(lat), lng: round3(lng), wardId: wardOf(this.city, lat, lng)?.id, at: now };
      await this.store.addCheckin(c);
      return c;
    });
  }

  myCheckins(reporterId: string, days = 7): Promise<Checkin[]> {
    return this.mutex.run(async () => (await this.store.checkinsSince(this.clock() - days * DAY_MS)).filter((c) => c.reporterId === reporterId));
  }

  private async supplyAt(now: number, scope?: { lat: number; lng: number; km: number }, days = 7): Promise<SupplyWard[]> {
    const rows = (await this.store.checkinsSince(now - days * DAY_MS)).filter((c) => c.wardId && (!scope || haversineMeters(scope, c) <= scope.km * 1000));
    const byWard = new Map<string, Checkin[]>();
    for (const c of rows) byWard.set(c.wardId!, [...(byWard.get(c.wardId!) ?? []), c]);
    return [...byWard.entries()].map(([id, list]) => {
      const count = (st: Checkin['status']) => list.filter((c) => c.status === st).length;
      const byDate = new Map<string, Checkin[]>();
      for (const c of list) byDate.set(c.date, [...(byDate.get(c.date) ?? []), c]);
      const badDays = [...byDate.values()].filter((d) => d.filter((c) => c.status !== 'CAME').length > d.filter((c) => c.status === 'CAME').length).length;
      const people = new Set(list.map((c) => c.reporterId)).size;
      return { id, name: this.city.localities.find((l) => l.id === id)?.name ?? id, people, total: list.length, reliability: Math.round(((count('CAME') + count('LATE') * 0.5) / list.length) * 100), badDays, chronic: people >= 2 && badDays >= 3 };
    }).filter((w) => w.total >= 3).sort((a, b) => a.reliability - b.reliability);
  }

  /** How reliably water reached each ward over the last week, from residents' own check-ins. */
  supply(scope?: { lat: number; lng: number; km: number }, days = 7): Promise<{ days: number; wards: SupplyWard[] }> {
    return this.mutex.run(async () => ({ days, wards: await this.supplyAt(this.clock(), scope, days) }));
  }

  /** Planned work announced by officers: a water cut, road works, anything people should know before they complain. */
  addNotice(input: Record<string, unknown>, role: Role): Promise<Notice> {
    return this.mutex.run(async () => {
      const now = this.clock();
      const bad = (m: string) => new AppError(400, 'validation_error', m);
      const kind = String(input.kind);
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const wards = Array.isArray(input.wardIds) ? input.wardIds.filter((w): w is string => typeof w === 'string') : [];
      const places = this.city.localities.filter((l) => wards.includes(l.id));
      const startsAt = Number(input.startsAt);
      const endsAt = Number(input.endsAt);
      if (!NOTICE_KINDS.includes(kind)) throw bad(`kind must be one of ${NOTICE_KINDS.join(', ')}`);
      if (title.length < 3 || title.length > 120) throw bad('title must be 3 to 120 characters');
      if (places.length === 0) throw bad('pick at least one ward');
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt || endsAt <= now) throw bad('the end must be after the start, and in the future');
      const n: Notice = { id: this.newId(), kind: kind as Notice['kind'], title, note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 300) : undefined, wardIds: places.map((l) => l.id), lat: places.reduce((a, l) => a + l.lat, 0) / places.length, lng: places.reduce((a, l) => a + l.lng, 0) / places.length, radiusM: 1200, startsAt, endsAt, createdBy: role, createdAt: now };
      await this.store.saveNotice(n);
      return n;
    });
  }

  removeNotice(id: string): Promise<void> {
    return this.mutex.run(async () => { if (!(await this.store.deleteNotice(id))) throw new AppError(404, 'not_found', 'No such notice'); });
  }

  /** Notices that apply at a point: happening now, or in the next 7 days. */
  noticesNear(lat: number, lng: number): Promise<Notice[]> {
    return this.mutex.run(async () => {
      const now = this.clock();
      return (await this.store.listNotices()).filter((n) => n.endsAt >= now && n.startsAt <= now + 7 * DAY_MS && haversineMeters({ lat, lng }, n) <= n.radiusM + 300);
    });
  }

  allNotices(): Promise<Notice[]> {
    return this.mutex.run(async () => (await this.store.listNotices()).filter((n) => n.endsAt >= this.clock() - DAY_MS));
  }

  /** For each incident: how many times the same kind of problem was fixed within 150 m in the 6 months before it was first reported. */
  repeatMap(): Promise<Map<string, Repeat>> {
    return this.mutex.run(() => this.repeatMapRaw(this.clock()));
  }

  private async repeatMapRaw(now: number): Promise<Map<string, Repeat>> {
    {
      const all = (await this.store.listIncidents()).filter((s) => s.status !== 'merged');
      const fixed = all.filter((s) => FINISHED.includes(s.workflow?.stage ?? '') && !s.workflow?.rejection && s.resolvedAt);
      const out = new Map<string, Repeat>();
      for (const s of all) {
        const prior = fixed.filter((f) => f !== s && (f.incident.family === 'ROAD') === (s.incident.family === 'ROAD') && f.resolvedAt! <= s.incident.firstReportedAt && now - f.resolvedAt! < 180 * DAY_MS && haversineMeters(f.incident.centroid, s.incident.centroid) <= 150);
        if (prior.length > 0) out.set(s.incident.id, { count: prior.length, lastFixedAt: Math.max(...prior.map((f) => f.resolvedAt!)) });
      }
      return out;
    }
  }

  /** The fix photo for an incident, if an officer uploaded one. */
  async proofOf(id: string): Promise<StoredIncident | undefined> {
    const s = await this.store.getIncident(id);
    return s?.proof ? s : undefined;
  }

  /** Numbers anyone can see: how many problems, how many fixed, how fast, ward by ward, and what was fixed recently. */
  publicSummary(scope?: { lat: number; lng: number; km: number }): Promise<PublicSummary> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const inScope = (p: { lat: number; lng: number }) => !scope || haversineMeters(scope, p) <= scope.km * 1000;
      const all = (await this.store.listIncidents()).filter((s) => s.status !== 'merged' && inScope(s.incident.centroid));
      const fixed = all.filter((s) => ['RESOLVED', 'CONFIRMED', 'CLOSED'].includes(s.workflow?.stage ?? '') && !s.workflow?.rejection);
      const hours = (list: StoredIncident[]) => { const h = list.filter((s) => s.resolvedAt).map((s) => (s.resolvedAt! - s.detectedAt) / 3_600_000); return h.length ? Math.round((h.reduce((a, b) => a + b, 0) / h.length) * 10) / 10 : null; };
      const wardRows = this.city.localities.filter(inScope).map((l) => {
        const mine = all.filter((s) => wardOf(this.city, s.incident.centroid.lat, s.incident.centroid.lng)?.id === l.id);
        const done = mine.filter((s) => fixed.includes(s));
        return { id: l.id, name: l.name, open: mine.length - done.length, fixed: done.length, avgHours: hours(done) };
      }).sort((a, b) => b.open + b.fixed - (a.open + a.fixed));
      const wards = wardRows.slice(0, 8); // a country-wide list would be endless: show the busiest few
      return {
        totals: { reports: all.reduce((n, s) => n + s.incident.complaintCount, 0), open: all.length - fixed.length, fixed: fixed.length, avgHours: hours(fixed) },
        wards,
        moreWards: wardRows.length - wards.length,
        scope,
        recentlyFixed: fixed.filter((s) => s.workflow?.stage !== 'RESOLVED').sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, 6).map((s) => ({ id: s.incident.id, issueType: mainIssue(s), ward: wardOf(this.city, s.incident.centroid.lat, s.incident.centroid.lng)?.name, hours: s.resolvedAt ? Math.round(((s.resolvedAt - s.detectedAt) / 3_600_000) * 10) / 10 : null, hasProof: !!s.proof })),
      };
    });
  }

  /** Zones that may fail next. A labelled heuristic, not a prediction: open leaks and outages, a rising run of low-pressure reports, and trouble upstream. */
  riskZones(): Promise<RiskZone[]> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const zoneOf = (p: { lat: number; lng: number }) => wardOf(this.city, p.lat, p.lng)?.zoneId;
      const open = (await this.store.listIncidents()).filter((s) => isActive(s) && s.incident.family !== 'ROAD');
      const low = (await this.store.complaintsSince(now - 6 * 3_600_000)).filter((c) => c.issueType === 'LOW_PRESSURE');
      const chronic = (await this.supplyAt(now)).filter((w) => w.chronic);
      return this.city.zones.map((z) => {
        const own = open.filter((s) => zoneOf(s.incident.centroid) === z.id).length;
        const lowN = low.filter((c) => zoneOf(c) === z.id).length;
        const upstream = this.city.zones.filter((u) => u.feeds.includes(z.id) && open.some((s) => zoneOf(s.incident.centroid) === u.id)).length;
        const bad = chronic.filter((w) => this.city.localities.find((l) => l.id === w.id)?.zoneId === z.id);
        const score = 3 * own + 2 * Math.min(3, lowN) + 2 * upstream + 3 * bad.length;
        const reasons = [...bad.map((w) => `residents' diary: water missed or late on ${w.badDays} of the last 7 days in ${w.name}`), own && `${own} open water problem${own > 1 ? 's' : ''} here`, lowN && `${lowN} low-pressure report${lowN > 1 ? 's' : ''} in the last 6 hours (often comes before a failure)`, upstream && 'trouble in the zone that feeds this one'].filter(Boolean) as string[];
        return { zone: z.id, name: z.name, level: (score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW') as RiskZone['level'], reasons };
      }).filter((r) => r.level !== 'LOW').sort((a, b) => (a.level === b.level ? 0 : a.level === 'HIGH' ? -1 : 1));
    });
  }

  /** Certificate for the first trusted reporter and everyone who confirmed, once the citizen has confirmed the fix. */
  certificate(incidentId: string, reporterId: string): Promise<{ valid: boolean; role?: string; incidentId: string; what?: string }> {
    return this.mutex.run(async () => {
      const s = await this.mustFind(incidentId);
      const w = s.workflow;
      const done = (w?.stage === 'CONFIRMED' || w?.stage === 'CLOSED') && !w.rejection;
      if (!done) return { valid: false, incidentId };
      const members = (await this.store.complaintsSince(s.incident.firstReportedAt - 1)).filter((c) => s.incident.complaintIds.includes(c.id));
      const trusted = new Set(s.incident.trust.authenticity.filter((a) => a.band === 'TRUSTED').map((a) => a.complaintId));
      const first = members.filter((c) => trusted.has(c.id)).sort((a, b) => a.createdAt - b.createdAt)[0];
      const role = first?.reporterId === reporterId ? 'First Reporter' : (await this.store.confirmers(incidentId)).includes(reporterId) ? 'Verified Contributor' : undefined;
      return { valid: !!role, role, incidentId, what: `${s.incident.family.toLowerCase()} problem` };
    });
  }

  /** Numbers for the officer overview. */
  stats(): Promise<{ open: number; byLevel: Record<string, number>; needsVerification: number; slaAtRisk: number; avgHoursToResolve: number | null }> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const all = await this.store.listIncidents();
      const open = all.filter(isActive);
      const byLevel: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      for (const s of open) byLevel[s.incident.severity.level]++;
      const done = all.filter((s) => s.resolution === 'manual' && s.resolvedAt);
      return {
        open: open.length,
        byLevel,
        needsVerification: open.filter((s) => s.incident.trust.needsVerification).length,
        slaAtRisk: open.filter((s) => s.workflow && s.workflow.slaDueAt - now < 3_600_000).length,
        avgHoursToResolve: done.length ? Math.round((done.reduce((t, s) => t + (s.resolvedAt! - s.detectedAt), 0) / done.length / 3_600_000) * 10) / 10 : null,
      };
    });
  }

  /** Demo only: store ready-made complaints (scenarios) and re-run detection. */
  ingestDemo(complaints: readonly Complaint[]): Promise<StoredIncident[]> {
    return this.mutex.run(async () => {
      for (const c of complaints) await this.store.addComplaint(c);
      this.dirty = true;
      return this.recompute(this.clock());
    });
  }

  /** Reports that are not part of any incident yet (an incident needs 3 reports, roads 2). Officers must still see them. */
  pending(): Promise<PendingReport[]> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const used = new Set((await this.store.listIncidents()).filter((s) => s.status !== 'merged').flatMap((s) => s.incident.complaintIds));
      return (await this.store.complaintsSince(now - this.windowMs)).filter((c) => !used.has(c.id)).reverse().map(toPublic);
    });
  }

  /** A citizen's own reports and the incident each one belongs to, if any. */
  mine(reporterId: string): Promise<(PendingReport & { incidentId: string | null })[]> {
    return this.mutex.run(async () => {
      const now = this.clock();
      await this.recompute(now);
      const incidents = (await this.store.listIncidents()).filter((s) => s.status !== 'merged');
      return (await this.store.complaintsSince(now - this.windowMs)).filter((c) => c.reporterId === reporterId).reverse()
        .map((c) => ({ ...toPublic(c), incidentId: incidents.find((s) => s.incident.complaintIds.includes(c.id))?.incident.id ?? null }));
    });
  }

  /** Loads the sample town, then moves a few incidents along the workflow so every screen has something to show. */
  /**
   * Loads the sample town. If it is already loaded: `replace` (the demo city) starts it again fresh; otherwise
   * (a real city) it refuses rather than wiping that city's reports. Loading it twice used to fail with a 500.
   */
  async loadSample(opts: { replace?: boolean } = {}): Promise<number> {
    const now = this.clock();
    const H = 3_600_000;
    const spot = (id: string) => this.city.localities.find((l) => l.id === id) ?? this.city.localities[0];
    const data = sampleDataset(now, spot);
    const ids = new Set(data.map((c) => c.id));
    if ((await this.store.complaintsSince(0)).some((c) => ids.has(c.id))) {
      if (!opts.replace) throw new AppError(409, 'sample_already_loaded', 'The sample town is already loaded in this city.');
      await this.clear();
    }
    const created = await this.ingestDemo(data);
    const find = (prefix: string) => created.find((s) => s.incident.complaintIds.some((id) => id.startsWith(prefix)))?.incident.id;
    const photo = await placeholderPhoto();
    const fix: [string, 'L1' | 'L2', object?][] = [['verify', 'L1'], ['approve', 'L2'], ['assign', 'L2'], ['start', 'L1'], ['resolve', 'L1', { proofHash: 'sample-proof' }]];
    const steps: [string, [string, 'L1' | 'L2', object?][]][] = [
      ['s1-', fix.slice(0, 4)],            // in progress
      ['s5-', fix],                        // fix photo waiting for a senior officer
      ['s8-', [...fix, ['approve-proof', 'L2']]],
      ['s7-', [...fix, ['approve-proof', 'L2']]],
      ['cr1-', [['reject', 'L1', { reason: 'Crew found water running normally' }], ['approve-rejection', 'L2']]], // the crowd fooled nobody for long
    ];
    for (const [prefix, actions] of steps) {
      const id = find(prefix);
      for (const [action, role, extra] of actions) if (id) await this.act(id, { action, role, ...extra }, undefined, action === 'resolve' ? photo : undefined).catch(() => undefined);
    }
    // one fix the citizen has already confirmed, so the community page has something to show
    const done = created.find((s) => s.incident.complaintIds.some((id) => id.startsWith('s8-')));
    const reporter = done && (await this.reportersOf(done))[0];
    if (done && reporter) await this.act(done.incident.id, { action: 'confirm', role: 'CITIZEN' }, reporter).catch(() => undefined);

    // Real-looking timelines: everything above happened "now"; spread it over the hours it would really take.
    const timeline: [string, number, number, boolean?][] = [
      ['s8-', 20 * 60_000, 14 * H, true], // dirty water: fixed in 14 h, missed its 12 h deadline once
      ['s7-', 30 * 60_000, 20 * H],       // school pothole: fixed in 20 h
      ['cr1-', 15 * 60_000, 5 * H],       // the crowd's first fake: rejected after a site visit
      ['s1-', 10 * 60_000, -1],           // still in progress: steps spread up to now
      ['s5-', 10 * 60_000, -1],
    ];
    for (const [prefix, detectAfter, takes, breach] of timeline) {
      const id = find(prefix);
      const s = id ? await this.store.getIncident(id) : undefined;
      if (!s?.workflow) continue;
      const start = s.incident.firstReportedAt + detectAfter;
      const end = takes < 0 ? now - 60_000 : Math.min(now - 60_000, start + takes);
      const audit = [...s.workflow.audit];
      if (breach) audit.splice(Math.max(1, audit.length - 2), 0, { at: 0, role: 'L1', action: 'sla-breach', note: 'moved to level 2' });
      const step = audit.length > 1 ? (end - start) / (audit.length - 1) : 0;
      audit.forEach((x, i) => { x.at = Math.round(start + i * step); });
      const resolvedAt = s.resolvedAt !== undefined ? end : undefined;
      await this.store.saveIncidents([{ ...s, detectedAt: start, resolvedAt, updatedAt: end, workflow: { ...s.workflow, audit, slaDueAt: start + (s.workflow.slaDueAt - s.detectedAt) }, proof: s.proof && { ...s.proof, at: audit.find((x) => x.action === 'resolve')?.at ?? end } }]);
    }
    this.dirty = true;
    await this.loadDiaryAndNotices(now);
    return data.length;
  }

  private async loadDiaryAndNotices(now: number): Promise<void> {
    const week: Record<string, Checkin['status'][]> = {
      L1: ['CAME', 'CAME', 'CAME', 'CAME', 'CAME', 'CAME', 'CAME'], L2: ['CAME', 'CAME', 'CAME', 'LATE', 'CAME', 'CAME', 'CAME'], L3: ['CAME', 'LATE', 'CAME', 'CAME', 'LATE', 'CAME', 'CAME'],
      L4: ['LATE', 'CAME', 'LATE', 'LATE', 'CAME', 'LATE', 'CAME'], L5: ['NONE', 'NONE', 'LATE', 'NONE', 'NONE', 'CAME', 'NONE'], L6: ['CAME', 'NONE', 'CAME', 'LATE', 'CAME', 'NONE', 'CAME'],
    };
    for (const l of this.city.localities.filter((x) => week[x.id])) {
      for (let person = 1; person <= 3; person++) {
        for (let d = 0; d < 7; d++) {
          const status = person === 3 && d % 3 === 0 && l.id !== 'L5' ? 'CAME' : week[l.id][d]; // households differ a little, except where it is really bad
          await this.store.addCheckin({ id: `sample-${l.id}-${person}|${istDate(now - d * DAY_MS)}`, reporterId: `sample-${l.id}-${person}`, date: istDate(now - d * DAY_MS), status, lat: round3(l.lat), lng: round3(l.lng), wardId: l.id, at: now - d * DAY_MS });
        }
      }
    }
    const base = { createdBy: 'L2' as Role, createdAt: now };
    const centre = (ids: string[]) => { const ls = this.city.localities.filter((l) => ids.includes(l.id)); return { lat: ls.reduce((a, l) => a + l.lat, 0) / ls.length, lng: ls.reduce((a, l) => a + l.lng, 0) / ls.length }; };
    await this.store.saveNotice({ ...base, id: 'sample-notice-1', kind: 'WATER_CUT', title: 'Planned water cut: valve repair on the main line', note: 'Supply returns by evening. Store water for the day.', wardIds: ['L3', 'L4'], ...centre(['L3', 'L4']), radiusM: 1200, startsAt: now - 3_600_000, endsAt: now + 3 * 3_600_000 });
    await this.store.saveNotice({ ...base, id: 'sample-notice-2', kind: 'ROAD_WORK', title: 'Road resurfacing near the Ward 6 market', note: 'One lane closed. Use the service road.', wardIds: ['L6'], ...centre(['L6']), radiusM: 1000, startsAt: now + 20 * 3_600_000, endsAt: now + 30 * 3_600_000 });
  }

  clear(): Promise<void> {
    return this.mutex.run(async () => { await this.store.clear(); this.dirty = true; this.ringOf.clear(); this.ringList = []; });
  }

  directory = () => DIRECTORY;
  subgraph = (incidentId: string) => this.store.subgraph(incidentId);
  downstream = (zone: string, hops = 3) => this.store.downstream(zone, hops);

  /** Reports that are not part of any (non-merged) incident. Oldest first. */
  private async pendingRaw(now: number): Promise<Complaint[]> {
    const used = new Set((await this.store.listIncidents()).filter((s) => s.status !== 'merged').flatMap((s) => s.incident.complaintIds));
    return (await this.store.complaintsSince(now - this.windowMs)).filter((c) => !used.has(c.id));
  }

  private async reportersOf(s: StoredIncident): Promise<string[]> {
    const ids = new Set(s.incident.complaintIds);
    return [...new Set((await this.store.complaintsSince(s.incident.firstReportedAt - 1)).filter((c) => ids.has(c.id)).map((c) => c.reporterId))];
  }

  /**
   * The core loop: load the window, drop complaints already "used up" by resolved incidents, attach the graph's
   * fake-report rings to each complaint, run the engine, reconcile with what is stored, save what changed.
   * Rings depend on incidents (accounts that reported 2+ incidents together far apart), so when saving new incidents
   * changes the rings, detection runs once more with the new rings.
   * Reads within `recomputeTtlMs` of the last run, with no write since, reuse it (one cheap list read).
   */
  private async recompute(now: number): Promise<StoredIncident[]> {
    const ttl = this.opts.recomputeTtlMs ?? 0;
    if (!this.dirty && ttl > 0 && now - this.lastRun < ttl) return this.activeSorted();
    let signature = await this.refreshRings();
    for (let pass = 0; pass < 2; pass++) {
      await this.detectAndSave(now);
      const next = await this.refreshRings();
      if (next === signature) break;
      signature = next;
    }
    this.dirty = false;
    this.lastRun = now;
    return this.activeSorted();
  }

  private async activeSorted(): Promise<StoredIncident[]> {
    const active = (await this.store.listIncidents()).filter(isActive);
    active.sort((a, b) => b.incident.severity.score - a.incident.severity.score || a.incident.id.localeCompare(b.incident.id));
    return active;
  }

  /** Asks the graph for linked accounts and groups them into rings. Returns a signature to spot changes. */
  private async refreshRings(): Promise<string> {
    this.ringList = ringsFrom(await this.store.links());
    this.ringOf = new Map(this.ringList.flatMap((r) => r.accounts.map((a) => [a, r] as const)));
    this.opts.network?.record(this.ringList);
    return this.ringList.map((r) => `${r.id}:${r.accounts.length}`).join(',');
  }

  private async detectAndSave(now: number): Promise<void> {
    const stored = await this.store.listIncidents();
    const byId = new Map(stored.map((s) => [s.incident.id, s]));

    // Complaints of a resolved incident must not seed a new one, otherwise
    // resolving would be undone by the very next request.
    const consumed = new Set<string>();
    for (const s of stored) if (s.status === 'resolved') for (const id of s.incident.complaintIds) consumed.add(id);

    const window = (await this.store.complaintsSince(now - this.windowMs)).filter((c) => !consumed.has(c.id)).map((c) => {
      const r = this.ringOf.get(c.reporterId) ?? this.opts.network?.ringFor(c.reporterId);
      return r ? { ...c, ring: { id: r.id, accounts: r.accounts.length, via: r.via } } : c;
    });
    const { incidents } = detectIncidents(window, now, this.opts.engine);

    // Only write what really changed (updatedAt alone is not a change).
    const same = (a: StoredIncident | undefined, b: StoredIncident) => !!a && JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0, proof: b.proof && a.proof ? { ...b.proof, photo: a.proof.photo } : b.proof });
    const changes = reconcile({ clusters: incidents, stored, now }).filter((r) => !same(byId.get(r.incident.id), r));
    if (changes.length > 0) await this.store.saveIncidents(changes);
    if (this.opts.onNewIncident) for (const c of changes) if (!byId.has(c.incident.id) && c.status === 'open') { try { this.opts.onNewIncident(c); } catch { /* a webhook must never break detection */ } }

    const all = changes.length ? await this.store.listIncidents() : stored;
    const extras: StoredIncident[] = [];
    for (const s of all.filter(isActive)) {
      const workflow = s.workflow ? escalateIfOverdue(s.workflow, s.incident, now) : newWorkflow(s.incident, now);
      const possibleCause = findCause(s, all.filter((o) => o.status !== 'merged' && o !== s));
      if (workflow !== s.workflow || JSON.stringify(possibleCause) !== JSON.stringify(s.possibleCause)) extras.push({ ...s, workflow, possibleCause });
    }
    if (extras.length > 0) await this.store.saveIncidents(extras);
  }

  // ---- people ------------------------------------------------------------------------------------------------------

  /** What we know about a reporter (Reporter node in Neo4j). New people start now. */
  async profile(id: string): Promise<Profile> {
    return (await this.store.getReporter(id)) ?? { firstSeen: this.clock(), confirmedResolved: 0, lostDisputes: 0 };
  }

  private async bump(id: string, field: 'confirmedResolved' | 'lostDisputes', now: number): Promise<void> {
    const p = (await this.store.getReporter(id)) ?? { firstSeen: now, confirmedResolved: 0, lostDisputes: 0 };
    p[field]++;
    await this.store.saveReporter(id, p);
  }

  /** Account age and history, added to each complaint for the trust score. */
  async trustFacts(reporterId: string, now = this.clock()): Promise<Pick<Complaint, 'reporterAgeMs' | 'reporterHistory'>> {
    const p = await this.store.getReporter(reporterId);
    if (!p) return { reporterAgeMs: 0 };
    return { reporterAgeMs: now - p.firstSeen, reporterHistory: { confirmedResolved: p.confirmedResolved, lostDisputes: p.lostDisputes } };
  }

  // ---- graph pages (Neo4j) -----------------------------------------------------------------------------------------

  get storeKind(): 'neo4j' | 'memory' { return this.store.kind; }

  /** Fake-report rings found by the graph, and the open incidents each one reported into. */
  rings(): Promise<{ rings: Ring[]; targets: { ring: string; incident: string }[] }> {
    return this.mutex.run(async () => {
      await this.recompute(this.clock());
      return { rings: this.ringList, targets: await this.store.ringTargets(this.ringList) };
    });
  }

  /** What if this asset fails: the wards that would lose water (the root-cause walk, run forwards from any asset). */
  async impact(assetId: string) {
    const asset = (this.city.assets ?? []).find((a) => a.id === assetId);
    if (!asset) throw new AppError(404, 'not_found', 'No such pipe, pump or tank in this city');
    const wards = await this.store.impact(assetId);
    const zones = [...new Set(wards.map((w) => w.zone))].sort();
    return { asset: { id: asset.id, name: asset.name, kind: asset.kind }, wards, zones: zones.map((z) => ({ id: z, name: this.city.zones.find((x) => x.id === z)?.name ?? z })) };
  }

  rootCause() {
    return this.mutex.run(async () => { await this.recompute(this.clock()); return this.store.rootCause(); });
  }

  overview() {
    return this.mutex.run(async () => { await this.recompute(this.clock()); return this.store.overview(this.ringList); });
  }

  wardStatus(ward: string) {
    return this.store.wardStatus(ward);
  }

  /** What people said in one incident, in their own words and in English (Sarvam). Officers only. */
  voices(incidentId: string): Promise<{ text: string; textEn?: string; language?: string; at: number; issueType: string }[]> {
    return this.mutex.run(async () => {
      const s = await this.mustFind(incidentId);
      const ids = new Set(s.incident.complaintIds);
      return (await this.store.complaintsSince(s.incident.firstReportedAt - 1)).filter((c) => ids.has(c.id) && c.text).slice(-12).reverse().map((c) => ({ text: c.text!, textEn: c.textEn, language: c.language, at: c.createdAt, issueType: c.issueType }));
    });
  }

  /** "Ask BharatPulse": a question in any language, answered from the graph. */
  ask(question: string, language?: string): Promise<Answer> {
    const tools = {
      rootCause: () => this.store.rootCause(),
      rings: async () => ({ rings: this.ringList, targets: await this.store.ringTargets(this.ringList) }),
      downstream: (zone: string) => this.store.downstream(zone, 3),
      wardStatus: (ward: string) => this.store.wardStatus(ward),
      top: () => this.activeSorted(),
      repeats: async () => [...(await this.repeatMapRaw(this.clock()))].map(([incident, r]) => ({ incident, fixedBefore: r.count })),
    };
    return this.mutex.run(async () => {
      await this.recompute(this.clock());
      return ask(question, tools, this.city, this.opts.sarvam, language);
    });
  }

  // ---- Sarvam: language packs ----------------------------------------------------------------------------------------

  /**
   * The app's words in another Indian language, made by Sarvam-Translate once and cached in the store
   * (a Cache node in Neo4j), so every later visitor gets them instantly.
   */
  async languagePack(lang: string, english: Record<string, string>): Promise<{ lang: string; strings: Record<string, string>; translated: number; cached: boolean }> {
    if (!LANGUAGES[lang] || lang === 'en-IN') throw new AppError(400, 'validation_error', `language must be one of ${Object.keys(LANGUAGES).join(', ')}`);
    const hash = createHash('sha256').update(JSON.stringify(Object.entries(english).sort())).digest('hex').slice(0, 12);
    const key = `pack:${lang}:${hash}`;
    const hit = await this.store.getCache(key);
    if (hit) { const strings = JSON.parse(hit) as Record<string, string>; return { lang, strings, translated: Object.keys(strings).length, cached: true }; }
    if (!this.opts.sarvam) throw new AppError(503, 'translation_unavailable', 'Sarvam is not configured on the server, so only English and Hindi are available');
    const strings = await buildPack(english, lang, this.opts.sarvam);
    if (Object.keys(strings).length > Object.keys(english).length * 0.6) await this.store.setCache(key, JSON.stringify(strings));
    return { lang, strings, translated: Object.keys(strings).length, cached: false };
  }

  private async mustFind(id: string): Promise<StoredIncident> {
    const found = await this.store.getIncident(id);
    if (!found) throw new AppError(404, 'not_found', `No incident with id "${id}"`);
    return found;
  }

  private assertActive(s: StoredIncident, verb: string): void {
    if (isActive(s)) return;
    if (s.status === 'merged') {
      throw new AppError(409, 'incident_merged', `Cannot ${verb}: incident was merged into another`, { mergedInto: s.mergedInto });
    }
    throw new AppError(409, 'incident_resolved', `Cannot ${verb}: incident is already resolved`);
  }
}
