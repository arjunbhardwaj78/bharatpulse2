import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/memoryStore.js';
import { Officers } from '../src/officers.js';
import { IncidentService } from '../src/service.js';
import { CITY } from '../src/data.js';

describe('what if this pipe fails (Q.atRisk from any asset)', () => {
  const app = buildApp(new IncidentService(new MemoryStore()), {}, { officers: new Officers('pw') });
  const signIn = async () => (await app.inject({ method: 'POST', url: '/officer/login', payload: { id: 'zonal1', password: 'pw' } })).json().token as string;

  it('lists the wards a feeder serves, with its zones and the Cypher', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/M2/impact', headers: { 'x-officer': await signIn() } });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.asset).toMatchObject({ id: 'M2' });
    const fed = new Set((CITY.assets ?? []).find((a) => a.id === 'M2')!.supplies);
    expect(b.wards.length).toBeGreaterThan(0);
    expect(b.wards.every((w: { zone: string }) => fed.has(w.zone) || b.zones.some((z: { id: string }) => z.id === w.zone))).toBe(true);
    expect(b.cypher[0]).toContain('FEEDS|SUPPLIES');
  });
  it('the main tank reaches every ward on the network; an unknown asset is a 404; officers only', async () => {
    const t = await signIn();
    const tank = (CITY.assets ?? []).find((a) => a.kind === 'TANK')!;
    const all = (await app.inject({ method: 'GET', url: `/assets/${tank.id}/impact`, headers: { 'x-officer': t } })).json();
    expect(all.wards.length).toBeGreaterThanOrEqual((await app.inject({ method: 'GET', url: '/assets/M2/impact', headers: { 'x-officer': t } })).json().wards.length);
    expect((await app.inject({ method: 'GET', url: '/assets/NOPE/impact', headers: { 'x-officer': t } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/assets/M2/impact' })).statusCode).toBe(401);
  });
});
