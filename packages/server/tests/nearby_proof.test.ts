import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { IncidentService } from '../src/service.js';
import { BASE, FakeClock, counterIds } from './helpers.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());
const start = () => {
  const clock = new FakeClock();
  const auth = new Auth('salt', '123456', clock.now);
  const service = new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds(), auth });
  app = buildApp(service, {}, { auth, officers: new Officers('pw'), requireOtp: true });
  return { clock, service };
};
const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const citizen = async (n: number) => (await call('POST', '/otp/verify', { phone: `90000000${10 + n}`, code: '123456' })).json().token as string;
const officer = async (id: string, role: string) => (await call('POST', '/officer/login', { id, role, password: 'pw' })).json().token as string;
const here = { lat: BASE.lat, lng: BASE.lng };
const file = (token: string, extra: object = {}) => call('POST', '/complaints', { issueType: 'NO_WATER', ...here, deviceId: `d${Math.random()}`, ...extra }, { 'x-session': token });

describe('three neighbours at one place', () => {
  it('shows the first report to the next neighbour, who can confirm it, and the third report forms the incident', async () => {
    start();
    const [a, b, c] = [await citizen(1), await citizen(2), await citizen(3)];
    expect((await file(a)).statusCode).toBe(201);
    const seen = (await call('GET', `/nearby?lat=${here.lat}&lng=${here.lng}`)).json().items;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'report', reports: 1, people: 1, issueType: 'NO_WATER' });
    expect(seen[0].reporterId).toBeUndefined(); // nothing personal is shown

    const tap = (token: string, id: string) => call('POST', `/nearby/${id}/metoo`, { ...here, deviceId: 'x' }, { 'x-session': token });
    expect((await tap(a, seen[0].id)).json().error.code).toBe('own_report');
    expect((await tap(b, seen[0].id)).json()).toEqual({ incidentId: null }); // 2 reports: still not an incident
    expect((await tap(b, seen[0].id)).json().error.code).toBe('already_confirmed');
    const formed = (await tap(c, seen[0].id)).json();
    expect(formed.incidentId).toBeTruthy(); // the third report makes it an incident

    const after = (await call('GET', `/nearby?lat=${here.lat}&lng=${here.lng}`)).json().items;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: 'incident', reports: 3, id: formed.incidentId });
    expect((await call('POST', `/nearby/${after[0].id}/metoo`, { ...here }, { 'x-session': await citizen(4) })).statusCode).toBe(200);
  });

  it('gives a shared link enough to show the problem, without exact positions or people', async () => {
    start();
    const id = (await file(await citizen(1))).json().complaint.id;
    const item = (await call('GET', `/public/item/${id}`)).json();
    expect(item).toMatchObject({ kind: 'report', issueType: 'NO_WATER', reports: 1 });
    expect(String(item.lat).split('.')[1].length).toBeLessThanOrEqual(3);
    expect((await call('GET', '/public/item/nope')).statusCode).toBe(404);
  });

  it('refuses confirmations from far away and unknown reports', async () => {
    start();
    const a = await citizen(1);
    const id = (await file(a)).json().complaint.id;
    expect((await call('POST', `/nearby/${id}/metoo`, { lat: here.lat + 0.05, lng: here.lng }, { 'x-session': await citizen(2) })).json().error.code).toBe('too_far');
    expect((await call('POST', '/nearby/nope/metoo', { ...here }, { 'x-session': await citizen(2) })).statusCode).toBe(404);
    expect((await call('GET', '/nearby')).statusCode).toBe(400);
  });

  it('counts three accounts on one phone as one person, so the incident is not trusted', async () => {
    const { service } = start();
    for (let i = 1; i <= 3; i++) await file(await citizen(i), { deviceId: 'same-browser' });
    const [inc] = await service.listAll();
    expect([inc.incident.complaintCount, inc.incident.trust.independentSources, inc.incident.trust.needsVerification]).toEqual([3, 1, true]);
  });
});

describe('wider ranges and "already reported"', () => {
  const km = (n: number) => n / 111.195; // degrees of latitude

  it('lists problems up to 2 km away, nearest first, and lets a neighbour 1 km away confirm a water problem', async () => {
    start();
    const a = await citizen(1);
    await file(a, { lat: here.lat + km(1.4), lng: here.lng });
    const near = (await call('GET', `/nearby?lat=${here.lat}&lng=${here.lng}`)).json().items;
    expect(near).toHaveLength(1);
    expect(near[0].distanceM).toBeGreaterThan(1300);
    expect((await call('GET', `/nearby?lat=${here.lat + km(5)}&lng=${here.lng}`)).json().items).toHaveLength(0);
    const b = await citizen(2);
    expect((await call('POST', `/nearby/${near[0].id}/metoo`, { lat: here.lat, lng: here.lng }, { 'x-session': b })).statusCode).toBe(200);
    expect((await call('POST', `/nearby/${near[0].id}/metoo`, { lat: here.lat - km(3), lng: here.lng }, { 'x-session': await citizen(3) })).json().error.code).toBe('too_far');
  });

  it('keeps pothole confirmations tight (300 m) and still forms the incident, because confirmations count at the problem', async () => {
    start();
    const road = { issueType: 'POTHOLE', size: 2 };
    const id = (await file(await citizen(1), road)).json().complaint.id;
    expect((await call('POST', `/nearby/${id}/metoo`, { lat: here.lat + km(0.5), lng: here.lng }, { 'x-session': await citizen(2) })).json().error.code).toBe('too_far');
    expect((await call('POST', `/nearby/${id}/metoo`, { lat: here.lat + km(0.25), lng: here.lng }, { 'x-session': await citizen(2) })).statusCode).toBe(200);
  });

  it('marks what you already reported or confirmed, before and after it becomes an incident, so the button can say so', async () => {
    start();
    const [a, b, c] = [await citizen(1), await citizen(2), await citizen(3)];
    const id = (await file(a)).json().complaint.id;
    const list = async (token?: string) => (await call('GET', `/nearby?lat=${here.lat}&lng=${here.lng}`, undefined, token ? { 'x-session': token } : {})).json().items;
    expect((await list(a))[0].mine).toBe(true);   // my own report
    expect((await list(b))[0].mine).toBe(false);  // a neighbour has not
    expect((await list())[0].mine).toBe(false);   // signed out
    await call('POST', `/nearby/${id}/metoo`, { ...here }, { 'x-session': b });
    expect((await list(b))[0].mine).toBe(true);   // after confirming
    await call('POST', `/nearby/${id}/metoo`, { ...here }, { 'x-session': c });
    const after = await list(b);
    expect(after).toHaveLength(1);
    expect([after[0].kind, after[0].mine]).toEqual(['incident', true]); // the report became an incident with a new id: still marked
    expect((await list(await citizen(4)))[0].mine).toBe(false);
  });
});

