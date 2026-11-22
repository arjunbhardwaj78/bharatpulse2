import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { IncidentService } from '../src/service.js';
import { BASE, FakeClock, counterIds } from './helpers.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
function start() {
  const clock = new FakeClock();
  const auth = new Auth('salt', '123456', clock.now);
  const service = new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds(), auth });
  app = buildApp(service, {}, { auth, officers: new Officers('pw'), requireOtp: true });
  return { clock, service };
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const citizen = async (n: number) => (await call('POST', '/otp/verify', { phone: `90000000${10 + n}`, code: '123456' })).json().token as string;
const officer = async (id: string, role: string) => (await call('POST', '/officer/login', { id, role, password: 'pw' })).json().token as string;
const here = { lat: BASE.lat, lng: BASE.lng };

describe('water diary', () => {
  it('keeps one answer per person per day, and shows each household its week', async () => {
    const { clock } = start();
    const t = await citizen(1);
    const say = (status: string) => call('POST', '/checkins', { status, ...here }, { 'x-session': t });
    expect((await say('CAME')).statusCode).toBe(201);
    expect((await say('NONE')).statusCode).toBe(201); // changed their mind the same day
    clock.advance(24 * 60);
    await say('LATE');
    const mine = (await call('GET', '/checkins/mine', undefined, { 'x-session': t })).json().checkins;
    expect(mine.map((c: { status: string }) => c.status)).toEqual(['NONE', 'LATE']);
    expect((await call('POST', '/checkins', { status: 'MAYBE', ...here }, { 'x-session': t })).statusCode).toBe(400);
    expect((await call('POST', '/checkins', { status: 'CAME', ...here })).statusCode).toBe(401);
  });

  it('turns many households\' answers into a reliability figure per ward, and flags chronic wards', async () => {
    const { service } = start();
    await service.loadSample();
    const { wards } = (await call('GET', '/public/supply')).json();
    const by = Object.fromEntries(wards.map((w: { id: string }) => [w.id, w]));
    expect(by.L1.reliability).toBe(100);
    expect(by.L5.reliability).toBeLessThan(35);
    expect(by.L5.chronic).toBe(true);
    expect(by.L1.chronic).toBe(false);
    expect(wards[0].id).toBe('L5'); // worst first
    expect((await call('GET', `/public/supply?lat=10&lng=77&km=10`)).json().wards).toEqual([]);
  });

  it('ignores a ward until at least 3 answers exist, and feeds the officers\' watchlist', async () => {
    const { service } = start();
    await service.checkin('a', 'NONE', here.lat, here.lng);
    await service.checkin('b', 'NONE', here.lat, here.lng);
    expect((await service.supply()).wards).toEqual([]);
    await service.loadSample();
    const zones = (await call('GET', '/risk/zones', undefined, { 'x-officer': await officer('zonal1', 'L2') })).json().zones;
    expect(JSON.stringify(zones)).toContain("residents' diary");
  });
});

