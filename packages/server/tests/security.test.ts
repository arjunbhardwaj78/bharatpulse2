import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Auth } from '../src/auth.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { IncidentService } from '../src/service.js';
import { FakeClock, body } from './helpers.js';

let app: ReturnType<typeof buildApp>;
afterEach(() => { delete process.env.CORS_ORIGIN; return app?.close(); });

describe('security', () => {
  it('one network can verify only a few phones per hour (one person cannot become many neighbours)', async () => {
    app = buildApp(new IncidentService(new MemoryStore()), {}, { auth: new Auth('salt') });
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await app.inject({ method: 'POST', url: '/otp/request', payload: { phone: `98765432${10 + i}` }, remoteAddress: '1.2.3.4' })).statusCode);
    expect(codes.slice(0, 8).every((c) => c === 200)).toBe(true);
    expect(codes[8]).toBe(429);
    expect((await app.inject({ method: 'POST', url: '/otp/request', payload: { phone: '9876543299' }, remoteAddress: '5.6.7.8' })).json().demoCode).toMatch(/^\d{6}$/);
  });

  it('only allows listed web origins when CORS_ORIGIN is set', async () => {
    process.env.CORS_ORIGIN = 'https://bharatpulse.vercel.app';
    app = buildApp(new IncidentService(new MemoryStore()));
    const ok = await app.inject({ method: 'OPTIONS', url: '/health', headers: { origin: 'https://bharatpulse.vercel.app' } });
    const bad = await app.inject({ method: 'OPTIONS', url: '/health', headers: { origin: 'https://evil.example' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://bharatpulse.vercel.app');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limits officer password guessing', async () => {
    app = buildApp(new IncidentService(new MemoryStore()), {}, { officers: new Officers('pw') });
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await app.inject({ method: 'POST', url: '/officer/login', payload: { id: 'field1', password: 'guess' } })).statusCode);
    expect(codes[0]).toBe(401);
    expect(codes[10]).toBe(429);
  });

  it('officer level comes from the account, not from the form', async () => {
    app = buildApp(new IncidentService(new MemoryStore()), {}, { officers: new Officers('pw') });
    expect((await app.inject({ method: 'POST', url: '/officer/login', payload: { id: 'zonal1', password: 'pw' } })).json().officer.role).toBe('L2');
  });

  it('graph pages and Ask are for signed-in officers only', async () => {
    app = buildApp(new IncidentService(new MemoryStore()), {}, { officers: new Officers('pw') });
    for (const [method, url] of [['GET', '/graph/overview'], ['GET', '/graph/rings'], ['GET', '/graph/root-cause'], ['POST', '/ask']] as const) {
      expect((await app.inject({ method, url, payload: method === 'POST' ? { question: 'x' } : undefined })).statusCode).toBe(401);
    }
  });
});

describe('recompute cache', () => {
  it('reuses the last detection for reads within the TTL, but never after a write', async () => {
    const clock = new FakeClock();
    const store = new MemoryStore();
    let lists = 0;
    const orig = store.complaintsSince.bind(store);
    store.complaintsSince = (since: number) => { lists++; return orig(since); };
    const service = new IncidentService(store, { clock: clock.now, recomputeTtlMs: 10_000 });
    for (let i = 0; i < 3; i++) await service.submitComplaint(body(`r${i}`, i * 30));
    const before = lists;
    await service.listActive();
    await service.listActive();
    expect(lists).toBe(before); // cached
    await service.submitComplaint(body('r9', 10));
    const after = await service.listActive();
    expect(after[0].incident.complaintCount).toBe(4); // a write always re-runs
    clock.advance(1);
    const mid = lists;
    await service.listActive();
    expect(lists).toBeGreaterThan(mid); // the fake clock moved 60 s, past the 10 s TTL: detection runs again
  });
});
