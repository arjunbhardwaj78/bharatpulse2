import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { generateCity } from '../src/data.js';
import { reach } from '../src/graph.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { makePlaceSuggest } from '../src/places.js';
import { IncidentService } from '../src/service.js';
import { TenantHub } from '../src/tenants.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());
const DIBAI = { lat: 28.2089, lng: 78.2405 };

function start(fetchFn?: typeof fetch) {
  const hub = new TenantHub({ fetchFn, resolve: async () => ['93.184.216.34'], serviceOptions: {} }); // webhook hosts resolve to a public address
  return hub.init().then(() => {
    app = buildApp(hub, {}, { auth: new Auth('salt', '123456'), officers: new Officers('demo-pw'), adminKey: 'k' });
    return hub;
  });
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const onboard = async (name = 'Dibai Nagar Palika') => (await call('POST', '/cities', { name, state: 'Uttar Pradesh', ...DIBAI, wards: 6, email: 'eo@dibai.example' })).json();
const signIn = async (city: string, id: string, password: string) => (await call('POST', '/officer/login', { id, password }, { 'x-tenant': city })).json().token as string;

describe('a generated city map', () => {
  it('has wards in zones and a water network that reaches every zone', () => {
    const c = generateCity(DIBAI, 7);
    expect(c.localities).toHaveLength(7);
    expect(c.zones).toHaveLength(4);
    const fromTank = reach(c, 'T1');
    expect(c.zones.every((z) => fromTank.has(z.id))).toBe(true);
  });
});

describe('multi-city platform', () => {
  it('onboards a city with its own map and a one-time officer password', async () => {
    await start();
    const r = await onboard();
    expect(r.tenant).toMatchObject({ id: 'dibai-nagar-palika', plan: 'pilot', wards: 6, kind: 'customer' });
    expect(r.officerPassword).toMatch(/^[0-9a-f]{8}-[0-9a-f]{6}$/);
    expect((await call('GET', '/cities')).json().cities.map((c: { id: string }) => c.id)).toEqual(['demo', 'dibai-nagar-palika']);
    expect((await call('GET', '/city', undefined, { 'x-tenant': 'dibai-nagar-palika' })).json()).toMatchObject({ name: 'Dibai Nagar Palika', localities: expect.any(Array) });
    expect((await call('POST', '/cities', { name: 'x' })).statusCode).toBe(400);
    expect((await call('GET', '/city', undefined, { 'x-tenant': 'nowhere' })).json().error.code).toBe('city_not_found');
  });

  it('keeps each city data and officers apart', async () => {
    await start();
    const { officerPassword } = await onboard();
    const dibai = { 'x-tenant': 'dibai-nagar-palika' };
    expect((await call('POST', '/officer/login', { id: 'zonal1', password: 'demo-pw' }, dibai)).statusCode).toBe(401); // demo password does not open Dibai
    const token = await signIn('dibai-nagar-palika', 'zonal1', officerPassword);
    expect(token).toBeTruthy();
    expect((await call('GET', '/complaints/pending', undefined, { 'x-officer': token })).json().error.code).toBe('wrong_city'); // a Dibai token on the demo city
    await call('POST', '/admin/seed', {}, { 'x-admin-key': 'k' }); // demo city only
    expect((await call('GET', '/incidents')).json().count).toBeGreaterThan(3);
    expect((await call('GET', '/incidents', undefined, dibai)).json().count).toBe(0);
  });

  it('lets a city plug in its existing portal: API key -> import -> incidents back, idempotent', async () => {
    await start();
    const { officerPassword } = await onboard();
    const h = { 'x-tenant': 'dibai-nagar-palika', 'x-officer': await signIn('dibai-nagar-palika', 'head1', officerPassword) };
    expect((await call('GET', '/admin/console', undefined, { ...h, 'x-officer': await signIn('dibai-nagar-palika', 'field1', officerPassword) })).statusCode).toBe(403);
    const { key } = (await call('POST', '/admin/keys', { label: 'CPGRAMS export' }, h)).json();
    expect(key).toMatch(/^bp_live_/);
    const complaints = Array.from({ length: 5 }, (_, i) => ({ externalId: `CPG-${i}`, reporter: `citizen-${i}`, text: 'no water since morning', lat: DIBAI.lat + i * 0.0003, lng: DIBAI.lng, createdAt: new Date(Date.now() - (5 - i) * 600_000).toISOString() }));
    const first = (await call('POST', '/v1/complaints', { source: 'cpgrams', complaints }, { 'x-api-key': key })).json();
    expect(first).toMatchObject({ city: 'dibai-nagar-palika', accepted: 5, duplicates: 0, rejected: [], activeIncidents: 1 });
    expect((await call('POST', '/v1/complaints', { source: 'cpgrams', complaints }, { 'x-api-key': key })).json()).toMatchObject({ accepted: 0, duplicates: 5 });
    expect((await call('POST', '/v1/complaints', { complaints: [{ externalId: 'x', lat: 999, lng: 1 }] }, { 'x-api-key': key })).json().rejected[0].reason).toContain('lat');
    expect((await call('GET', '/v1/incidents', undefined, { 'x-api-key': key })).json().incidents[0]).toMatchObject({ family: 'SUPPLY', people: 5 });
    expect((await call('GET', '/v1/incidents', undefined, { 'x-api-key': 'bp_live_nope' })).statusCode).toBe(401);
    const con = (await call('GET', '/admin/console', undefined, h)).json();
    expect(con.usage.counts.imported).toBe(5);
    expect(con.apiKeys[0]).toMatchObject({ label: 'CPGRAMS export' });
    expect(con.apiKeys[0].hash).toBeUndefined();
    await call('DELETE', `/admin/keys/${con.apiKeys[0].id}`, undefined, h);
    expect((await call('GET', '/v1/incidents', undefined, { 'x-api-key': key })).statusCode).toBe(401); // revoked
  });

  it('sends signed webhooks for new incidents and refuses private URLs', async () => {
    const got: { url: string; body: string; sig: string }[] = [];
    const hub = await start((async (url: string, init: RequestInit) => { got.push({ url, body: String(init.body), sig: (init.headers as Record<string, string>)['x-bharatpulse-signature'] }); return new Response('ok'); }) as unknown as typeof fetch);
    const { officerPassword } = await onboard();
    const h = { 'x-tenant': 'dibai-nagar-palika', 'x-officer': await signIn('dibai-nagar-palika', 'commissioner1', officerPassword) };
    expect((await call('POST', '/admin/webhooks', { url: 'http://localhost/x' }, h)).statusCode).toBe(400);
    const w = (await call('POST', '/admin/webhooks', { url: 'https://dibai.example/hooks/bp' }, h)).json();
    const { key } = (await call('POST', '/admin/keys', {}, h)).json();
    await call('POST', '/v1/complaints', { complaints: [0, 1, 2].map((i) => ({ externalId: `a${i}`, reporter: `p${i}`, issueType: 'NO_WATER', lat: DIBAI.lat, lng: DIBAI.lng + i * 0.0002 })) }, { 'x-api-key': key });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0].body)).toMatchObject({ event: 'incident.created', city: 'dibai-nagar-palika', data: { family: 'SUPPLY', people: 3 } });
    expect(got[0].sig).toBe(createHmac('sha256', w.secret).update(got[0].body).digest('hex'));
    expect((await call('POST', `/admin/webhooks/${w.id}/test`, {}, h)).json().results).toEqual([{ id: w.id, status: '200' }]);
    expect(hub.usage('dibai-nagar-palika').counts.webhooks).toBe(2);
  });

  it('changes plan within the plan ward limit', async () => {
    await start();
    const { officerPassword } = await onboard();
    const h = { 'x-tenant': 'dibai-nagar-palika', 'x-officer': await signIn('dibai-nagar-palika', 'head1', officerPassword) };
    expect((await call('POST', '/admin/plan', { plan: 'town' }, h)).json().plan).toBe('town');
    expect((await call('POST', '/admin/plan', { plan: 'gold' }, h)).statusCode).toBe(400);
    expect((await call('GET', '/plans')).json().plans.map((p: { id: string }) => p.id)).toEqual(['pilot', 'town', 'city', 'site', 'connect']);
  });

  it('a single-service app is the demo city (back-compatible)', async () => {
    app = buildApp(new IncidentService(new MemoryStore()));
    expect((await call('GET', '/cities')).json().cities[0].id).toBe('demo');
  });
});

describe('place suggestions', () => {
  it('turns Photon results into names with district and state, India only', async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ features: [
        { geometry: { coordinates: [78.2405, 28.2089] }, properties: { name: 'Dibai', district: 'Bulandshahr', state: 'Uttar Pradesh', osm_value: 'town', countrycode: 'IN' } },
        { geometry: { coordinates: [55.27, 25.2] }, properties: { name: 'Dubai', countrycode: 'AE' } },
      ] }));
    }) as unknown as typeof fetch;
    const suggest = makePlaceSuggest({ fetchFn: f });
    expect(await suggest('dibai')).toEqual([{ name: 'Dibai', detail: 'Bulandshahr, Uttar Pradesh', lat: 28.2089, lng: 78.2405, kind: 'town' }]);
    await suggest('Dibai ');
    expect(seen).toHaveLength(1); // cached
    expect(seen[0]).toContain('bbox=68.1,6.5,97.4,35.7');
  });
});
