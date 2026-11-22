import { HOUR } from '@bharatpulse/engine';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memoryStore.js';
import { IncidentService, type ServiceOptions } from '../src/service.js';
import { FakeClock, T0, body, counterIds, failure } from './helpers.js';

function setup(opts: ServiceOptions = {}) {
  const clock = new FakeClock();
  const store = new MemoryStore();
  const service = new IncidentService(store, { clock: clock.now, idGenerator: counterIds(), ...opts });
  return { clock, store, service };
}

/** Submits `n` NO_WATER complaints from fresh reporters, `north` metres north, returns the last result. */
async function report(service: IncidentService, prefix: string, n: number, north = 0, type = 'NO_WATER') {
  let last;
  for (let i = 0; i < n; i++) last = await service.submitComplaint(body(`${prefix}${i + 1}`, north + i * 50, type));
  return last!;
}

describe('IncidentService: complaints become incidents', () => {
  it('stays isolated until three nearby complaints exist, then forms one incident', async () => {
    const { service } = setup();
    expect((await service.submitComplaint(body('r1'))).incidentId).toBeNull();
    expect((await service.submitComplaint(body('r2', 50))).incidentId).toBeNull();
    const third = await service.submitComplaint(body('r3', 100));
    expect(third.incidentId).toBe('SUPPLY:c1');
    expect(third.complaint.id).toBe('c3');
  });

  it('keeps the same incident id as more complaints arrive', async () => {
    const { service } = setup();
    const third = await report(service, 'r', 3);
    const fourth = await service.submitComplaint(body('r4', 150));
    expect(fourth.incidentId).toBe(third.incidentId);
    const list = await service.listActive();
    expect(list).toHaveLength(1);
    expect(list[0].incident.complaintCount).toBe(4);
  });

  it('keeps the id when the earliest complaint ages out of the window', async () => {
    const { service, clock } = setup({ windowMs: 4 * HOUR });
    await report(service, 'a', 3); // t=0 -> incident SUPPLY:c1
    clock.advance(120);
    await service.submitComplaint(body('b1'));
    await service.submitComplaint(body('b2', 50)); // c4, c5
    clock.advance(150); // t=4.5h: c1..c3 are now outside the 4h window
    const last = await service.submitComplaint(body('b3', 100)); // c6
    const list = await service.listActive();
    expect(list).toHaveLength(1);
    expect(list[0].incident.id).toBe('SUPPLY:c1');
    expect(list[0].incident.complaintIds).toEqual(['c4', 'c5', 'c6']);
    expect(list[0].detectedAt).toBe(T0);
    expect(last.incidentId).toBe('SUPPLY:c1');
  });

  it('merges two outages that grow together; the older incident survives', async () => {
    const { service, clock } = setup();
    await report(service, 'a', 3, 0); // c1..c3 north 0..100
    clock.advance(1);
    await report(service, 'b', 3, 1500); // c4..c6
    expect(await service.listActive()).toHaveLength(2);

    await service.submitComplaint(body('x1', 500)); // bridge complaints
    await service.submitComplaint(body('x2', 900));
    await service.submitComplaint(body('x3', 1300));

    const list = await service.listActive();
    expect(list).toHaveLength(1);
    expect(list[0].incident.id).toBe('SUPPLY:c1');
    expect(list[0].incident.complaintCount).toBe(9);
    const absorbed = await service.getIncident('SUPPLY:c4');
    expect(absorbed.status).toBe('merged');
    expect(absorbed.mergedInto).toBe('SUPPLY:c1');
  });

  it('never mixes issue families: dirty water is its own incident', async () => {
    const { service } = setup();
    await report(service, 's', 3, 0, 'NO_WATER');
    await report(service, 'd', 3, 0, 'DIRTY_WATER');
    const list = await service.listActive();
    expect(list.map((s) => s.incident.family).sort()).toEqual(['QUALITY', 'SUPPLY']);
  });

  it('lists the most severe incident first', async () => {
    const { service } = setup();
    await report(service, 'small', 3, 0);
    await report(service, 'big', 6, 5000);
    const list = await service.listActive();
    expect(list).toHaveLength(2);
    expect(list[0].incident.complaintCount).toBe(6);
    expect(list[0].incident.severity.score).toBeGreaterThan(list[1].incident.severity.score);
  });
});

