export type Role = 'L1' | 'L2' | 'L3' | 'L4' | 'CITIZEN';
export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Band = 'TRUSTED' | 'REVIEW' | 'LIKELY_FAKE';
export interface Workflow { stage: string; level: 1 | 2 | 3; slaDueAt: number; proofBy?: Role; audit: { at: number; role: Role; action: string; note?: string }[]; rejection?: { reason: string; approved: boolean }; disputed?: boolean }
export interface Incident {
  id: string; family: 'SUPPLY' | 'QUALITY' | 'INFRASTRUCTURE' | 'ROAD'; complaintCount: number; centroid: { lat: number; lng: number }; radiusMeters: number;
  firstReportedAt: number; lastReportedAt: number; issueBreakdown: Record<string, number>; recommendedAction: string; status: string; resolution?: string;
  severity: { score: number; level: Level; base: number; credibility: number; factors: { name: string; points: number; max: number; detail: string }[] };
  trust: { rawReports: number; independentSources: number; trustedSources: number; nEff: number; credibility: number; needsVerification: boolean; bands: Record<Band, number>; authenticity: { complaintId: string; score: number; band: Band; signals: { code: string; points: number }[] }[] };
  hasProof?: boolean; repeat?: { count: number; lastFixedAt: number }; workflow?: Workflow; possibleCause?: { incidentId: string; distanceM: number };
}
export interface Office { id: string; name: string; address: string; phone: string; handles: ('WATER' | 'ROADS')[]; sample?: boolean }
export interface FoundOffice { name: string; address?: string; phone?: string; source: 'google' | 'osm' }
export interface Place { nearby?: { address?: string; offices: FoundOffice[] }; emergency: { name: string; phone: string }; zone?: { id: string; name: string; locality: string }; contact?: { name: string; role: string; phone: string; sample?: boolean }; office?: Office; officeHandlesBoth: boolean }
export interface Health { status: string; voice: boolean; graph?: 'neo4j' | 'memory'; sarvam?: { enabled: boolean; models?: Record<string, string>; calls?: Record<string, number> }; languages?: Record<string, string>; officerLogin: boolean; geofence: boolean; admin: 'open' | 'key' | 'off' }
export interface Report { id: string; issueType: string; createdAt: number; lat: number; lng: number; localityId?: string; address?: string; text?: string; textEn?: string; language?: string }
export interface MyComplaint extends Report { incidentId: string | null; office?: Office }
export interface NearbyItem { lat: number; lng: number; mine?: boolean; kind: 'incident' | 'report' | 'fixed'; id: string; issueType: string; family: string; reports: number; people: number; lastAt: number; distanceM: number; stage?: string }
export interface PublicSummary { moreWards: number; scope?: { lat: number; lng: number; km: number }; totals: { reports: number; open: number; fixed: number; avgHours: number | null }; wards: { id: string; name: string; open: number; fixed: number; avgHours: number | null }[]; recentlyFixed: { id: string; issueType: string; ward?: string; hours: number | null; hasProof: boolean }[] }
export interface RiskZone { zone: string; name: string; level: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[] }
export interface Checkin { id: string; date: string; status: 'CAME' | 'LATE' | 'NONE' }
export interface Notice { id: string; kind: 'WATER_CUT' | 'ROAD_WORK' | 'OTHER'; title: string; note?: string; wardIds: string[]; startsAt: number; endsAt: number; createdBy: Role }
export interface SupplyWard { id: string; name: string; people: number; total: number; reliability: number; badDays: number; chronic: boolean }
export interface Officer { id: string; name: string; role: Role; office: string }
export interface City { id?: string; name?: string; state?: string; service?: { center: { lat: number; lng: number }; radiusKm: number }; zones: { id: string; name: string; feeds: string[] }[]; localities: { id: string; name: string; zoneId: string; lat: number; lng: number }[]; facilities: { id: string; type: string; name: string; lat: number; lng: number }[]; assets?: Asset[] }
export interface NetworkSummary { cities: number; citiesSharing: number; watchedAccounts: number; crossCityAccounts: number; heldOnFirstReport: number; crowds: { origin: string; size: number; via: string[]; seenIn: string[]; heldReports: number }[]; engine: Engine; cypher: string; graphCrossCity?: number }
export interface Benchmark { open: number; avgHoursToResolve: number | null; heldShare: number; slaAtRisk: number }
export interface Benchmarks { you: Benchmark & { name: string }; peers: (Benchmark & { label: string })[]; median: Benchmark; note: string }
export interface Asset { id: string; kind: 'TANK' | 'PUMP' | 'PIPE'; name: string; lat: number; lng: number; feeds: string[]; supplies: string[] }
export interface Graph { nodes: { id: string; type: string; label: string }[]; edges: { from: string; to: string; type: string }[]; sharedDevices: { deviceId: string; reporters: number }[]; engine?: Engine; cypher?: string[] }
export type Engine = 'neo4j' | 'memory';
export interface Ring { id: string; accounts: string[]; via: ('DEVICE' | 'PHOTO' | 'CO_REPORTING')[] }
export interface AssetImpact { asset: { id: string; name: string; kind: string }; wards: { localityId: string; name: string; zone: string }[]; zones: { id: string; name: string }[]; engine: Engine; cypher: string[] }
export interface RootCause { zonesHit: string[]; incidents: string[]; suspects: { assetId: string; name: string; kind: string; covers: string[]; distance: number }[]; atRisk: { localityId: string; name: string; zone: string }[]; engine: Engine; cypher: string[] }
export interface OverviewNode { id: string; type: 'Asset' | 'Zone' | 'Locality' | 'Incident' | 'Ring'; label: string; kind?: string; level?: string; flag?: string; lat?: number; lng?: number }
export interface Overview { nodes: OverviewNode[]; edges: { from: string; to: string; type: string }[]; engine: Engine }
export interface Answer { question: string; questionEn: string; language: string; tool: string; args: Record<string, string>; cypher: string[]; data: unknown; answer: string; answerEn: string; via: { understood: 'sarvam' | 'keywords'; worded: 'sarvam' | 'template'; translated: boolean }; engine: Engine }
export interface CityInfo { id: string; name: string; state: string; kind: 'demo' | 'customer'; orgType?: string; sector?: 'government' | 'private'; orgLabel?: string; area?: string; fedBy?: string; plan: string; center: { lat: number; lng: number }; wards: number; zones: number; createdAt: number }
export interface Referral { id: string; from: string; fromName: string; to: string; toName: string; asset: string; assetName: string; incidentId: string; what: string; reports: number; people: number; at: number; status: 'open' | 'acknowledged' }
export interface Plan { id: string; name: string; price: string; blurb: string; maxWards: number; limits: { reports: number; sarvamCalls: number }; includes: string[] }
export interface Suggestion { name: string; detail: string; lat: number; lng: number; kind: string }
export interface ApiKeyInfo { id: string; label: string; prefix: string; createdAt: number; lastUsedAt?: number }
export interface WebhookInfo { id: string; url: string; createdAt: number; secretHint: string; last?: { at: number; status: string } }
export interface Console { city: CityInfo; usage: { month: string; counts: Record<string, number>; plan: Plan; history: { month: string; counts: Record<string, number> }[] }; plans: Plan[]; stats: { open: number; needsVerification: number; avgHoursToResolve: number | null }; graph: Engine; apiKeys: ApiKeyInfo[]; webhooks: WebhookInfo[]; map: { zones: number; wards: number; assets: number }; officers: string[] }
export interface Heard { text: string; textEn?: string; language?: string; issueType?: string; engine?: string }
export interface Voice { text: string; textEn?: string; language?: string; at: number; issueType: string }
export type Rules = Record<string, { from: string[]; roles: Role[]; to: string }>;

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

