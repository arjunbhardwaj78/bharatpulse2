import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { CITY, directoryFor } from '../src/data.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { IncidentService } from '../src/service.js';
import { Sarvam } from '../src/sarvam.js';
import { BASE, FakeClock, counterIds, fakeSarvamFetch } from './helpers.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());

function start(deps: { geofence?: boolean; sarvam?: Sarvam; places?: import('../src/places.js').PlaceFinder } = {}) {
  const clock = new FakeClock();
  const auth = new Auth('salt', '123456', clock.now);
  const service = new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds(), auth });
  app = buildApp(service, {}, { auth, officers: new Officers('pw'), requireOtp: true, ...deps });
  return { clock, service };
}
const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const citizen = async (phone = '9876543210') => {
  expect((await call('POST', '/otp/request', { phone })).json()).toEqual({ sent: true, simulated: true });
  return (await call('POST', '/otp/verify', { phone, code: '123456' })).json().token as string;
};
const officer = async (id: string, role: string) => (await call('POST', '/officer/login', { id, role, password: 'pw' })).json().token as string;
const here = { lat: BASE.lat, lng: BASE.lng };

describe('sign-in', () => {
  it('asks for a valid phone before sending a code', async () => {
    start();
    expect((await call('POST', '/otp/request', { phone: '12' })).statusCode).toBe(400);
  });

  it('signs officers in by ID, password and role', async () => {
    start();
    expect((await call('POST', '/officer/login', { id: 'zonal1', role: 'L2', password: 'nope' })).json().error.code).toBe('bad_login');
    expect((await call('POST', '/officer/login', { id: 'zonal1', role: 'L3', password: 'pw' })).json().error.code).toBe('wrong_role');
    expect((await call('POST', '/officer/login', { id: 'zonal1', role: 'L2', password: 'pw' })).json().officer).toMatchObject({ role: 'L2' });
  });

  it('takes the role from the signed-in officer and ignores the x-role header', async () => {
    const { service } = start();
    const token = await citizen();
    let id = '';
    for (let i = 0; i < 3; i++) id = (await service.submitComplaint({ reporterId: `r${i}`, issueType: 'NO_WATER', ...here, lat: here.lat + i * 0.0001 })).incidentId ?? id;
    const verify = (headers: Record<string, string>) => call('POST', `/incidents/${id}/actions/verify`, {}, headers);
    expect((await verify({ 'x-role': 'L1' })).statusCode).toBe(401); // header alone is not a login
    expect((await verify({ 'x-officer': await officer('commissioner1', 'L4'), 'x-role': 'L1' })).statusCode).toBe(403); // read-only
    expect((await verify({ 'x-officer': await officer('field1', 'L1') })).json().workflow.stage).toBe('VERIFIED');
    expect(token).toBeTruthy();
  });
});

describe('reports reach officers', () => {
  it('shows a single complaint in New reports before it becomes an incident, and in the citizen\'s own list', async () => {
    start();
    const token = await citizen();
    const sent = await call('POST', '/complaints', { category: 'WATER', text: 'something strange', address: 'Lane 4, near the temple', ...here }, { 'x-session': token });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().complaint.issueType).toBe('OTHER_WATER'); // no type picked, nothing matched: still accepted
    expect((await call('GET', '/complaints/pending')).statusCode).toBe(401);
    const pending = (await call('GET', '/complaints/pending', undefined, { 'x-officer': await officer('field1', 'L1') })).json().reports;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ issueType: 'OTHER_WATER', address: 'Lane 4, near the temple' });
    expect(pending[0].reporterId).toBeUndefined();
    const mine = (await call('GET', '/complaints/mine', undefined, { 'x-session': token })).json().complaints;
    expect(mine[0]).toMatchObject({ incidentId: null, office: { handles: ['WATER', 'ROADS'] } });
  });

  it('falls back to a road issue when the category is road', async () => {
    start();
    const token = await citizen();
    const r = await call('POST', '/complaints', { category: 'ROAD', ...here }, { 'x-session': token });
    expect(r.json().complaint.issueType).toBe('OTHER_ROAD');
  });
});

describe('where to go for help', () => {
  it('picks the zone contact and the office that handles this kind of problem', () => {
    const z1 = CITY.localities.find((l) => l.zoneId === 'Z1')!;
    const z3 = CITY.localities.find((l) => l.zoneId === 'Z3')!;
    const shared = directoryFor(CITY, z1.lat, z1.lng, 'ROADS');
    expect([shared.office?.name, shared.officeHandlesBoth, shared.contact?.zoneId]).toEqual(['Nagar Palika Parishad', true, 'Z1']);
    expect(directoryFor(CITY, z3.lat, z3.lng, 'WATER').office?.name).toBe('Jal Nigam zonal office');
    expect(directoryFor(CITY, z3.lat, z3.lng, 'ROADS').office?.name).toBe('PWD division office');
    expect(directoryFor(CITY, 0, 0).office).toBeUndefined();
  });

  it('serves it over HTTP, and still serves the plain directory', async () => {
    start();
    expect((await call('GET', `/directory?lat=${here.lat}&lng=${here.lng}&category=WATER`)).json()).toMatchObject({ emergency: { phone: '112' }, zone: { id: 'Z1' }, contact: { role: 'Zone committee member' } });
    expect((await call('GET', '/directory')).json().emergency.phone).toBe('112');
  });
});

