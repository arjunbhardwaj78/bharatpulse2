import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Complaint } from '@bharatpulse/engine';
import { haversineMeters } from '@bharatpulse/engine';
import type { Auth } from './auth.js';
import { Q } from './cypher.js';
import { SERVICE_RADIUS_KM, directoryFor } from './data.js';
import { AppError } from './errors.js';
import { nearFacility, nearestLocality, normalizeProof, readPhoto, understand } from './intake.js';
import type { Officers } from './officers.js';
import type { PlaceFinder } from './places.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import { LANGUAGES, type Sarvam } from './sarvam.js';
import { replayOutage, SCENARIOS, rng, travellingCrowd } from './scenarios.js';
import { orgType, ORG_TYPES } from './orgs.js';
import { IncidentService } from './service.js';
import { PLANS, publicTenant, TenantHub } from './tenants.js';
import type { PlaceSuggest } from './places.js';
import type { Role, StoredIncident } from './types.js';
import { RULES } from './workflow.js';

/** The JSON an officer's dashboard sees: the engine's incident plus lifecycle fields. */
function present(s: StoredIncident, repeat?: { count: number; lastFixedAt: number }) {
  return {
    repeat,
    ...s.incident,
    status: s.status,
    detectedAt: s.detectedAt,
    updatedAt: s.updatedAt,
    resolvedAt: s.resolvedAt,
    resolution: s.resolution,
    mergedInto: s.mergedInto,
    hasProof: !!s.proof,
    workflow: s.workflow,
    possibleCause: s.possibleCause,
  };
}

export interface AppDeps {
  auth?: Auth;
  /** Without a verified session, only the old reporterId body field is accepted when this is false (tests, simulator). */
  requireOtp?: boolean;
  /** Sarvam AI client (voice, translation, read-aloud, Ask). Without it the app still works in English and Hindi. */
  sarvam?: Sarvam;
  /** If set, /admin routes need this in the x-admin-key header. */
  adminKey?: string;
  /** When set, officer actions need a signed-in officer (x-officer token) and the x-role header is ignored. */
  officers?: Officers;
  /** The phone must report its own location, and the pin must be within 3 km of it. */
  geofence?: boolean;
  /** Finds real offices, addresses and phone numbers near a point (Google or OpenStreetMap). */
  places?: PlaceFinder;
  /** Turns a place name into coordinates, for "change area" on the public page. */
  search?: (q: string) => Promise<{ name: string; lat: number; lng: number }[]>;
  /** Requests per minute per IP across the API (default 300). Tighter limits apply to sign-in and AI routes. */
  rateLimitPerMinute?: number;
  /** Place names as you type (OpenStreetMap Photon). */
  suggest?: PlaceSuggest;
}

const ROLES = ['L1', 'L2', 'L3', 'L4', 'CITIZEN'];
/** How far the pin may be from the phone's own location. A neighbourhood, not a city. */
export const PIN_LIMIT_M = 3000;
const MB = 1024 * 1024;

/**
 * Builds the HTTP app around a service. Nothing is listening yet, so tests can
 * call `app.inject(...)` against the real routes without opening a port.
 */