/** Who is calling. Kept in one place so every request carries the same session, role and admin key. */
export const ctx = {
  token: localStorage.getItem('bp_token') ?? '',
  reporterId: localStorage.getItem('bp_reporter') ?? '',
  officerToken: localStorage.getItem('bp_officer_token') ?? '',
  officer: JSON.parse(localStorage.getItem('bp_officer') ?? 'null') as Officer | null,
  adminKey: '',
  /** Which city (tenant) this browser is using. Officers and citizens of different cities never mix. */
  city: localStorage.getItem('bp_city') ?? 'demo',
  deviceId: (() => { const d = localStorage.getItem('bp_device') ?? crypto.randomUUID(); localStorage.setItem('bp_device', d); return d; })(),
};

// A production build without VITE_API_URL would silently call the visitor's own localhost. Fail loudly instead.
const BASE: string = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:3000');

async function call<T>(path: string, method = 'GET', body?: unknown, who: 'citizen' | 'officer' | 'none' = 'citizen'): Promise<T> {
  const headers: Record<string, string> = {};
  if (who === 'officer' && ctx.officerToken) headers['x-officer'] = ctx.officerToken;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (who === 'citizen' && ctx.token) headers['x-session'] = ctx.token;
  if (ctx.adminKey) headers['x-admin-key'] = ctx.adminKey;
  headers['x-tenant'] = ctx.city;
  if (!BASE) throw new ApiError('config', 'This site is not connected to the server: VITE_API_URL was not set when it was built (Vercel > Settings > Environment Variables, then redeploy).', 0);
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error?.code ?? 'error', json.error?.message ?? `Request failed (${res.status})`, res.status);
  return json as T;
}

