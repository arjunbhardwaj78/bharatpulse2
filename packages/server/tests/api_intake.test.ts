import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { MemoryStore } from '../src/memoryStore.js';
import { IncidentService } from '../src/service.js';
import { Sarvam } from '../src/sarvam.js';
import { BASE, FakeClock, counterIds, fakeSarvamFetch } from './helpers.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => app?.close());

const start = (deps: { requireOtp?: boolean; sarvam?: Sarvam; adminKey?: string } = {}) => {
  const clock = new FakeClock();
  const auth = new Auth('salt', '123456', clock.now);
  app = buildApp(new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds(), auth }), {}, { auth, ...deps });
  return clock;
};
const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) => app.inject({ method, url, payload, headers });
const login = async (phone: string) => (await call('POST', '/otp/verify', { phone, code: '123456' })).json().token as string;
const where = (north = 0) => ({ lat: BASE.lat + north / 111_195, lng: BASE.lng });

describe('intake over HTTP', () => {
  it('refuses complaints without a verified phone when OTP is required', async () => {
    start({ requireOtp: true });
    expect((await call('POST', '/complaints', { issueType: 'NO_WATER', ...where() })).statusCode).toBe(401);
    expect((await call('POST', '/otp/verify', { phone: '9876543210', code: 'wrong' })).statusCode).toBe(401);
  });

  it('takes the reporter from the session, classifies text, and never echoes the device or IP', async () => {
    start({ requireOtp: true });
    const token = await login('9876543210');
    const res = await call('POST', '/complaints', { text: 'pani nahi aa raha subah se', deviceId: 'dev-1', ...where() }, { 'x-session': token });
    expect(res.statusCode).toBe(201);
    const { complaint } = res.json();
    expect(complaint).toMatchObject({ issueType: 'NO_WATER', localityId: 'L1' });
    expect(complaint.reporterId).toMatch(/^r_/);
    expect(complaint.deviceId).toBeUndefined();
    expect(complaint.ipHash).toBeUndefined();
  });

  it('reads photos into hashes and marks road reports near a school or hospital', async () => {
    start({ requireOtp: true });
    const token = await login('9876543210');
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#556677' } }).png().toBuffer();
    const res = await call('POST', '/complaints', { issueType: 'POTHOLE', lat: 27.4924 + 0.0081, lng: 77.6737 + 0.0002, photos: [png.toString('base64')] }, { 'x-session': token });
    expect(res.json().complaint).toMatchObject({ nearFacility: true });
    expect(res.json().complaint.photoHashes[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports a missing voice setup clearly, and uses Sarvam when configured', async () => {
    start({ requireOtp: true });
    const token = await login('9876543210');
    const audio = Buffer.from('fake wav').toString('base64');
    expect((await call('POST', '/complaints', { audio, ...where() }, { 'x-session': token })).json().error.code).toBe('sarvam_unavailable');
    await app.close();

    const seen: { path: string; body: unknown }[] = [];
    start({ requireOtp: true, sarvam: new Sarvam('k', { fetchFn: fakeSarvamFetch({ '/speech-to-text': { transcript: 'ஒரு வாரமாக குழாயில் கழிவு நீர் கலந்து வருகிறது', language_code: 'ta-IN' }, '/translate': { translated_text: 'For a week dirty sewage water has been mixing into the tap' } }, seen) }) });
    const t2 = await login('9876543211');
    const res = await call('POST', '/complaints', { audio, ...where() }, { 'x-session': t2 });
    // Tamil speech -> Tamil text kept, English for the officer, and the English is what gets classified
    expect(res.json()).toMatchObject({ transcript: 'ஒரு வாரமாக குழாயில் கழிவு நீர் கலந்து வருகிறது', textEn: 'For a week dirty sewage water has been mixing into the tap', language: 'ta-IN', complaint: { issueType: 'DIRTY_WATER', language: 'ta-IN' } });
    expect(seen.map((x) => x.path)).toEqual(['/speech-to-text', '/translate']);
    expect(seen[1].body).toMatchObject({ source_language_code: 'ta-IN', target_language_code: 'en-IN' });
  });
});

describe('browser access', () => {
  it('answers preflight requests and shares the workflow rules', async () => {
    start();
    const pre = await call('POST' as never, '/complaints').then(() => app.inject({ method: 'OPTIONS', url: '/complaints' }));
    expect([pre.statusCode, pre.headers['access-control-allow-origin']]).toEqual([204, '*']);
    expect(pre.headers['access-control-allow-headers']).toContain('x-session');
    expect((await call('GET', '/workflow')).json().verify).toMatchObject({ roles: ['L1', 'L2', 'L3'], to: 'VERIFIED' });
  });
});

describe('me-too, workflow and graph over HTTP', () => {
  async function incident() {
    const clock = start({ requireOtp: true });
    let id = '';
    for (let i = 0; i < 4; i++) {
      const token = await login(`98765432${10 + i}`);
      id = (await call('POST', '/complaints', { issueType: 'NO_WATER', deviceId: `d${i}`, ...where(i * 20) }, { 'x-session': token })).json().incidentId ?? id;
      clock.advance(1);
    }
    return id;
  }

  it('locks me-too server-side: the second tap is refused', async () => {
    const id = await incident();
    const token = await login('9000000001');
    const first = await call('POST', `/incidents/${id}/metoo`, where(10), { 'x-session': token });
    expect(first.statusCode).toBe(200);
    expect((await call('POST', `/incidents/${id}/metoo`, where(10), { 'x-session': token })).json().error.code).toBe('already_confirmed');
    expect((await call('POST', `/incidents/${id}/metoo`, where(10))).statusCode).toBe(401);
  });

  it('enforces roles on workflow actions', async () => {
    const id = await incident();
    const act = (action: string, role: string, payload = {}) => call('POST', `/incidents/${id}/actions/${action}`, payload, { 'x-role': role });
    expect((await act('verify', 'CITIZEN')).statusCode).toBe(401); // a citizen needs a session
    expect((await act('verify', 'L4')).statusCode).toBe(403);
    expect((await act('verify', 'L1')).json().workflow.stage).toBe('VERIFIED');
    expect((await act('verify', 'L1')).statusCode).toBe(409);
    expect((await act('fly', 'L1')).statusCode).toBe(404);
    expect((await call('GET', '/incidents?status=all')).json().incidents[0].workflow.audit).toHaveLength(2);
  });

  it('serves the graph, downstream impact, directory, city and stats', async () => {
    const id = await incident();
    expect((await call('GET', `/incidents/${id}/graph`)).statusCode).toBe(401); // who reported what: officers only
    const g = (await call('GET', `/incidents/${id}/graph`, undefined, { 'x-role': 'L1' })).json();
    expect(g.nodes.length).toBeGreaterThan(8);
    expect(g.engine).toBe('memory');
    expect(g.cypher[0]).toContain('MATCH');
    expect((await call('GET', '/zones/Z1/downstream')).json().downstream.map((d: { zone: string }) => d.zone)).toEqual(['Z2', 'Z3', 'Z4']);
    expect((await call('GET', '/directory')).json().emergency.phone).toBe('112');
    expect((await call('GET', '/city')).json().zones).toHaveLength(4);
    expect((await call('GET', '/stats')).json().open).toBe(1);
  });

  it('protects admin routes with a key and loads a scenario', async () => {
    start({ adminKey: 'secret' });
    expect((await call('POST', '/admin/scenario', { kind: 'outage', n: 20 })).statusCode).toBe(401);
    const ok = await call('POST', '/admin/scenario', { kind: 'outage', n: 20 }, { 'x-admin-key': 'secret' });
    expect(ok.statusCode).toBe(201);
    expect((await call('POST', '/admin/scenario', { kind: 'nope' }, { 'x-admin-key': 'secret' })).statusCode).toBe(400);
    expect((await call('GET', '/admin/replay?minute=120')).statusCode).toBe(401);
    expect((await call('GET', '/admin/replay?minute=120', undefined, { 'x-admin-key': 'secret' })).json().reports).toBe(40);
  });
});
