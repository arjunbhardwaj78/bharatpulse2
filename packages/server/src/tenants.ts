import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CITY, CITY_CENTER, generateCity, type City } from './data.js';
import { AppError } from './errors.js';
import { MemoryStore } from './memoryStore.js';
import { checkWebhookUrl, resolvesPublic } from './netguard.js';
import { benchmarks, NetworkWatch, type Benchmarks, type NetworkSummary } from './network.js';
import { Q } from './cypher.js';
import { orgType, ORG_TYPES, type OrgType, type Partner, type Referral } from './orgs.js';
import { genuineOutage, rng, roadCluster } from './scenarios.js';
import { IncidentService, type ServiceOptions } from './service.js';
import type { IncidentStore } from './store.js';
import type { StoredIncident } from './types.js';

/**
 * BharatPulse as a SaaS: one deployment serves many cities ("tenants"). Each city has its own wards, zones and water
 * network, its own officers and password, its own data (a separate tenant in Neo4j), API keys for plugging in an
 * existing grievance portal, webhooks, a plan, and a usage meter.
 */

export interface Plan {
  id: 'pilot' | 'town' | 'city' | 'connect' | 'site';
  sector?: 'government' | 'private';
  name: string;
  /** Pricing hypothesis, INR. */
  price: string;
  blurb: string;
  maxWards: number;
  limits: { reports: number; sarvamCalls: number };
  includes: string[];
}

export const PLANS: Plan[] = [
  { id: 'pilot', name: 'Pilot', price: 'Free for 90 days', blurb: 'Try it in a few wards with real residents.', maxWards: 10, limits: { reports: 2_000, sarvamCalls: 2_000 }, includes: ['Citizen app + officer portal', 'Fake-report detection (Neo4j)', 'Voice in 22 languages (Sarvam)', 'Up to 10 wards'] },
  { id: 'town', name: 'Town', price: '₹1,500 per ward / month', blurb: 'For a Nagar Palika or Nagar Panchayat.', maxWards: 60, limits: { reports: 30_000, sarvamCalls: 30_000 }, includes: ['Everything in Pilot', 'Root cause on your water network', 'Ask BharatPulse in 11 languages', 'API + webhooks into your portal'] },
  { id: 'city', name: 'City', price: '₹1,100 per ward / month', blurb: 'For a Municipal Corporation, 60+ wards.', maxWards: 400, limits: { reports: 300_000, sarvamCalls: 300_000 }, includes: ['Everything in Town', 'Multiple departments and zones', 'SLA reports for the commissioner', 'Priority support'] },
  { id: 'site', name: 'Enterprise site', sector: 'private', price: '₹20,000 per site / month', blurb: 'For water utilities, toll roads, industrial parks and campuses.', maxWards: 40, limits: { reports: 100_000, sarvamCalls: 100_000 }, includes: ['Everything in Town', 'Your own job titles and areas', 'Referrals to the municipality that feeds you', 'API into your ERP / maintenance system'] },
  { id: 'connect', name: 'Connect', price: '₹0.40 per complaint processed', blurb: 'Keep your portal (CPGRAMS, state 1916). We add the intelligence.', maxWards: 400, limits: { reports: 1_000_000, sarvamCalls: 1_000_000 }, includes: ['Import API and CSV import', 'Fake-report and duplicate scoring', 'English for every complaint', 'Results back by webhook'] },
];

export interface ApiKey { id: string; label: string; prefix: string; hash: string; createdAt: number; lastUsedAt?: number }
export interface Webhook { id: string; url: string; secret: string; createdAt: number; last?: { at: number; status: string } }

export interface Tenant {
  id: string;
  name: string;
  state: string;
  kind: 'demo' | 'customer';
  /** Government body or private operator (see orgs.ts). Older records have none: a municipality. */
  orgType?: OrgType;
  /** A private site fed by a government network: where its supply comes from, with the operator's consent. */
  partner?: Partner;
  plan: Plan['id'];
  createdAt: number;
  center: { lat: number; lng: number };
  city: City;
  contactEmail?: string;
  /** scrypt hash of this city's officer password ("salt:hash"). Absent for the demo city (OFFICER_PASSWORD). */
  officerPassword?: string;
  apiKeys: ApiKey[];
  webhooks: Webhook[];
  /** "2026-11" -> { reports: 12, sarvamCalls: 40, ... } */
  usage: Record<string, Record<string, number>>;
}