describe('complaints only from where the person is', () => {
  it('accepts reports from any town, but needs the phone location and a pin within 3 km of it', async () => {
    start({ geofence: true });
    const token = await citizen();
    const send = (body: object) => call('POST', '/complaints', { issueType: 'NO_WATER', ...body }, { 'x-session': token });
    expect((await send({ lat: 28.6, lng: 77.2, deviceLat: 28.6, deviceLng: 77.2 })).statusCode).toBe(201); // another city is fine
    expect((await send(here)).json().error.code).toBe('location_required');
    expect((await send({ ...here, deviceLat: here.lat + 0.04, deviceLng: here.lng })).json().error.code).toBe('too_far_from_you'); // about 4.4 km away
    expect((await send({ ...here, deviceLat: here.lat + 0.02, deviceLng: here.lng })).statusCode).toBe(201); // 2.2 km is fine
  });

  it('adds nearby offices, with phones, to the help directory', async () => {
    start({ places: async () => ({ address: 'Lane 4, Hodal', offices: [{ name: 'Nagar Palika Hodal', phone: '01275 000000', address: 'Main Road', source: 'osm' }] }) });
    const d = (await call('GET', `/directory?lat=${here.lat}&lng=${here.lng}&category=WATER`)).json();
    expect(d.nearby).toEqual({ address: 'Lane 4, Hodal', offices: [{ name: 'Nagar Palika Hodal', phone: '01275 000000', address: 'Main Road', source: 'osm' }] });
    start({ places: async () => { throw new Error('provider down'); } });
    expect((await call('GET', `/directory?lat=${here.lat}&lng=${here.lng}`)).json().nearby.offices).toEqual([]); // a failing lookup never breaks the page
  });
});

describe('sample data', () => {
  it('loads a lively town: incidents in several stages, a leak linked to a pothole, and stray reports', async () => {
    const { service } = start();
    expect(await service.loadSample()).toBeGreaterThan(100);
    const all = await service.listAll();
    expect(all.length).toBeGreaterThanOrEqual(7);
    expect(new Set(all.map((s) => s.workflow?.stage)).size).toBeGreaterThanOrEqual(3);
    expect(all.some((s) => s.possibleCause)).toBe(true);
    expect(all.some((s) => s.incident.trust.needsVerification)).toBe(true);
    expect((await service.pending()).length).toBeGreaterThanOrEqual(3);
  });

  it('can be cleared again', async () => {
    const { service } = start();
    await service.loadSample();
    await service.clear();
    expect(await service.listAll()).toEqual([]);
    expect(await service.pending()).toEqual([]);
  });

  it('is available over HTTP and reported by /health', async () => {
    start();
    expect((await call('GET', '/health')).json()).toMatchObject({ voice: false, officerLogin: true, admin: 'open' });
    expect((await call('POST', '/admin/seed')).statusCode).toBe(201);
    expect((await call('GET', '/incidents?status=all')).json().incidents.length).toBeGreaterThan(5);
    expect((await call('POST', '/admin/reset')).json()).toEqual({ cleared: true });
  });
});

describe('voice transcription', () => {
  it('turns audio into text for the form, and says so when it is not set up', async () => {
    start();
    const token = await citizen();
    const audio = Buffer.from('wav').toString('base64');
    expect((await call('POST', '/voice/transcribe', { audio }, { 'x-session': token })).json().error.code).toBe('sarvam_unavailable');
    expect((await call('POST', '/voice/transcribe', { audio })).statusCode).toBe(401); // not for anonymous callers
    await app.close();
    start({ sarvam: new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/speech-to-text': { transcript: 'எங்கள் தெருவில் தண்ணீர் வரவில்லை', language_code: 'ta-IN' }, '/translate': { translated_text: 'No water is coming in our street' } }) }) });
    const t2 = await citizen('9876543211');
    expect((await call('POST', '/voice/transcribe', { audio }, { 'x-session': t2 })).json()).toEqual({ text: 'எங்கள் தெருவில் தண்ணீர் வரவில்லை', textEn: 'No water is coming in our street', language: 'ta-IN', issueType: 'NO_WATER', engine: 'sarvam' });
  });
});