export function buildApp(target: IncidentService | TenantHub, options: FastifyServerOptions = {}, deps: AppDeps = {}): FastifyInstance {
  const hub = target instanceof TenantHub ? target : TenantHub.single(target);
  // trustProxy: on Render/Vercel every request arrives through a proxy; without this, every user has the proxy's IP
  // and the "same network" trust signal would fire for everyone.
  const app = Fastify({ bodyLimit: 1 * MB, trustProxy: true, ...options });

  // Security headers. The API only serves JSON, so the strictest defaults are fine; the web app lives on another origin.
  void app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  void app.register(rateLimit, {
    global: true,
    max: deps.rateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: 'rate_limited', message: `Too many requests, try again in ${Math.ceil(ctx.ttl / 1000)} s` } }),
  });
  const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  // CORS: CORS_ORIGIN is "*" or a comma-separated list of allowed web origins.
  const allowed = (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (allowed.includes('*')) reply.header('access-control-allow-origin', '*');
    else if (origin && allowed.includes(origin)) { reply.header('access-control-allow-origin', origin); reply.header('vary', 'origin'); }
    reply.header('access-control-allow-headers', 'content-type,x-session,x-role,x-admin-key,x-officer,x-tenant,x-api-key');
    reply.header('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
    reply.header('access-control-max-age', '600');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const header = (r: { headers: Record<string, unknown> }, name: string): string | undefined => str(r.headers[name]);
  const needAuth = (): Auth => {
    if (!deps.auth) throw new AppError(501, 'otp_disabled', 'Phone verification is not configured');
    return deps.auth;
  };
  const reporter = (r: { headers: Record<string, unknown> }): string => needAuth().session(header(r, 'x-session'));
  /** Which city this request is for: the x-tenant header (web app), else the demo city. */
  const cityOf = (r: { headers: Record<string, unknown> }): string => {
    const id = header(r, 'x-tenant') ?? hub.defaultId;
    if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new AppError(400, 'validation_error', 'x-tenant must be a city id');
    hub.tenant(id);
    return id;
  };
  const S = (r: { headers: Record<string, unknown> }) => hub.service(cityOf(r));
  /** The officer role of this request. With officer login on, only a signed-in officer counts; otherwise the legacy x-role header (tests, simulators). */
  const officerRole = (r: { headers: Record<string, unknown> }): Role | undefined => {
    if (deps.officers) {
      if (!header(r, 'x-officer')) return undefined;
      const o = deps.officers.who(header(r, 'x-officer'));
      if (o.city !== cityOf(r)) throw new AppError(401, 'wrong_city', 'This sign-in belongs to another city');
      return o.role;
    }
    const h = header(r, 'x-role') as Role | undefined;
    return h && h !== 'CITIZEN' ? h : undefined;
  };
  const needOfficer = (r: { headers: Record<string, unknown> }): Role => {
    const role = officerRole(r);
    if (!role) throw new AppError(401, 'not_signed_in', 'Sign in as an officer first');
    return role;
  };
  /** A signed-in officer or a verified citizen (voice, translation and read-aloud cost money, so not anonymous). */
  const someone = (r: { headers: Record<string, unknown> }): void => { if (!officerRole(r)) reporter(r); };
  const admin = (r: { headers: Record<string, unknown> }): void => {
    if (!deps.adminKey && process.env.NODE_ENV === 'production') throw new AppError(403, 'admin_disabled', 'Set ADMIN_KEY to use admin routes');
    if (deps.adminKey && header(r, 'x-admin-key') !== deps.adminKey) throw new AppError(401, 'admin_only', 'Admin key required');
  };
  const needSarvam = (): Sarvam => {
    if (!deps.sarvam) throw new AppError(503, 'sarvam_unavailable', 'Sarvam is not configured on this server');
    return deps.sarvam;
  };
  /** One network may verify only a few different phones per hour: stops one person from becoming many "neighbours". */
  const phonesPerNetwork = new SlidingWindowLimiter(8, 3_600_000);

  // Usage meter per city (shown in the admin console against the plan's limits).
  const METER: [RegExp, string][] = [[/^\/complaints$/, 'reports'], [/^\/(voice|translate|ask)/, 'sarvamCalls'], [/^\/(graph|incidents\/[^/]+\/graph|zones)/, 'graphQueries'], [/^\/ask$/, 'asks']];
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'OPTIONS' || reply.statusCode >= 400) return;
    const path = request.url.split('?')[0];
    const hits = METER.filter(([re]) => re.test(path));
    if (!hits.length) return;
    let id: string;
    try { id = cityOf(request); } catch { return; }
    for (const [, key] of hits) hub.meter(id, key);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.headers) reply.headers(error.headers);
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    // Fastify's own client errors (bad JSON, body too large, rate limit) carry a 4xx statusCode and a safe message.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'bad_request';
      const given = (error as { error?: { message?: string } }).error?.message;
      return reply.code(status).send({ error: { code, message: given ?? (error as Error).message } });
    }
    request.log.error(error);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: `Route ${request.method} ${request.url.split('?')[0]} not found` } });
  });

  // Routes live in a child plugin so the security plugins above (helmet, rate limit) are ready before any route exists.
  void app.register(async (api) => {
    api.get('/health', async () => ({
      status: 'ok',
      voice: !!deps.sarvam,
      graph: (await hub.service(hub.defaultId)).storeKind,
      sarvam: deps.sarvam ? { enabled: true, models: deps.sarvam.models, calls: deps.sarvam.calls } : { enabled: false },
      languages: deps.sarvam ? LANGUAGES : { 'en-IN': LANGUAGES['en-IN'], 'hi-IN': LANGUAGES['hi-IN'] },
      officerLogin: !!deps.officers,
      geofence: !!deps.geofence,
      admin: deps.adminKey ? 'key' : process.env.NODE_ENV === 'production' ? 'off' : 'open',
    }));

    // ---- sign-in ----------------------------------------------------------------------------------------------------
    api.post('/otp/request', strict(10), async (request) => {
      const phone = ((request.body ?? {}) as Record<string, unknown>).phone;
      if (typeof phone === 'string' && phonesPerNetwork.tryConsume(`net:${needAuth().ipHash(request.ip)}`, Date.now()) > 0) throw new AppError(429, 'rate_limited', 'Too many phones from this network. Try again in an hour.');
      return needAuth().request(phone);
    });
    api.post('/otp/verify', strict(10), async (request) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      return needAuth().verify(b.phone, b.code);
    });
    api.post('/officer/login', strict(10), async (request) => {
      if (!deps.officers) throw new AppError(501, 'officer_login_disabled', 'Officer login is not configured');
      const b = (request.body ?? {}) as Record<string, unknown>;
      const city = cityOf(request);
      const res = deps.officers.login(b.id, b.role, b.password, { id: city, check: hub.passwordCheck(city) });
      const org = orgType(hub.tenant(city).orgType); // private operators see their own job titles
      return { ...res, officer: { ...res.officer, name: org.titles[res.officer.role as 'L1'], office: org.office } };
    });

    // ---- Sarvam: voice, translation, read-aloud, app languages -------------------------------------------------------
    api.post('/voice/transcribe', { bodyLimit: 8 * MB, ...strict(20) }, async (request) => {
      someone(request);
      const sarvam = needSarvam();
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (typeof b.audio !== 'string') throw new AppError(400, 'validation_error', 'audio (base64) is required');
      const heard = await sarvam.transcribe(Buffer.from(b.audio, 'base64'), str(b.audioMime) ?? 'audio/webm');
      const u = await understand(heard.text, sarvam, heard.language);
      return { text: u.text, textEn: u.textEn, language: u.language, issueType: u.issueType, engine: 'sarvam' };
    });
    api.post('/voice/speak', strict(30), async (request) => {
      someone(request);
      const b = (request.body ?? {}) as Record<string, unknown>;
      const text = str(b.text)?.trim();
      if (!text || text.length > 1200) throw new AppError(400, 'validation_error', 'text must be 1 to 1200 characters');
      return needSarvam().speak(text, str(b.language) ?? 'hi-IN');
    });
    api.post('/translate', strict(30), async (request) => {
      someone(request);
      const b = (request.body ?? {}) as Record<string, unknown>;
      const texts = Array.isArray(b.texts) ? b.texts.filter((t): t is string => typeof t === 'string').slice(0, 20) : [];
      const to = str(b.to) ?? '';
      if (!LANGUAGES[to]) throw new AppError(400, 'validation_error', `to must be one of ${Object.keys(LANGUAGES).join(', ')}`);
      if (texts.some((t) => t.length > 600)) throw new AppError(400, 'validation_error', 'each text must be at most 600 characters');
      const sarvam = needSarvam();
      return { to, texts: await Promise.all(texts.map(async (t) => { const en = await sarvam.toEnglish(t); return to === en.language ? t : sarvam.translate(t, en.language, to); })) };
    });
    api.post<{ Params: { lang: string } }>('/i18n/:lang', { bodyLimit: 256 * 1024, ...strict(6) }, async (request) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      const strings = b.strings && typeof b.strings === 'object' ? Object.fromEntries(Object.entries(b.strings as Record<string, unknown>).filter(([k, v]) => /^\w{1,40}$/.test(k) && typeof v === 'string' && v.length <= 400).slice(0, 600)) as Record<string, string> : {};
      if (Object.keys(strings).length === 0) throw new AppError(400, 'validation_error', 'strings is required');
      return (await S(request)).languagePack(request.params.lang, strings);
    });

    // ---- complaints ---------------------------------------------------------------------------------------------------
    api.post('/complaints', { bodyLimit: 8 * MB }, async (request, reply) => {
      const body = { ...((request.body ?? {}) as Record<string, unknown>) };
      const token = header(request, 'x-session');
      const extra: Partial<Complaint> = {};
      if (token || deps.requireOtp) {
        const id = reporter(request);
        body.reporterId = id;
        Object.assign(extra, await (await S(request)).trustFacts(id));
        extra.ipHash = needAuth().ipHash(request.ip);
      }

      let text = str(body.text);
      let spoken: string | undefined;
      if (typeof body.audio === 'string') {
        const heard = await needSarvam().transcribe(Buffer.from(body.audio, 'base64'), str(body.audioMime) ?? 'audio/webm');
        text = heard.text;
        spoken = heard.language;
      }
      if (text) {
        const u = await understand(text, deps.sarvam, spoken ?? str(body.language));
        body.text = u.text;
        if (u.textEn) extra.textEn = u.textEn;
        if (u.language) extra.language = u.language;
        if (body.issueType === undefined && u.issueType) body.issueType = u.issueType;
      }
      if (body.issueType === undefined) body.issueType = body.category === 'ROAD' ? 'OTHER_ROAD' : body.category === 'WATER' ? 'OTHER_WATER' : undefined;
      delete body.audio; delete body.language;
      if (typeof body.address === 'string') {
        if (body.address.length > 120) throw new AppError(400, 'validation_error', 'address must be at most 120 characters');
        extra.address = body.address.trim() || undefined;
      }
      if (deps.geofence && typeof body.lat === 'number' && typeof body.lng === 'number') {
        if (typeof body.deviceLat !== 'number' || typeof body.deviceLng !== 'number') throw new AppError(403, 'location_required', 'Allow location access so we can confirm you are at the place');
        if (haversineMeters({ lat: body.lat, lng: body.lng }, { lat: body.deviceLat, lng: body.deviceLng }) > PIN_LIMIT_M) throw new AppError(403, 'too_far_from_you', 'The pin must be within 3 km of where you are');
      }

      if (Array.isArray(body.photos)) {
        if (body.photos.length > 2 || body.photos.some((x) => typeof x !== 'string')) throw new AppError(400, 'validation_error', 'photos must be at most 2 base64 strings');
        const facts = await Promise.all((body.photos as string[]).map(readPhoto));
        extra.photoHashes = facts.map((f) => f.hash);
        extra.exifTime = facts.find((f) => f.exifTime !== undefined)?.exifTime;
      }
      if (typeof body.lat === 'number' && typeof body.lng === 'number') {
        extra.localityId = nearestLocality(body.lat, body.lng, (await S(request)).city);
        if (['POTHOLE', 'CAVE_IN', 'WATERLOGGING'].includes(str(body.issueType) ?? '')) extra.nearFacility = nearFacility(body.lat, body.lng, (await S(request)).city);
      }
      const { complaint, incidentId } = await (await S(request)).submitComplaint(body, extra);
      return reply.code(201).send({ complaint: { ...complaint, deviceId: undefined, ipHash: undefined, reporterAgeMs: undefined, reporterHistory: undefined }, incidentId, transcript: text, textEn: extra.textEn, language: extra.language });
    });

    api.get<{ Querystring: { status?: string } }>('/incidents', async (request) => {
      const active = request.query.status === 'all' ? await (await S(request)).listAll() : await (await S(request)).listActive();
      const rep = await (await S(request)).repeatMap();
      return { count: active.length, incidents: active.map((s) => present(s, rep.get(s.incident.id))) };
    });

    api.get<{ Params: { id: string } }>('/incidents/:id', async (request) => present(await (await S(request)).getIncident(request.params.id)));

    // Workflow steps. (The old /resolve and /escalate shortcuts are gone: they let anyone close an incident.)
    api.post<{ Params: { id: string; action: string } }>('/incidents/:id/actions/:action', { bodyLimit: 8 * MB }, async (request) => {
      // With officer login on, the role comes from the signed-in officer. The x-role header is only honoured when it is off (tests, simulators).
      const role = officerRole(request) ?? 'CITIZEN';
      if (!ROLES.includes(role)) throw new AppError(400, 'validation_error', `role must be one of ${ROLES.join(', ')}`);
      const b = (request.body ?? {}) as Record<string, unknown>;
      let proofHash = str(b.proofHash);
      let photo: string | undefined;
      if (request.params.action === 'resolve' && typeof b.proofPhoto === 'string') ({ photo, hash: proofHash } = await normalizeProof(b.proofPhoto));
      const result = await (await S(request)).act(request.params.id, { action: request.params.action, role, note: str(b.note), reason: str(b.reason), proofHash, decision: str(b.decision) }, role === 'CITIZEN' ? reporter(request) : undefined, photo);
      return present(result);
    });

    const trustExtra = (r: { headers: Record<string, unknown>; ip: string }, b: Record<string, unknown>): Partial<Complaint> => ({ deviceId: str(b.deviceId)?.slice(0, 64), ipHash: needAuth().ipHash(r.ip) });

    api.get<{ Querystring: { lat?: string; lng?: string } }>('/nearby', async (request) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      if (request.query.lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new AppError(400, 'validation_error', 'lat and lng are required');
      let me: string | undefined;
      try { me = deps.auth?.session(header(request, 'x-session')); } catch { /* not signed in: the list is the same, just without "already reported" marks */ }
      return { items: await (await S(request)).nearby(lat, lng, undefined, me) };
    });

    api.post<{ Params: { id: string } }>('/nearby/:id/metoo', async (request) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') throw new AppError(400, 'validation_error', 'lat and lng are required');
      return (await S(request)).metooAny(reporter(request), request.params.id, b.lat, b.lng, trustExtra(request, b));
    });

    api.get<{ Params: { id: string } }>('/public/item/:id', async (request) => {
      const item = await (await S(request)).publicItem(request.params.id);
      if (!item) throw new AppError(404, 'not_found', 'This report is no longer open');
      return item;
    });
    api.post('/checkins', async (request, reply) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (b.status !== 'CAME' && b.status !== 'LATE' && b.status !== 'NONE') throw new AppError(400, 'validation_error', 'status must be CAME, LATE or NONE');
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') throw new AppError(400, 'validation_error', 'lat and lng are required');
      return reply.code(201).send(await (await S(request)).checkin(reporter(request), b.status, b.lat, b.lng));
    });
    api.get('/checkins/mine', async (request) => ({ checkins: await (await S(request)).myCheckins(reporter(request), 7) }));
    api.get<{ Querystring: { lat?: string; lng?: string; km?: string } }>('/public/supply', async (request) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      return (await S(request)).supply(request.query.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, km: Math.min(50, Math.max(1, Number(request.query.km) || 10)) } : undefined);
    });

    const noticeRole = (r: { headers: Record<string, unknown> }): Role => {
      const role = needOfficer(r);
      if (role !== 'L2' && role !== 'L3') throw new AppError(403, 'forbidden', 'Only zonal officers and department heads can announce planned work');
      return role;
    };
    api.get<{ Querystring: { lat?: string; lng?: string } }>('/notices/near', async (request) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      if (request.query.lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new AppError(400, 'validation_error', 'lat and lng are required');
      return { notices: await (await S(request)).noticesNear(lat, lng) };
    });
    api.get('/notices', async (request) => { needOfficer(request); return { notices: await (await S(request)).allNotices() }; });
    api.post('/notices', async (request, reply) => reply.code(201).send(await (await S(request)).addNotice((request.body ?? {}) as Record<string, unknown>, noticeRole(request))));
    api.delete<{ Params: { id: string } }>('/notices/:id', async (request) => { noticeRole(request); await (await S(request)).removeNotice(request.params.id); return { removed: true }; });

    api.get<{ Querystring: { lat?: string; lng?: string; km?: string } }>('/public/summary', async (request) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      const km = Math.min(50, Math.max(1, Number(request.query.km) || 10));
      return (await S(request)).publicSummary(request.query.lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, km } : undefined);
    });
    api.get<{ Querystring: { q?: string } }>('/public/search', async (request) => ({ places: deps.search ? await deps.search(String(request.query.q ?? '').slice(0, 100)).catch(() => []) : [] }));
    api.get<{ Params: { id: string } }>('/public/proof/:id', async (request) => {
      const s = await (await S(request)).proofOf(request.params.id);
      if (!s?.proof?.photo || !['CONFIRMED', 'CLOSED'].includes(s.workflow?.stage ?? '') || s.workflow?.rejection) throw new AppError(404, 'not_found', 'No public photo for this');
      return { photo: s.proof.photo, at: s.proof.at };
    });
    api.get<{ Params: { id: string } }>('/incidents/:id/proof', async (request) => {
      if (!officerRole(request)) reporter(request); // an officer, or a verified citizen
      const s = await (await S(request)).proofOf(request.params.id);
      if (!s?.proof?.photo) throw new AppError(404, 'not_found', 'No fix photo uploaded yet');
      return { photo: s.proof.photo, hash: s.proof.hash, by: s.proof.by, at: s.proof.at };
    });
    api.get('/risk/zones', async (request) => { needOfficer(request); return { zones: await (await S(request)).riskZones() }; });

    api.post<{ Params: { id: string } }>('/incidents/:id/metoo', async (request) => {
      const b = (request.body ?? {}) as Record<string, unknown>;
      if (typeof b.lat !== 'number' || typeof b.lng !== 'number') throw new AppError(400, 'validation_error', 'lat and lng are required');
      return present(await (await S(request)).metoo(reporter(request), request.params.id, b.lat, b.lng, trustExtra(request, b)));
    });

    // ---- the graph (Neo4j). Officers only: these show who reported what. --------------------------------------------
    const engine = async (request: { headers: Record<string, unknown> }) => (await S(request)).storeKind;
    api.get<{ Params: { id: string } }>('/incidents/:id/graph', async (request) => { needOfficer(request); return { ...(await (await S(request)).subgraph(request.params.id)), engine: await engine(request), cypher: [Q.incidentGraph, Q.sharedDevices] }; });
    api.get<{ Params: { id: string } }>('/incidents/:id/voices', async (request) => { needOfficer(request); return { voices: await (await S(request)).voices(request.params.id) }; });
    api.get<{ Params: { id: string }; Querystring: { hops?: string } }>('/zones/:id/downstream', async (request) => ({ zone: request.params.id, downstream: await (await S(request)).downstream(request.params.id, Math.min(3, Number(request.query.hops) || 3)), engine: await engine(request), cypher: [Q.downstream] }));
    api.get('/graph/overview', async (request) => { needOfficer(request); return { ...(await (await S(request)).overview()), engine: await engine(request) }; });
    api.get('/graph/rings', async (request) => { needOfficer(request); return { ...(await (await S(request)).rings()), engine: await engine(request), cypher: [Q.deviceAndPhotoLinks, Q.coReportingLinks, Q.ringTargets] }; });
    api.get<{ Params: { id: string } }>('/assets/:id/impact', async (request) => { needOfficer(request); return { ...(await (await S(request)).impact(request.params.id)), engine: await engine(request), cypher: [Q.atRisk] }; });
    api.get('/graph/root-cause', async (request) => { needOfficer(request); return { ...(await (await S(request)).rootCause()), engine: await engine(request), cypher: [Q.rootCause, Q.atRisk] }; });
    api.post('/ask', strict(20), async (request) => {
      needOfficer(request);
      const b = (request.body ?? {}) as Record<string, unknown>;
      const q = str(b.question)?.trim();
      if (!q || q.length > 500) throw new AppError(400, 'validation_error', 'question must be 1 to 500 characters');
      const lang = str(b.language);
      return { ...(await (await S(request)).ask(q, lang && LANGUAGES[lang] ? lang : undefined)), engine: await engine(request) };
    });

    api.get<{ Params: { id: string; reporterId: string } }>('/certificates/:id/:reporterId', async (request) => (await S(request)).certificate(request.params.id, request.params.reporterId));
    api.get('/workflow', async () => RULES);
    api.get<{ Querystring: { lat?: string; lng?: string; category?: string } }>('/directory', async (request) => {
      const lat = Number(request.query.lat);
      const lng = Number(request.query.lng);
      if (request.query.lat === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) return (await S(request)).directory();
      const category = request.query.category === 'ROADS' ? 'ROADS' : 'WATER';
      const nearby = deps.places ? await deps.places(lat, lng, category).catch(() => ({ offices: [] })) : { offices: [] };
      return { ...directoryFor((await S(request)).city, lat, lng, category), nearby };
    });
    api.get('/complaints/pending', async (request) => { needOfficer(request); return { reports: await (await S(request)).pending() }; });
    api.get('/complaints/mine', async (request) => {
      const svc = await S(request);
      const mine = await svc.mine(reporter(request));
      return { complaints: mine.map((c) => ({ ...c, office: directoryFor(svc.city, c.lat, c.lng, ['POTHOLE', 'CAVE_IN', 'WATERLOGGING', 'OTHER_ROAD'].includes(c.issueType) ? 'ROADS' : 'WATER').office })) };
    });
    api.get('/city', async (request) => { const id = cityOf(request); const t = hub.tenant(id); return { ...t.city, id, name: t.name, state: t.state, service: { center: t.center, radiusKm: SERVICE_RADIUS_KM } }; });
    api.get('/stats', async (request) => (await S(request)).stats());

    // ---- the platform (SaaS): cities, plans, onboarding -------------------------------------------------------------
    api.get('/cities', async () => ({ cities: hub.list().map(publicTenant) }));
    api.get<{ Params: { id: string } }>('/cities/:id', async (request) => publicTenant(hub.tenant(request.params.id)));
    api.get('/plans', async () => ({ plans: PLANS }));
    api.get('/orgs/types', async () => ({ types: ORG_TYPES }));
    // Self-serve onboarding: a city gets its own map, officers and password in a minute. Few per network per hour.
    api.post('/cities', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => reply.code(201).send(await hub.create((request.body ?? {}) as Record<string, unknown>)));
    api.get<{ Querystring: { q?: string } }>('/places/suggest', strict(60), async (request) => ({ places: deps.suggest ? await deps.suggest(String(request.query.q ?? '')).catch(() => []) : [] }));

    // ---- admin console: the city's own head of department / commissioner ---------------------------------------
    const cityAdmin = (r: { headers: Record<string, unknown> }): string => {
      const role = needOfficer(r);
      if (role !== 'L3' && role !== 'L4') throw new AppError(403, 'forbidden', 'Only the department head or commissioner can manage the city account');
      return cityOf(r);
    };
    // ---- referrals between workspaces: a private site fed by a city network -------------------------------------
    api.get('/referrals', async (request) => { needOfficer(request); return hub.referrals(cityOf(request)); });
    api.post<{ Params: { id: string } }>('/referrals/:id/ack', async (request) => { const role = needOfficer(request); if (role === 'L1') throw new AppError(403, 'forbidden', 'A zonal officer or above acknowledges referrals'); return hub.acknowledge(cityOf(request), request.params.id); });

    // ---- the network: what only a shared platform can see -------------------------------------------------------
    // Public totals (no account ids, no complaint data): crowds caught in one city and held on first report in another.
    api.get('/network', strict(60), async () => hub.networkSummary());
    // Your city against the others (others anonymised). Any signed-in officer.
    api.get('/network/benchmarks', async (request) => { needOfficer(request); return hub.benchmarks(cityOf(request)); });
    // Demo: the 10 accounts that faked outages in the demo town arrive here. This city has no local evidence against
    // them (one incident, nowhere else yet), so only the shared watchlist can hold them on the first report.
    api.post('/network/simulate', { config: { rateLimit: { max: 6, timeWindow: '1 hour' } } }, async (request, reply) => {
      const id = cityAdmin(request);
      if (id === hub.defaultId) throw new AppError(400, 'validation_error', 'Run this in a second city: the crowd was first caught in the demo city');
      await hub.warmNetwork();
      const svc = await hub.service(id);
      const where = svc.city.localities[Math.min(1, svc.city.localities.length - 1)];
      const now = Date.now();
      const created = await svc.ingestDemo(travellingCrowd({ n: 10, at: where, now, r: rng(now % 100000), prefix: `net-${now.toString(36)}-`, crowd: 'crowd' }));
      return reply.code(201).send({ added: 10, ward: where.name, incidents: created.map((x) => present(x)), network: await hub.networkSummary() });
    });

    api.get('/admin/console', async (request) => {
      const id = cityAdmin(request);
      const t = hub.tenant(id);
      const svc = await hub.service(id);
      const stats = await svc.stats();
      return {
        city: publicTenant(t), usage: hub.usage(id), plans: PLANS, stats, graph: svc.storeKind,
        apiKeys: t.apiKeys.map(({ hash: _h, ...k }) => k),
        webhooks: t.webhooks.map(({ secret, ...w }) => ({ ...w, secretHint: `${secret.slice(0, 10)}…` })),
        map: { zones: t.city.zones.length, wards: t.city.localities.length, assets: t.city.assets.length },
        officers: ['field1', 'zonal1', 'head1', 'commissioner1'],
      };
    });
    api.post('/admin/plan', async (request) => { const id = cityAdmin(request); return publicTenant(hub.setPlan(id, ((request.body ?? {}) as Record<string, unknown>).plan)); });
    api.post('/admin/keys', async (request, reply) => { const id = cityAdmin(request); return reply.code(201).send(hub.createKey(id, ((request.body ?? {}) as Record<string, unknown>).label)); });
    api.delete<{ Params: { key: string } }>('/admin/keys/:key', async (request) => { hub.revokeKey(cityAdmin(request), request.params.key); return { revoked: true }; });
    api.post('/admin/webhooks', async (request, reply) => { const id = cityAdmin(request); return reply.code(201).send(hub.addWebhook(id, ((request.body ?? {}) as Record<string, unknown>).url)); });
    api.delete<{ Params: { hook: string } }>('/admin/webhooks/:hook', async (request) => { hub.removeWebhook(cityAdmin(request), request.params.hook); return { removed: true }; });
    api.post<{ Params: { hook: string } }>('/admin/webhooks/:hook/test', async (request) => {
      const id = cityAdmin(request);
      return { results: await hub.fire(id, 'test', { message: 'Hello from BharatPulse' }, request.params.hook) };
    });
    /** CSV/JSON import from the console (same path as the API, signed in instead of a key). */
    api.post('/admin/import', { bodyLimit: 2 * MB }, async (request) => {
      const id = cityAdmin(request);
      const b = (request.body ?? {}) as Record<string, unknown>;
      const out = await (await hub.service(id)).ingest(b.complaints, b.source ?? 'csv-upload');
      hub.meter(id, 'imported', out.accepted);
      return out;
    });

    // ---- public API for existing portals (plug-in mode): x-api-key --------------------------------------------------
    api.post('/v1/complaints', { bodyLimit: 2 * MB, ...strict(60) }, async (request) => {
      const id = hub.cityForKey(header(request, 'x-api-key'));
      const b = (request.body ?? {}) as Record<string, unknown>;
      const out = await (await hub.service(id)).ingest(b.complaints, b.source);
      hub.meter(id, 'imported', out.accepted);
      return { city: id, ...out };
    });
    api.get('/v1/incidents', strict(120), async (request) => {
      const id = hub.cityForKey(header(request, 'x-api-key'));
      const t = hub.tenant(id);
      const { incidentEvent } = await import('./tenants.js');
      return { city: id, incidents: (await (await hub.service(id)).listActive()).map((s) => incidentEvent(s, t)) };
    });

    // ---- demo data (admin key) ------------------------------------------------------------------------------------------
    api.post('/admin/scenario', async (request, reply) => {
      admin(request);
      const b = (request.body ?? {}) as Record<string, unknown>;
      const make = SCENARIOS[String(b.kind)];
      if (!make) throw new AppError(400, 'validation_error', `kind must be one of ${Object.keys(SCENARIOS).join(', ')}`);
      const city = (await S(request)).city;
      const where = city.localities.find((l) => l.id === b.locality) ?? city.localities[0];
      const tag = `${String(b.kind)}-${Date.now().toString(36)}-`;
      const n = Math.min(200, Math.max(1, Number(b.n) || 30));
      const created = await (await S(request)).ingestDemo(make({ n, at: where, now: Date.now(), r: rng(Date.now() % 100000), prefix: tag }));
      return reply.code(201).send({ added: n, incidents: created.map((x) => present(x)) });
    });

    api.post('/admin/seed', async (request, reply) => { admin(request); return reply.code(201).send({ complaints: await (await S(request)).loadSample({ replace: hub.tenant(cityOf(request)).kind === 'demo' }) }); });
    api.post('/admin/seed-partners', async (request, reply) => { admin(request); return reply.code(201).send(await hub.ensurePartners()); });
    api.post('/admin/reset', async (request) => { admin(request); await (await S(request)).clear(); return { cleared: true }; });
    api.get<{ Querystring: { minute?: string } }>('/admin/replay', async (request) => { admin(request); return replayOutage(Math.min(120, Math.max(0, Number(request.query.minute) || 0))); });
  });

  return app;
}