/** What anyone may see about a city. */
export const publicTenant = (t: Tenant) => {
  const o = orgType(t.orgType);
  return { id: t.id, name: t.name, state: t.state, kind: t.kind, orgType: o.id, sector: o.sector, orgLabel: o.label, area: o.area, plan: t.plan, center: t.center, wards: t.city.localities.length, zones: t.city.zones.length, createdAt: t.createdAt, fedBy: t.partner ? t.partner.tenant : undefined };
};

const month = (t: number) => new Date(t).toISOString().slice(0, 7);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hashPassword = (pw: string): string => { const salt = randomBytes(12).toString('hex'); return `${salt}:${scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPassword = (pw: string, stored: string): boolean => { const [salt, h] = stored.split(':'); const got = scryptSync(pw, salt, 32); return got.length === Buffer.from(h, 'hex').length && timingSafeEqual(got, Buffer.from(h, 'hex')); };
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'city';

export interface TenantRegistry {
  load(): Promise<string[]>;
  save(id: string, name: string, createdAt: number, data: string): Promise<void>;
  /** Neo4j only: which of these accounts have reported in more than one city (one query across every tenant). */
  crossCity?(ids: string[]): Promise<{ account: string; cities: string[] }[]>;
  /** Neo4j only: the city's pipe FEEDS the private site's tank, across the two workspaces. */
  linkPartner?(to: string, toAsset: string, from: string, fromAsset: string): Promise<void>;
}

export interface HubOptions {
  /** Storage for one city (MemoryStore, or Neo4jStore.forTenant on a shared driver). */
  makeStore?: (t: Tenant) => Promise<IncidentStore>;
  /** Options every city's service gets (Sarvam, auth, TTL ...). */
  serviceOptions?: ServiceOptions;
  registry?: TenantRegistry;
  fetchFn?: typeof fetch;
  /** Webhook DNS check before each delivery (on by default; tests with a fake fetch turn it off or pass `resolve`). */
  checkDns?: boolean;
  resolve?: (host: string) => Promise<string[]>;
  clock?: () => number;
  maxTenants?: number;
}

export class TenantHub {
  readonly defaultId = 'demo';
  private tenants = new Map<string, Tenant>();
  private services = new Map<string, Promise<IncidentService>>();
  private dirty = new Set<string>();
  private readonly clock: () => number;
  private readonly f: typeof fetch;
  /** The shared fraud watchlist every city reads and writes (see network.ts). */
  readonly network = new NetworkWatch();

  constructor(private readonly o: HubOptions = {}) {
    this.clock = o.clock ?? Date.now;
    this.f = o.fetchFn ?? fetch;
  }

  /** The demo city, with the sample town around CITY_CENTER. */
  static demoTenant(city: City = CITY, now = Date.now()): Tenant {
    return { id: 'demo', name: 'Demo Nagar Palika', state: 'Haryana', kind: 'demo', plan: 'town', createdAt: now, center: CITY_CENTER, city, apiKeys: [], webhooks: [], usage: {} };
  }

  /** One city, already running (tests, simulators). New cities still get memory stores. */
  static single(service: IncidentService, o: HubOptions = {}): TenantHub {
    const hub = new TenantHub(o);
    hub.tenants.set('demo', TenantHub.demoTenant(service.city));
    hub.services.set('demo', Promise.resolve(service));
    return hub;
  }

  async init(): Promise<this> {
    for (const raw of (await this.o.registry?.load()) ?? []) {
      try { const t = JSON.parse(raw) as Tenant; this.tenants.set(t.id, t); } catch { /* skip a broken record */ }
    }
    if (!this.tenants.has('demo')) { this.tenants.set('demo', TenantHub.demoTenant(CITY, this.clock())); await this.persist('demo'); }
    else this.tenants.get('demo')!.city = CITY; // the demo map always follows CITY_CENTER
    setInterval(() => void this.flush(), 15_000).unref?.();
    return this;
  }

  list(): Tenant[] { return [...this.tenants.values()].sort((a, b) => (a.kind === b.kind ? a.createdAt - b.createdAt : a.kind === 'demo' ? -1 : 1)); }

  tenant(id: string): Tenant {
    const t = this.tenants.get(id);
    if (!t) throw new AppError(404, 'city_not_found', `No city "${id}" on this platform`);
    return t;
  }

  service(id: string): Promise<IncidentService> {
    const t = this.tenant(id);
    let s = this.services.get(id);
    if (!s) {
      s = (async () => new IncidentService(await (this.o.makeStore ? this.o.makeStore(t) : Promise.resolve(new MemoryStore(t.city))), {
        ...this.o.serviceOptions,
        city: t.city,
        network: { record: (rings) => this.network.record(id, rings), ringFor: (account) => this.network.ringFor(id, account) },
        onNewIncident: (inc) => { void this.fire(id, 'incident.created', incidentEvent(inc, t)); void this.maybeRefer(id, inc); },
      }))();
      this.services.set(id, s);
      s.catch(() => this.services.delete(id));
    }
    return s;
  }

  /** Brings every city's rings into the watchlist (each city's graph is asked once; cheap within the recompute TTL). */
  async warmNetwork(): Promise<void> {
    await Promise.all(this.list().map(async (t) => { try { await (await this.service(t.id)).rings(); } catch { /* one broken city must not hide the rest */ } }));
  }

  /** What the shared watchlist has caught across cities, plus the cross-city graph query when Neo4j is connected. */
  async networkSummary(): Promise<NetworkSummary & { engine: 'neo4j' | 'memory'; cypher: string; graphCrossCity?: number }> {
    await this.warmNetwork();
    const out = this.network.summary(new Map(this.list().map((t) => [t.id, t.name])));
    if (this.o.registry?.crossCity) {
      try { return { ...out, engine: 'neo4j', cypher: Q.crossCityAccounts, graphCrossCity: (await this.o.registry.crossCity(this.network.accounts())).length }; } catch { /* fall back to the watchlist */ }
    }
    return { ...out, engine: 'memory', cypher: Q.crossCityAccounts };
  }

  /** This city against every other city on the platform (others anonymised). */
  async benchmarks(id: string): Promise<Benchmarks> {
    const rows = await Promise.all(this.list().map(async (t) => {
      try {
        const s = await (await this.service(t.id)).stats();
        return { id: t.id, m: { open: s.open, avgHoursToResolve: s.avgHoursToResolve, heldShare: s.open ? Math.round((s.needsVerification / s.open) * 100) / 100 : 0, slaAtRisk: s.slaAtRisk } };
      } catch { return undefined; }
    }));
    return benchmarks({ id, name: this.tenant(id).name }, rows.filter((r): r is NonNullable<typeof r> => !!r));
  }

  // ---- private operators fed by a government network ------------------------------------------------------------
  private refs: Referral[] = [];

  /**
   * A confirmed water outage at a private site whose supply comes from a government network is referred to that
   * government workspace, at the asset that feeds the site. Held (possibly fake) incidents are never referred. The
   * city gets it as ONE report from the organisation (one source), so its own graph can join it with residents'.
   */
  async maybeRefer(id: string, stored: StoredIncident): Promise<Referral | undefined> {
    const inc = stored.incident;
    const t = this.tenants.get(id);
    const p = t?.partner;
    if (!t || !p || inc.family !== 'SUPPLY' || inc.trust.needsVerification) return undefined;
    if (this.refs.some((r) => r.from === id && r.incidentId === inc.id)) return undefined;
    const to = this.tenants.get(p.tenant);
    if (!to) return undefined;
    const asset = to.city.assets.find((a) => a.id === p.asset);
    const r: Referral = {
      id: `ref_${randomBytes(5).toString('hex')}`, from: id, fromName: t.name, to: to.id, toName: to.name, asset: p.asset, assetName: asset?.name ?? p.asset,
      incidentId: inc.id, what: 'No water at the site inlet', reports: inc.complaintCount, people: inc.trust.independentSources, at: this.clock(), status: 'open',
    };
    this.refs.push(r);
    const svc = await this.service(to.id);
    await svc.ingestDemo([{ id: `ref-${id}-${inc.id}`, reporterId: `org:${id}`, deviceId: `org:${id}`, issueType: 'NO_WATER', lat: p.inlet.lat, lng: p.inlet.lng, createdAt: this.clock(), text: `Referred by ${t.name}: no water at our inlet from ${r.assetName}. ${r.reports} reports from ${r.people} people on site.` }]);
    void this.fire(to.id, 'referral.created', { referral: r });
    return r;
  }

  referrals(id: string): { incoming: Referral[]; outgoing: Referral[]; fedBy?: { tenant: string; name: string; asset: string } } {
    const t = this.tenant(id);
    const to = t.partner ? this.tenants.get(t.partner.tenant) : undefined;
    return {
      incoming: this.refs.filter((r) => r.to === id).sort((a, b) => b.at - a.at),
      outgoing: this.refs.filter((r) => r.from === id).sort((a, b) => b.at - a.at),
      fedBy: t.partner && to ? { tenant: to.id, name: to.name, asset: to.city.assets.find((a) => a.id === t.partner!.asset)?.name ?? t.partner.asset } : undefined,
    };
  }

  acknowledge(id: string, refId: string): Referral {
    const r = this.refs.find((x) => x.id === refId && x.to === id);
    if (!r) throw new AppError(404, 'not_found', 'No such referral for this workspace');
    r.status = 'acknowledged';
    return r;
  }

  /**
   * Demo: two private operators next to the demo town, with sample reports. The industrial park takes its water from
   * the town's South feeder (consented link), so its confirmed outage is referred to the town. Safe to call twice.
   */
  async ensurePartners(): Promise<{ partners: ReturnType<typeof publicTenant>[]; referrals: Referral[] }> {
    const demo = this.tenant(this.defaultId);
    const feeder = demo.city.assets.find((a) => a.id === 'M3') ?? demo.city.assets.find((a) => a.kind === 'PIPE')!;
    const now = this.clock();
    const specs = [
      { id: 'hodal-industrial-park', name: 'Hodal Industrial Park', org: 'industrial_park' as const, at: { lat: demo.center.lat - 0.02, lng: demo.center.lng + 0.004 }, partner: { tenant: demo.id, asset: feeder.id, inlet: { lat: feeder.lat - 0.004, lng: feeder.lng + 0.002 }, consent: true as const, since: now } },
      { id: 'nh19-tollway', name: 'NH-19 Tollway (Palwal-Hodal)', org: 'toll_road' as const, at: { lat: demo.center.lat + 0.025, lng: demo.center.lng - 0.02 } },
    ];
    for (const sp of specs) {
      if (this.tenants.has(sp.id)) continue;
      const org = orgType(sp.org);
      const t: Tenant = { id: sp.id, name: sp.name, state: demo.state, kind: 'demo', orgType: org.id, partner: sp.partner, plan: 'site', createdAt: now, center: sp.at, city: generateCity(sp.at, 6, { ward: org.area }), apiKeys: [], webhooks: [], usage: {} };
      this.tenants.set(t.id, t);
      await this.persist(t.id);
      if (sp.partner) await this.o.registry?.linkPartner?.(sp.partner.tenant, sp.partner.asset, t.id, 'T1').catch(() => undefined);
      const svc = await this.service(t.id);
      const r = rng(sp.id.length * 7919);
      const spot = t.city.localities[0];
      await svc.ingestDemo(sp.org === 'industrial_park'
        ? genuineOutage({ n: 7, at: spot, now, r, prefix: `${sp.id}-out-`, minutes: 50, radiusM: 120 })
        : roadCluster({ n: 5, at: t.city.localities[2] ?? spot, now, r, prefix: `${sp.id}-pot-` }));
      await svc.stats(); // detect now, so the referral is made straight away
    }
    return { partners: specs.map((s) => publicTenant(this.tenant(s.id))), referrals: this.refs };
  }

  /** Self-serve onboarding: a new city with a draft map, its own officer password (returned ONCE) and a pilot plan. */
  async create(input: Record<string, unknown>): Promise<{ tenant: ReturnType<typeof publicTenant>; officerPassword: string }> {
    const bad = (m: string) => new AppError(400, 'validation_error', m);
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const state = typeof input.state === 'string' ? input.state.trim() : '';
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    const wards = Number(input.wards ?? 8);
    const plan = (PLANS.find((p) => p.id === input.plan)?.id ?? 'pilot') as Plan['id'];
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    const org = orgType(input.orgType);
    if (input.orgType !== undefined && !ORG_TYPES.some((o) => o.id === input.orgType)) throw bad(`orgType must be one of ${ORG_TYPES.map((o) => o.id).join(', ')}`);
    if (name.length < 3 || name.length > 60) throw bad('City or body name must be 3 to 60 characters');
    if (state.length < 2 || state.length > 40) throw bad('State is required');
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 37 || lng < 68 || lng > 98) throw bad('Pick the city centre on the map (inside India)');
    if (!Number.isInteger(wards) || wards < 2 || wards > 40) throw bad('Wards must be 2 to 40 for self-serve onboarding');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email or leave it empty');
    if (this.tenants.size >= (this.o.maxTenants ?? 200)) throw new AppError(429, 'platform_full', 'This deployment has reached its city limit');
    let id = slugify(name);
    for (let n = 2; this.tenants.has(id) || ['demo', 'admin', 'api', 'www'].includes(id); n++) id = `${slugify(name).slice(0, 28)}-${n}`;
    const officerPassword = `${randomBytes(4).toString('hex')}-${randomBytes(3).toString('hex')}`;
    const t: Tenant = { id, name, state, kind: 'customer', orgType: org.id, plan, createdAt: this.clock(), center: { lat, lng }, city: generateCity({ lat, lng }, wards, { ward: org.area }), contactEmail: email || undefined, officerPassword: hashPassword(officerPassword), apiKeys: [], webhooks: [], usage: {} };
    this.tenants.set(id, t);
    await this.persist(id);
    return { tenant: publicTenant(t), officerPassword };
  }

  /** null when the city uses the platform default (demo city). */
  passwordCheck(id: string): ((pw: string) => boolean) | undefined {
    const stored = this.tenant(id).officerPassword;
    return stored ? (pw) => checkPassword(pw, stored) : undefined;
  }

  setPlan(id: string, plan: unknown): Tenant {
    const p = PLANS.find((x) => x.id === plan);
    if (!p) throw new AppError(400, 'validation_error', `plan must be one of ${PLANS.map((x) => x.id).join(', ')}`);
    const t = this.tenant(id);
    if (t.city.localities.length > p.maxWards) throw new AppError(400, 'validation_error', `${p.name} covers up to ${p.maxWards} wards`);
    t.plan = p.id;
    void this.persist(id);
    return t;
  }

  // ---- usage ---------------------------------------------------------------------------------------------------------
  meter(id: string, key: string, n = 1): void {
    const t = this.tenants.get(id);
    if (!t) return;
    const m = (t.usage[month(this.clock())] ??= {});
    m[key] = (m[key] ?? 0) + n;
    this.dirty.add(id);
  }

  usage(id: string): { month: string; counts: Record<string, number>; plan: Plan; history: { month: string; counts: Record<string, number> }[] } {
    const t = this.tenant(id);
    const m = month(this.clock());
    return { month: m, counts: t.usage[m] ?? {}, plan: PLANS.find((p) => p.id === t.plan)!, history: Object.entries(t.usage).sort().slice(-6).map(([k, v]) => ({ month: k, counts: v })) };
  }

  // ---- API keys (for plugging in an existing portal) ----------------------------------------------------------------
  /** The raw key is returned once; only its SHA-256 is kept. */
  createKey(id: string, label: unknown): { key: string; info: Omit<ApiKey, 'hash'> } {
    const t = this.tenant(id);
    if (t.apiKeys.length >= 10) throw new AppError(400, 'validation_error', 'At most 10 keys per city: revoke one first');
    const raw = `bp_live_${id.replace(/-/g, '').slice(0, 10)}_${randomBytes(18).toString('base64url')}`;
    const k: ApiKey = { id: randomBytes(6).toString('hex'), label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : 'Portal import', prefix: raw.slice(0, 18), hash: sha(raw), createdAt: this.clock() };
    t.apiKeys.push(k);
    void this.persist(id);
    const { hash: _h, ...info } = k;
    return { key: raw, info };
  }

  revokeKey(id: string, keyId: string): void {
    const t = this.tenant(id);
    const before = t.apiKeys.length;
    t.apiKeys = t.apiKeys.filter((k) => k.id !== keyId);
    if (t.apiKeys.length === before) throw new AppError(404, 'not_found', 'No such key');
    void this.persist(id);
  }

  /** The city an API key belongs to, or a 401. */
  cityForKey(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.startsWith('bp_live_')) throw new AppError(401, 'bad_api_key', 'Send a valid key in the x-api-key header');
    const h = sha(raw);
    for (const t of this.tenants.values()) {
      const k = t.apiKeys.find((x) => timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
      if (k) { k.lastUsedAt = this.clock(); this.dirty.add(t.id); return t.id; }
    }
    throw new AppError(401, 'bad_api_key', 'Unknown or revoked API key');
  }

  // ---- webhooks -----------------------------------------------------------------------------------------------------
  addWebhook(id: string, url: unknown): Webhook {
    const t = this.tenant(id);
    const checked = checkWebhookUrl(url);
    if ('error' in checked) throw new AppError(400, 'validation_error', checked.error);
    const u = checked.url;
    if (t.webhooks.length >= 5) throw new AppError(400, 'validation_error', 'At most 5 webhooks per city');
    const w: Webhook = { id: randomBytes(6).toString('hex'), url: u.toString(), secret: `whsec_${randomBytes(16).toString('hex')}`, createdAt: this.clock() };
    t.webhooks.push(w);
    void this.persist(id);
    return w;
  }

  removeWebhook(id: string, hookId: string): void {
    const t = this.tenant(id);
    const before = t.webhooks.length;
    t.webhooks = t.webhooks.filter((w) => w.id !== hookId);
    if (before === t.webhooks.length) throw new AppError(404, 'not_found', 'No such webhook');
    void this.persist(id);
  }

  /** POSTs the event to every webhook of the city, signed with HMAC-SHA256 (header x-bharatpulse-signature). */
  async fire(id: string, event: string, data: unknown, only?: string): Promise<{ id: string; status: string }[]> {
    const t = this.tenants.get(id);
    if (!t) return [];
    const body = JSON.stringify({ event, city: id, at: this.clock(), data });
    return Promise.all(t.webhooks.filter((w) => !only || w.id === only).map(async (w) => {
      let status: string;
      try {
        // the name is resolved again before each delivery (it may now point inside the network); redirects are not followed
        if (this.o.checkDns !== false && !(await resolvesPublic(new URL(w.url).hostname, this.o.resolve))) status = 'blocked: not a public address';
        else {
          const res = await this.f(w.url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', 'x-bharatpulse-event': event, 'x-bharatpulse-signature': createHmac('sha256', w.secret).update(body).digest('hex') }, body, signal: AbortSignal.timeout(5000) });
          status = String(res.status);
        }
      } catch {
        status = 'unreachable';
      }
      w.last = { at: this.clock(), status };
      this.meter(id, 'webhooks');
      return { id: w.id, status };
    }));
  }

  // ---- persistence --------------------------------------------------------------------------------------------------
  private async persist(id: string): Promise<void> {
    const t = this.tenants.get(id);
    if (!t || !this.o.registry) return;
    this.dirty.delete(id);
    await this.o.registry.save(t.id, t.name, t.createdAt, JSON.stringify(t)).catch(() => this.dirty.add(id));
  }

  async flush(): Promise<void> {
    for (const id of [...this.dirty]) await this.persist(id);
  }
}

/** What a webhook receives when a new incident is detected. */
export function incidentEvent(s: StoredIncident, t: Tenant) {
  const c = s.incident.centroid;
  const ward = [...t.city.localities].sort((a, b) => Math.hypot(a.lat - c.lat, a.lng - c.lng) - Math.hypot(b.lat - c.lat, b.lng - c.lng))[0];
  return { id: s.incident.id, family: s.incident.family, level: s.incident.severity.level, score: s.incident.severity.score, people: s.incident.trust.independentSources, reports: s.incident.complaintCount, needsVerification: s.incident.trust.needsVerification, ward: ward?.name, lat: c.lat, lng: c.lng, recommendedAction: s.incident.recommendedAction };
}