describe('community numbers by place', () => {
  it('shows only the area around you, and caps the ward list', async () => {
    const { service } = start();
    await service.loadSample();
    const all = (await call('GET', '/public/summary')).json();
    expect(all.wards.length).toBeLessThanOrEqual(8);
    const far = (await call('GET', '/public/summary?lat=10&lng=77&km=10')).json();
    expect(far.totals).toMatchObject({ reports: 0, open: 0, fixed: 0 });
    expect(far.wards).toEqual([]);
    const near = (await call('GET', `/public/summary?lat=${BASE.lat}&lng=${BASE.lng}&km=20`)).json();
    expect(near.totals.reports).toBeGreaterThan(50);
    expect(near.scope).toMatchObject({ km: 20 });
  });
});

describe('fix photo review', () => {
  it('an officer uploads a photo, a senior officer checks it, and the citizen sees it', async () => {
    const { service } = start();
    let id = '';
    for (let i = 1; i <= 4; i++) id = (await file(await citizen(i))).json().incidentId ?? id;
    expect(id).toBeTruthy();
    const as = async (action: string, role: string, who: string, body: object = {}) => call('POST', `/incidents/${id}/actions/${action}`, body, { 'x-officer': await officer(who, role) });
    for (const [a, r, who] of [['verify', 'L1', 'field1'], ['approve', 'L2', 'zonal1'], ['assign', 'L2', 'zonal1'], ['start', 'L1', 'field1']] as const) await as(a, r, who);
    const png = (await sharp({ create: { width: 2000, height: 1200, channels: 3, background: '#445566' } }).png().toBuffer()).toString('base64');
    expect((await as('resolve', 'L1', 'field1', { proofPhoto: 'not an image' })).statusCode).toBe(400);
    const sent = await as('resolve', 'L1', 'field1', { proofPhoto: png });
    expect([sent.statusCode, sent.json().workflow.stage, sent.json().hasProof]).toEqual([200, 'PROOF_REVIEW', true]);
    expect(JSON.stringify(sent.json())).not.toContain('data:image'); // the photo is fetched separately

    const view = (await call('GET', `/incidents/${id}/proof`, undefined, { 'x-session': await citizen(1) })).json();
    expect(view.photo).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(view.photo.split(',')[1], 'base64')).metadata();
    expect(meta.width).toBe(1024); // shrunk
    expect((await call('GET', `/incidents/${id}/proof`)).statusCode).toBe(401);

    expect((await as('approve-proof', 'L1', 'field1')).statusCode).toBe(403);
    expect((await as('reject-proof', 'L2', 'zonal1', { reason: 'wrong street' })).json().workflow.stage).toBe('IN_PROGRESS');
    await as('resolve', 'L1', 'field1', { proofPhoto: png });
    expect((await as('approve-proof', 'L2', 'zonal1')).json().status).toBe('resolved');
    expect((await call('GET', `/public/proof/${id}`)).statusCode).toBe(404); // not public until the citizen confirms
    const confirm = await call('POST', `/incidents/${id}/actions/confirm`, {}, { 'x-session': await citizen(1) });
    expect(confirm.json().workflow.stage).toBe('CONFIRMED');
    expect((await call('GET', `/public/proof/${id}`)).json().photo).toMatch(/^data:image/);
    expect((await service.publicSummary()).recentlyFixed[0]).toMatchObject({ id, hasProof: true });
  });
});

describe('community numbers and watchlist', () => {
  it('summarises the sample town for everyone and flags zones that may fail next', async () => {
    const { service } = start();
    await service.loadSample();
    const sum = (await call('GET', '/public/summary')).json();
    expect(sum.totals.fixed).toBeGreaterThanOrEqual(2);
    expect(sum.totals.open).toBeGreaterThan(3);
    expect(sum.wards).toHaveLength(8);
    expect(sum.recentlyFixed.length).toBeGreaterThan(0);
    expect((await call('GET', '/risk/zones')).statusCode).toBe(401);
    const zones = (await call('GET', '/risk/zones', undefined, { 'x-officer': await officer('zonal1', 'L2') })).json().zones;
    expect(zones.length).toBeGreaterThan(0);
    expect(zones[0].reasons.length).toBeGreaterThan(0);
  });
});
