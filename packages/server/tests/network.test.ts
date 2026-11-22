import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { benchmarks, NetworkWatch } from '../src/network.js';
import { Officers } from '../src/officers.js';
import { TenantHub } from '../src/tenants.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());
const DIBAI = { lat: 28.2089, lng: 78.2405 };

async function start() {
  const hub = await new TenantHub({ serviceOptions: {} }).init();
  app = buildApp(hub, {}, { auth: new Auth('salt', '123456'), officers: new Officers('demo-pw'), adminKey: 'k' });
  return hub;
}
const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
async function dibaiHead() {
  const { officerPassword } = (await call('POST', '/cities', { name: 'Dibai Nagar Palika', state: 'Uttar Pradesh', ...DIBAI, wards: 6 })).json();
  const token = (await call('POST', '/officer/login', { id: 'head1', password: officerPassword }, { 'x-tenant': 'dibai-nagar-palika' })).json().token as string;
  const field = (await call('POST', '/officer/login', { id: 'field1', password: officerPassword }, { 'x-tenant': 'dibai-nagar-palika' })).json().token as string;
  return { 'x-tenant': 'dibai-nagar-palika', 'x-officer': token, field };
}
type Inc = { trust: { independentSources: number; needsVerification: boolean; authenticity: { signals: { code: string }[] }[] } };

describe('the shared fraud network', () => {
  it('holds a crowd on its FIRST report in a new city because another city caught it', async () => {
    await start();
    await call('POST', '/admin/seed', {}, { 'x-admin-key': 'k' }); // demo town: the same 10 accounts faked outages in two far-apart wards
    const { field: _f, ...h } = await dibaiHead();
    const r = (await call('POST', '/network/simulate', {}, h)).json();
    const inc = r.incidents[0] as Inc;
    expect(inc.trust.independentSources).toBe(1); // ten accounts, one source
    expect(inc.trust.needsVerification).toBe(true);
    expect(inc.trust.authenticity.every((a) => a.signals.some((s) => s.code === 'NETWORK_RING'))).toBe(true);
    expect(r.network.crowds[0]).toMatchObject({ origin: 'Demo Nagar Palika', size: 10, seenIn: ['Dibai Nagar Palika'], heldReports: 10 });
  });

  it('without the network the same crowd looks like ten real people', async () => {
    await start(); // demo town left empty: nobody has caught this crowd yet
    const { field: _f, ...h } = await dibaiHead();
    const inc = (await call('POST', '/network/simulate', {}, h)).json().incidents[0] as Inc;
    expect(inc.trust.independentSources).toBeGreaterThanOrEqual(8);
    expect(inc.trust.authenticity.some((a) => a.signals.some((s) => s.code === 'NETWORK_RING'))).toBe(false);
  });

  it('shares no account ids publicly and only lets department heads run the demo', async () => {
    await start();
    await call('POST', '/admin/seed', {}, { 'x-admin-key': 'k' });
    const { field, ...h } = await dibaiHead();
    expect((await call('POST', '/network/simulate', {}, { 'x-tenant': 'dibai-nagar-palika', 'x-officer': field })).statusCode).toBe(403);
    expect((await call('POST', '/network/simulate', {}, { 'x-officer': h['x-officer'] })).json().error.code).toBe('wrong_city');
    await call('POST', '/network/simulate', {}, h);
    const pub = await call('GET', '/network');
    expect(pub.statusCode).toBe(200);
    expect(pub.body).not.toContain('crowd-u');
    expect(pub.json()).toMatchObject({ cities: 2, heldOnFirstReport: 10, crossCityAccounts: 10, engine: 'memory' });
    expect(pub.json().cypher).toContain('size(cities) > 1');
  });

  it('benchmarks a city against anonymised peers', async () => {
    await start();
    await call('POST', '/admin/seed', {}, { 'x-admin-key': 'k' });
    const { field: _f, ...h } = await dibaiHead();
    const b = (await call('GET', '/network/benchmarks', undefined, h)).json();
    expect(b.you.name).toBe('Dibai Nagar Palika');
    expect(b.peers).toHaveLength(1);
    expect(b.peers[0].label).toBe('Town A');
    expect(JSON.stringify(b)).not.toContain('Demo Nagar Palika');
    expect(b.peers[0].open).toBeGreaterThan(0);
  });
});

describe('NetworkWatch', () => {
  it('forgets a ring when its city no longer has it, and never matches a city with itself', () => {
    const w = new NetworkWatch();
    w.record('a', [{ id: 'r1', accounts: ['x', 'y', 'z'], via: ['CO_REPORTING'] }, { id: 'r2', accounts: ['p', 'q'], via: ['DEVICE'] }]);
    expect(w.ringFor('a', 'x')).toBeUndefined();
    expect(w.ringFor('b', 'x')).toMatchObject({ id: 'net:a:r1', via: ['NETWORK', 'CO_REPORTING'] });
    expect(w.ringFor('b', 'p')).toBeUndefined(); // rings of 2 are not shared
    w.record('a', []);
    expect(w.ringFor('b', 'y')).toBeUndefined();
  });
  it('computes medians', () => {
    const b = benchmarks({ id: 'a', name: 'A' }, [{ id: 'a', m: { open: 2, avgHoursToResolve: 10, heldShare: 0.5, slaAtRisk: 1 } }, { id: 'b', m: { open: 4, avgHoursToResolve: null, heldShare: 0, slaAtRisk: 0 } }]);
    expect(b.median).toMatchObject({ open: 3, avgHoursToResolve: 10, heldShare: 0.25 });
  });
});