/** Switch city: officer sign-ins belong to one city, so they are dropped. */
export function setCity(id: string): void {
  if (id === ctx.city) return;
  ctx.city = id; localStorage.setItem('bp_city', id);
  ctx.officerToken = ''; ctx.officer = null; localStorage.removeItem('bp_officer_token'); localStorage.removeItem('bp_officer');
}

export const api = {
  cities: () => call<{ cities: CityInfo[] }>('/cities', 'GET', undefined, 'none').then((r) => r.cities),
  plans: () => call<{ plans: Plan[] }>('/plans', 'GET', undefined, 'none').then((r) => r.plans),
  createCity: (body: Record<string, unknown>) => call<{ tenant: CityInfo; officerPassword: string }>('/cities', 'POST', body, 'none'),
  suggest: (q: string) => call<{ places: Suggestion[] }>(`/places/suggest?q=${encodeURIComponent(q)}`, 'GET', undefined, 'none').then((r) => r.places),
  console: () => call<Console>('/admin/console', 'GET', undefined, 'officer'),
  setPlan: (plan: string) => call<CityInfo>('/admin/plan', 'POST', { plan }, 'officer'),
  createKey: (label: string) => call<{ key: string; info: ApiKeyInfo }>('/admin/keys', 'POST', { label }, 'officer'),
  revokeKey: (id: string) => call(`/admin/keys/${id}`, 'DELETE', undefined, 'officer'),
  addWebhook: (url: string) => call<WebhookInfo & { secret: string }>('/admin/webhooks', 'POST', { url }, 'officer'),
  removeWebhook: (id: string) => call(`/admin/webhooks/${id}`, 'DELETE', undefined, 'officer'),
  testWebhook: (id: string) => call<{ results: { id: string; status: string }[] }>(`/admin/webhooks/${id}/test`, 'POST', {}, 'officer'),
  importComplaints: (complaints: Record<string, unknown>[], source: string) => call<{ accepted: number; duplicates: number; rejected: { index: number; reason: string }[]; activeIncidents: number }>('/admin/import', 'POST', { complaints, source }, 'officer'),
  health: () => call<Health>('/health', 'GET', undefined, 'none'),
  network: () => call<NetworkSummary>('/network', 'GET', undefined, 'none'),
  referrals: () => call<{ incoming: Referral[]; outgoing: Referral[]; fedBy?: { tenant: string; name: string; asset: string } }>('/referrals', 'GET', undefined, 'officer'),
  ackReferral: (id: string) => call<Referral>(`/referrals/${id}/ack`, 'POST', {}, 'officer'),
  seedPartners: () => call<{ partners: CityInfo[]; referrals: Referral[] }>('/admin/seed-partners', 'POST', {}, 'officer'),
  benchmarks: () => call<Benchmarks>('/network/benchmarks', 'GET', undefined, 'officer'),
  simulateNetwork: () => call<{ added: number; ward: string; incidents: Incident[]; network: NetworkSummary }>('/network/simulate', 'POST', {}, 'officer'),
  otpRequest: (phone: string) => call<{ sent: boolean; simulated: boolean; demoCode?: string }>('/otp/request', 'POST', { phone }, 'none'),
  verify: async (phone: string, code: string) => {
    const r = await call<{ token: string; reporterId: string }>('/otp/verify', 'POST', { phone, code }, 'none');
    ctx.token = r.token; ctx.reporterId = r.reporterId;
    localStorage.setItem('bp_token', r.token); localStorage.setItem('bp_reporter', r.reporterId); localStorage.setItem('bp_phone', phone);
  },
  /** Signing out keeps this phone remembered, so "Continue as ..." needs no new code. `forgetSaved` really removes it. */
  logout: () => {
    if (ctx.token) localStorage.setItem('bp_saved', JSON.stringify({ token: ctx.token, reporterId: ctx.reporterId, phone: localStorage.getItem('bp_phone') ?? '' }));
    ctx.token = ''; ctx.reporterId = ''; localStorage.removeItem('bp_token'); localStorage.removeItem('bp_reporter');
  },
  saved: (): { phone: string } | null => { try { const s = JSON.parse(localStorage.getItem('bp_saved') ?? 'null') as { phone: string } | null; return s?.phone ? s : null; } catch { return null; } },
  continueSaved: async () => {
    const s = JSON.parse(localStorage.getItem('bp_saved') ?? 'null') as { token: string; reporterId: string } | null;
    if (!s) throw new Error('no saved login');
    ctx.token = s.token; ctx.reporterId = s.reporterId;
    try { await call('/complaints/mine'); } catch (e) { ctx.token = ''; ctx.reporterId = ''; localStorage.removeItem('bp_saved'); throw e; }
    localStorage.setItem('bp_token', s.token); localStorage.setItem('bp_reporter', s.reporterId);
  },
  forgetSaved: () => { localStorage.removeItem('bp_saved'); localStorage.removeItem('bp_phone'); },
  /** The level comes from the account on the server; the form only needs the ID. */
  officerLogin: async (id: string, password: string) => {
    const r = await call<{ token: string; officer: Officer }>('/officer/login', 'POST', { id, password }, 'none');
    ctx.officerToken = r.token; ctx.officer = r.officer;
    localStorage.setItem('bp_officer_token', r.token); localStorage.setItem('bp_officer', JSON.stringify(r.officer)); localStorage.setItem('bp_officer_last', JSON.stringify({ id, role: r.officer.role }));
  },
  officerLogout: () => { ctx.officerToken = ''; ctx.officer = null; localStorage.removeItem('bp_officer_token'); localStorage.removeItem('bp_officer'); },
  submit: (body: Record<string, unknown>) => call<{ complaint: { id: string; issueType: string }; incidentId: string | null; transcript?: string }>('/complaints', 'POST', { ...body, deviceId: ctx.deviceId }),
  transcribe: (audio: string, audioMime: string, who: 'citizen' | 'officer' = 'citizen') => call<Heard>('/voice/transcribe', 'POST', { audio, audioMime }, who),
  speak: (text: string, language: string, who: 'citizen' | 'officer' = 'citizen') => call<{ audio: string; mime: string }>('/voice/speak', 'POST', { text, language }, who),
  translate: (texts: string[], to: string, who: 'citizen' | 'officer' = 'citizen') => call<{ texts: string[] }>('/translate', 'POST', { texts, to }, who).then((r) => r.texts),
  languagePack: (lang: string, strings: Record<string, string>) => call<{ strings: Record<string, string>; translated: number; cached: boolean }>(`/i18n/${lang}`, 'POST', { strings }, 'none'),
  overview: () => call<Overview>('/graph/overview', 'GET', undefined, 'officer'),
  rings: () => call<{ rings: Ring[]; targets: { ring: string; incident: string }[]; engine: Engine; cypher: string[] }>('/graph/rings', 'GET', undefined, 'officer'),
  rootCause: () => call<RootCause>('/graph/root-cause', 'GET', undefined, 'officer'),
  assetImpact: (id: string) => call<AssetImpact>(`/assets/${encodeURIComponent(id)}/impact`, 'GET', undefined, 'officer'),
  ask: (question: string, language?: string) => call<Answer>('/ask', 'POST', { question, language }, 'officer'),
  voices: (id: string) => call<{ voices: Voice[] }>(`/incidents/${encodeURIComponent(id)}/voices`, 'GET', undefined, 'officer').then((r) => r.voices),
  mine: () => call<{ complaints: MyComplaint[] }>('/complaints/mine').then((r) => r.complaints),
  pending: () => call<{ reports: Report[] }>('/complaints/pending', 'GET', undefined, 'officer').then((r) => r.reports),
  incidents: (all = false) => call<{ incidents: Incident[] }>(`/incidents${all ? '?status=all' : ''}`, 'GET', undefined, 'none').then((r) => r.incidents),
  metoo: (id: string, lat: number, lng: number) => call<Incident>(`/incidents/${encodeURIComponent(id)}/metoo`, 'POST', { lat, lng }),
  actAsOfficer: (id: string, action: string, body: Record<string, unknown> = {}) => call<Incident>(`/incidents/${encodeURIComponent(id)}/actions/${action}`, 'POST', body, 'officer'),
  actAsCitizen: (id: string, action: string, body: Record<string, unknown> = {}) => call<Incident>(`/incidents/${encodeURIComponent(id)}/actions/${action}`, 'POST', body, 'citizen'),
  nearby: (lat: number, lng: number) => call<{ items: NearbyItem[] }>(`/nearby?lat=${lat}&lng=${lng}`, 'GET', undefined, 'citizen').then((r) => r.items),
  metooAny: (id: string, lat: number, lng: number) => call<{ incidentId: string | null }>(`/nearby/${encodeURIComponent(id)}/metoo`, 'POST', { lat, lng, deviceId: ctx.deviceId }),
  proofFor: (id: string, who: 'citizen' | 'officer') => call<{ photo: string; by: Role; at: number }>(`/incidents/${encodeURIComponent(id)}/proof`, 'GET', undefined, who),
  summary: (scope?: { lat: number; lng: number; km: number }) => call<PublicSummary>(`/public/summary${scope ? `?lat=${scope.lat}&lng=${scope.lng}&km=${scope.km}` : ''}`, 'GET', undefined, 'none'),
  searchPlace: (q: string) => call<{ places: { name: string; lat: number; lng: number }[] }>(`/public/search?q=${encodeURIComponent(q)}`, 'GET', undefined, 'none').then((r) => r.places),
  publicProof: (id: string) => call<{ photo: string }>(`/public/proof/${encodeURIComponent(id)}`, 'GET', undefined, 'none'),
  risk: () => call<{ zones: RiskZone[] }>('/risk/zones', 'GET', undefined, 'officer').then((r) => r.zones),
  checkin: (status: Checkin['status'], lat: number, lng: number) => call<Checkin>('/checkins', 'POST', { status, lat, lng }),
  myCheckins: () => call<{ checkins: Checkin[] }>('/checkins/mine').then((r) => r.checkins),
  supply: (scope?: { lat: number; lng: number; km: number }) => call<{ days: number; wards: SupplyWard[] }>(`/public/supply${scope ? `?lat=${scope.lat}&lng=${scope.lng}&km=${scope.km}` : ''}`, 'GET', undefined, 'none'),
  noticesNear: (lat: number, lng: number) => call<{ notices: Notice[] }>(`/notices/near?lat=${lat}&lng=${lng}`, 'GET', undefined, 'none').then((r) => r.notices),
  notices: () => call<{ notices: Notice[] }>('/notices', 'GET', undefined, 'officer').then((r) => r.notices),
  addNotice: (body: Record<string, unknown>) => call<Notice>('/notices', 'POST', body, 'officer'),
  removeNotice: (id: string) => call(`/notices/${encodeURIComponent(id)}`, 'DELETE', undefined, 'officer'),
  graph: (id: string) => call<Graph>(`/incidents/${encodeURIComponent(id)}/graph`, 'GET', undefined, 'officer'),
  downstream: (zone: string) => call<{ downstream: { zone: string; hops: number; localities: string[] }[] }>(`/zones/${zone}/downstream`, 'GET', undefined, 'none').then((r) => r.downstream),
  certificate: (id: string, reporterId: string) => call<{ valid: boolean; role?: string; what?: string }>(`/certificates/${encodeURIComponent(id)}/${reporterId}`, 'GET', undefined, 'none'),
  place: (lat: number, lng: number, category: 'WATER' | 'ROADS') => call<Place>(`/directory?lat=${lat}&lng=${lng}&category=${category}`, 'GET', undefined, 'none'),
  city: () => call<City>('/city', 'GET', undefined, 'none'),
  stats: () => call<{ open: number; byLevel: Record<Level, number>; needsVerification: number; slaAtRisk: number; avgHoursToResolve: number | null }>('/stats', 'GET', undefined, 'none'),
  rules: () => call<Rules>('/workflow', 'GET', undefined, 'none'),
  seed: () => call<{ complaints: number }>('/admin/seed', 'POST', {}, 'none'),
  reset: () => call('/admin/reset', 'POST', {}, 'none'),
  scenario: (kind: string, n: number, locality?: string) => call('/admin/scenario', 'POST', { kind, n, locality }, 'none'),
  replay: (minute: number) => call<{ minute: number; reports: number; incident: null | { score: number; level: Level; independentSources: number; needsVerification: boolean } }>(`/admin/replay?minute=${minute}`, 'GET', undefined, 'none'),
};