describe('planned-work notices', () => {
  it('lets zonal officers announce planned work, and citizens near it see it', async () => {
    const { clock } = start();
    const post = async (who: [string, string], body: object) => call('POST', '/notices', body, { 'x-officer': await officer(...who) });
    const t0 = clock.now();
    const body = { kind: 'WATER_CUT', title: 'Valve repair', wardIds: ['L1'], startsAt: t0 - HOUR, endsAt: t0 + 3 * HOUR };
    expect((await post(['field1', 'L1'], body)).statusCode).toBe(403); // field officers cannot
    expect((await call('POST', '/notices', body)).statusCode).toBe(401);
    expect((await post(['zonal1', 'L2'], { ...body, title: 'x' })).statusCode).toBe(400);
    expect((await post(['zonal1', 'L2'], { ...body, endsAt: t0 - 5 })).statusCode).toBe(400);
    expect((await post(['zonal1', 'L2'], { ...body, wardIds: ['nope'] })).statusCode).toBe(400);
    const made = await post(['zonal1', 'L2'], body);
    expect(made.statusCode).toBe(201);

    const near = (await call('GET', `/notices/near?lat=${here.lat}&lng=${here.lng}`)).json().notices;
    expect(near.map((n: { title: string }) => n.title)).toEqual(['Valve repair']);
    expect((await call('GET', `/notices/near?lat=${here.lat + 0.5}&lng=${here.lng}`)).json().notices).toEqual([]);
    expect((await call('GET', '/notices')).statusCode).toBe(401);
    expect((await call('DELETE', `/notices/${made.json().id}`, undefined, { 'x-officer': await officer('zonal1', 'L2') })).json()).toEqual({ removed: true });
    expect((await call('GET', `/notices/near?lat=${here.lat}&lng=${here.lng}`)).json().notices).toEqual([]);
    expect((await call('DELETE', '/notices/nope', undefined, { 'x-officer': await officer('zonal1', 'L2') })).statusCode).toBe(404);
  });

  it('stops showing a notice once it is over, and shows ones starting within a week', async () => {
    const { clock } = start();
    const t0 = clock.now();
    const o = { 'x-officer': await officer('head1', 'L3') };
    await call('POST', '/notices', { kind: 'ROAD_WORK', title: 'Resurfacing', wardIds: ['L1'], startsAt: t0 + 2 * DAY, endsAt: t0 + 2 * DAY + 5 * HOUR }, o);
    await call('POST', '/notices', { kind: 'OTHER', title: 'Next month', wardIds: ['L1'], startsAt: t0 + 20 * DAY, endsAt: t0 + 21 * DAY }, o);
    const titles = async () => (await call('GET', `/notices/near?lat=${here.lat}&lng=${here.lng}`)).json().notices.map((n: { title: string }) => n.title);
    expect(await titles()).toEqual(['Resurfacing']);
    clock.advance(3 * 24 * 60);
    expect(await titles()).toEqual([]);
  });
});

describe('repeat problems and recently fixed spots', () => {
  async function fixedIncident(service: IncidentService, clock: FakeClock, tag: string, type = 'POTHOLE') {
    let id = '';
    for (let i = 0; i < 3; i++) id = (await service.submitComplaint({ reporterId: `${tag}${i}`, issueType: type, lat: here.lat + i * 0.00005, lng: here.lng })).incidentId ?? id;
    for (const [a, r, x] of [['verify', 'L1', {}], ['approve', 'L2', {}], ['assign', 'L2', {}], ['resolve', 'L1', { proofHash: 'h' }], ['approve-proof', 'L2', {}]] as const) await service.act(id, { action: a, role: r, ...x });
    clock.advance(60 * 24 * 5);
    return id;
  }

  it('tells officers when the same spot was fixed before, and shows citizens what was fixed nearby', async () => {
    const { service, clock } = start();
    await fixedIncident(service, clock, 'a');
    let id2 = '';
    for (let i = 0; i < 3; i++) id2 = (await service.submitComplaint({ reporterId: `b${i}`, issueType: 'POTHOLE', lat: here.lat + i * 0.00005, lng: here.lng })).incidentId ?? id2;
    const list = (await call('GET', '/incidents?status=all')).json().incidents;
    const again = list.find((i: { id: string }) => i.id === id2);
    expect(again.repeat).toMatchObject({ count: 1 });
    expect(list.filter((i: { repeat?: unknown }) => i.repeat)).toHaveLength(1); // the first one is not a repeat of anything

    const near = (await call('GET', `/nearby?lat=${here.lat}&lng=${here.lng}`)).json().items;
    const kinds = near.map((n: { kind: string }) => n.kind).sort();
    expect(kinds).toEqual(['fixed', 'incident']);
    expect(near.every((n: { lat: number }) => String(n.lat).split('.')[1].length <= 3)).toBe(true);
  });

  it('does not call a different kind of problem, or an old fix, a repeat', async () => {
    const { service, clock } = start();
    await fixedIncident(service, clock, 'w', 'LEAK'); // a water fix
    let road = '';
    for (let i = 0; i < 3; i++) road = (await service.submitComplaint({ reporterId: `r${i}`, issueType: 'POTHOLE', lat: here.lat + i * 0.00005, lng: here.lng })).incidentId ?? road;
    expect((await service.repeatMap()).has(road)).toBe(false);
    clock.advance(200 * 24 * 60); // the fix is now more than six months old
    expect((await service.repeatMap()).size).toBe(0);
  });
});