describe('IncidentService: officer actions and lifecycle', () => {
  it('resolve closes an incident; later complaints form a NEW incident, not a revival', async () => {
    const { service } = setup();
    const first = await report(service, 'a', 3);
    const resolved = await service.resolve(first.incidentId!);
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('manual');
    expect(await service.listActive()).toHaveLength(0);

    expect((await service.submitComplaint(body('n1'))).incidentId).toBeNull();
    expect((await service.submitComplaint(body('n2', 50))).incidentId).toBeNull();
    const third = await service.submitComplaint(body('n3', 100));
    expect(third.incidentId).not.toBeNull();
    expect(third.incidentId).not.toBe(first.incidentId);
    const list = await service.listActive();
    expect(list).toHaveLength(1);
    expect(list[0].incident.complaintCount).toBe(3);
  });

  it('resolving twice, or an unknown id, gives clean errors', async () => {
    const { service } = setup();
    const first = await report(service, 'a', 3);
    await service.resolve(first.incidentId!);
    const again = await failure(service.resolve(first.incidentId!));
    expect(again.statusCode).toBe(409);
    expect(again.code).toBe('incident_resolved');
    const missing = await failure(service.resolve('SUPPLY:nope'));
    expect(missing.statusCode).toBe(404);
  });

  it('escalated status survives new complaints', async () => {
    const { service } = setup();
    const first = await report(service, 'a', 3);
    await service.escalate(first.incidentId!);
    await service.submitComplaint(body('a4', 150));
    const found = await service.getIncident(first.incidentId!);
    expect(found.status).toBe('escalated');
    expect(found.incident.complaintCount).toBe(4);
  });

  it('cannot act on a merged incident', async () => {
    const { service } = setup();
    await report(service, 'a', 3, 0);
    await report(service, 'b', 3, 1500);
    await service.submitComplaint(body('x1', 500));
    await service.submitComplaint(body('x2', 900));
    await service.submitComplaint(body('x3', 1300));
    const err = await failure(service.resolve('SUPPLY:c4'));
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('incident_merged');
  });

  it('expires an incident when every complaint has left the window', async () => {
    const { service, clock } = setup({ windowMs: 4 * HOUR });
    const first = await report(service, 'a', 3);
    clock.advance(5 * 60);
    expect(await service.listActive()).toHaveLength(0);
    const found = await service.getIncident(first.incidentId!);
    expect(found.status).toBe('resolved');
    expect(found.resolution).toBe('expired');
  });
});

describe('IncidentService: input checks and rate limiting', () => {
  it('rejects bad input with every problem listed', async () => {
    const { service } = setup();
    const err = await failure(service.submitComplaint({ reporterId: '', issueType: 'FLOOD', lat: 999, lng: 'x' }));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('validation_error');
    expect((err.details as unknown[]).length).toBe(3);
  });

  it('rejects a non-object body', async () => {
    const { service } = setup();
    expect((await failure(service.submitComplaint('hello'))).statusCode).toBe(400);
    expect((await failure(service.submitComplaint(null))).statusCode).toBe(400);
  });

  it('refuses client-supplied timestamps by default', async () => {
    const { service } = setup();
    const err = await failure(service.submitComplaint({ ...body('r1'), createdAt: T0 - 1000 }));
    expect(err.statusCode).toBe(400);
  });

  it('accepts client timestamps only when enabled, and only inside the window', async () => {
    const { service } = setup({ allowClientTimestamps: true });
    const ok = await service.submitComplaint({ ...body('r1'), createdAt: T0 - 600_000 });
    expect(ok.complaint.createdAt).toBe(T0 - 600_000);
    const tooOld = await failure(service.submitComplaint({ ...body('r2'), createdAt: T0 - 16 * 24 * HOUR }));
    expect(tooOld.statusCode).toBe(400);
    const future = await failure(service.submitComplaint({ ...body('r3'), createdAt: T0 + HOUR }));
    expect(future.statusCode).toBe(400);
  });

  it('limits one reporter to 5 complaints per 10 minutes, then allows again', async () => {
    const { service, clock } = setup();
    for (let i = 0; i < 5; i++) await service.submitComplaint(body('spammer', i * 10));
    const err = await failure(service.submitComplaint(body('spammer')));
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(await service.submitComplaint(body('someone-else'))).toBeTruthy();
    clock.advance(11);
    expect(await service.submitComplaint(body('spammer'))).toBeTruthy();
  });
});
