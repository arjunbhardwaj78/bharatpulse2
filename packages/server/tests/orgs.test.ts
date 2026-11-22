import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { Officers } from '../src/officers.js';
import { TenantHub } from '../src/tenants.js';
import type { StoredIncident } from '../src/types.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());
async function start() {
  const hub = await new TenantHub({ serviceOptions: {} }).init();
  app = buildApp(hub, {}, { auth: new Auth('salt', '123456'), officers: new Officers('demo-pw'), adminKey: 'k' });
  return hub;
}
const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const login = async (tenant: string, id: string, password = 'demo-pw') => (await call('POST', '/officer/login', { id, password }, { 'x-tenant': tenant })).json();

describe('private operators on the same platform', () => {
  it('onboards a private operator with its own areas and job titles', async () => {
    await start();
    const r = (await call('POST', '/cities', { name: 'Sitapur Water Services', state: 'Uttar Pradesh', lat: 27.57, lng: 80.68, wards: 4, orgType: 'water_utility' })).json();
    expect(r.tenant).toMatchObject({ orgType: 'water_utility', sector: 'private', area: 'Service zone' });
    const city = (await call('GET', '/city', undefined, { 'x-tenant': r.tenant.id })).json();
    expect(city.localities[0].name).toBe('Service zone 1');
    const head = await login(r.tenant.id, 'head1', r.officerPassword);
    expect(head.officer).toMatchObject({ name: 'Operations Head', role: 'L3' });
    expect((await call('POST', '/cities', { name: 'Bad Type Org', state: 'UP', lat: 27, lng: 80, orgType: 'casino' })).statusCode).toBe(400);
    expect((await call('GET', '/orgs/types')).json().types.map((t: { id: string }) => t.id)).toContain('toll_road');
    expect((await call('GET', '/plans')).json().plans.some((p: { id: string }) => p.id === 'site')).toBe(true);
  });

  it('refers a confirmed outage at a private site to the municipality whose pipe feeds it', async () => {
    await start();
    const seeded = (await call('POST', '/admin/seed-partners', {}, { 'x-admin-key': 'k' })).json();
    expect(seeded.partners.map((p: { orgType: string }) => p.orgType)).toEqual(['industrial_park', 'toll_road']);
    expect(seeded.referrals).toHaveLength(1); // only the park's water outage; the toll road's potholes are its own job
    const town = await login('demo', 'zonal1');
    const refs = (await call('GET', '/referrals', undefined, { 'x-tenant': 'demo', 'x-officer': town.token })).json();
    expect(refs.incoming[0]).toMatchObject({ fromName: 'Hodal Industrial Park', assetName: 'South feeder (Wards 5-6)', status: 'open' });
    expect(refs.incoming[0].people).toBeGreaterThanOrEqual(5);
    // the town received it as ONE report from the organisation, not the workers' reports
    const reports = (await call('GET', '/complaints/pending', undefined, { 'x-tenant': 'demo', 'x-officer': town.token })).json();
    expect(JSON.stringify(reports)).toContain('Referred by Hodal Industrial Park');
    const park = await login('hodal-industrial-park', 'head1');
    expect(park.officer.name).toBe('Estate Manager');
    const out = (await call('GET', '/referrals', undefined, { 'x-tenant': 'hodal-industrial-park', 'x-officer': park.token })).json();
    expect(out.outgoing).toHaveLength(1);
    expect(out.fedBy).toMatchObject({ name: 'Demo Nagar Palika', asset: 'South feeder (Wards 5-6)' });
    // a field officer cannot acknowledge; a zonal officer can; the park sees it
    const field = await login('demo', 'field1');
    expect((await call('POST', `/referrals/${refs.incoming[0].id}/ack`, {}, { 'x-tenant': 'demo', 'x-officer': field.token })).statusCode).toBe(403);
    expect((await call('POST', `/referrals/${refs.incoming[0].id}/ack`, {}, { 'x-tenant': 'demo', 'x-officer': town.token })).json().status).toBe('acknowledged');
    expect((await call('GET', '/referrals', undefined, { 'x-tenant': 'hodal-industrial-park', 'x-officer': park.token })).json().outgoing[0].status).toBe('acknowledged');
    // calling it again changes nothing
    expect((await call('POST', '/admin/seed-partners', {}, { 'x-admin-key': 'k' })).json().referrals).toHaveLength(1);
  });

  it('never refers a held (possibly fake) outage, and needs a signed-in officer', async () => {
    const hub = await start();
    await hub.ensurePartners();
    const before = hub.referrals('demo').incoming.length;
    const held = { incident: { id: 'x', family: 'SUPPLY', complaintCount: 30, trust: { needsVerification: true, independentSources: 1 } }, status: 'open' } as unknown as StoredIncident;
    expect(await hub.maybeRefer('hodal-industrial-park', held)).toBeUndefined();
    expect(hub.referrals('demo').incoming.length).toBe(before);
    expect((await call('GET', '/referrals', undefined, { 'x-tenant': 'demo' })).statusCode).toBe(401);
  });
});
