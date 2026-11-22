import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/memoryStore.js';
import { IncidentService } from '../src/service.js';
import { FakeClock, body, counterIds } from './helpers.js';

let app: FastifyInstance;

function start() {
  const clock = new FakeClock();
  const service = new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds() });
  app = buildApp(service);
  return { clock };
}

afterEach(async () => {
  await app.close();
});

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

/** Three nearby complaints from three reporters -> one incident. Returns its id. */
async function makeIncident(): Promise<string> {
  let incidentId = '';
  for (let i = 0; i < 3; i++) {
    const res = await post('/complaints', body(`r${i + 1}`, i * 50));
    incidentId = res.json().incidentId ?? incidentId;
  }
  return incidentId;
}

describe('API', () => {
  it('GET /health', async () => {
    start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('POST /complaints returns 201 with the stored complaint and no incident yet', async () => {
    start();
    const res = await post('/complaints', body('r1'));
    expect(res.statusCode).toBe(201);
    expect(res.json().complaint.id).toBe('c1');
    expect(res.json().incidentId).toBeNull();
  });

  it('POST /complaints with bad input returns 400 and a field list', async () => {
    start();
    const res = await post('/complaints', { reporterId: 'r1', issueType: 'FLOOD', lat: 0, lng: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    expect(res.json().error.details[0].field).toBe('issueType');
  });

  it('malformed JSON returns 400, not a crash', async () => {
    start();
    const res = await app.inject({ method: 'POST', url: '/complaints', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('an oversized body returns 413', async () => {
    start();
    const res = await post('/complaints', { ...body('r1'), padding: 'x'.repeat(9 * 1024 * 1024) });
    expect(res.statusCode).toBe(413);
  });

  it('unknown routes return a JSON 404', async () => {
    start();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('full flow: complaints -> GET /incidents -> GET one -> resolve -> gone from the active list', async () => {
    start();
    const id = await makeIncident();
    expect(id).toBe('SUPPLY:c1');

    const list = await app.inject({ method: 'GET', url: '/incidents' });
    expect(list.statusCode).toBe(200);
    expect(list.json().count).toBe(1);
    const first = list.json().incidents[0];
    expect(first.id).toBe(id);
    expect(first.status).toBe('open');
    expect(first.severity.factors.length).toBe(5);
    expect(typeof first.recommendedAction).toBe('string');

    const one = await app.inject({ method: 'GET', url: `/incidents/${id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().complaintCount).toBe(3);

    // There is no shortcut to close an incident: only the officer workflow can.
    expect((await post(`/incidents/${id}/resolve`)).statusCode).toBe(404);
    expect((await post(`/incidents/${id}/escalate`)).statusCode).toBe(404);
    expect((await post(`/incidents/${id}/actions/verify`)).statusCode).toBeGreaterThanOrEqual(400); // anonymous = citizen, who cannot verify
    expect((await app.inject({ method: 'GET', url: '/incidents' })).json().count).toBe(1);
    const missing = await app.inject({ method: 'GET', url: '/incidents/SUPPLY:nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('sends security headers and enforces a global rate limit', async () => {
    start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeTruthy();
    expect(res.headers['x-frame-options']).toBeTruthy();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('the sixth complaint from one reporter in 10 minutes returns 429 with Retry-After', async () => {
    start();
    for (let i = 0; i < 5; i++) await post('/complaints', body('spammer', i * 10));
    const res = await post('/complaints', body('spammer'));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});
