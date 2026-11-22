import { describe, expect, it } from 'vitest';
import { Auth } from '../src/auth.js';
import { MemoryStore } from '../src/memoryStore.js';
import { IncidentService } from '../src/service.js';
import { BASE, FakeClock, T0, body, counterIds, failure } from './helpers.js';

const MIN = 60_000;
const setup = () => {
  const clock = new FakeClock();
  const auth = new Auth('salt', '123456', clock.now);
  const service = new IncidentService(new MemoryStore(), { clock: clock.now, idGenerator: counterIds(), auth });
  return { clock, auth, service };
};
// Five different households reporting within a few minutes: one trusted incident.
async function outage(service: IncidentService, clock: FakeClock, type = 'NO_WATER', north = 0) {
  let incidentId: string | null = null;
  for (let i = 0; i < 5; i++) {
    incidentId = (await service.submitComplaint(body(`h${type}${north}${i}`, north + i * 20, type))).incidentId;
    clock.advance(1);
  }
  return incidentId as string;
}

describe('workflow through the service', () => {
  it('runs an incident from report to closed and issues certificates only after confirmation', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    const officer = (action: string, role: string, extra = {}) => service.act(id, { action, role: role as never, ...extra });
    for (const [a, r] of [['verify', 'L1'], ['approve', 'L2'], ['assign', 'L2'], ['start', 'L1']] as const) await officer(a, r);
    expect((await service.certificate(id, 'hNO_WATER00')).valid).toBe(false);

    expect((await failure(officer('resolve', 'L1'))).code).toBe('validation_error'); // proof photo needed
    expect((await officer('resolve', 'L1', { proofHash: 'ph' })).workflow?.stage).toBe('PROOF_REVIEW'); // a senior officer must check the photo
    expect((await failure(officer('approve-proof', 'L1'))).statusCode).toBe(403);
    expect((await officer('approve-proof', 'L2')).status).toBe('resolved');
    expect((await failure(service.act(id, { action: 'confirm', role: 'CITIZEN' }, 'someone-else'))).statusCode).toBe(403);
    expect((await service.act(id, { action: 'confirm', role: 'CITIZEN' }, 'hNO_WATER00')).workflow?.stage).toBe('CONFIRMED');
    expect(await service.certificate(id, 'hNO_WATER00')).toMatchObject({ valid: true, role: 'First Reporter' });
    expect((await service.certificate(id, 'hNO_WATER04')).valid).toBe(false); // reported later, did not confirm via me-too
    expect((await service.certificate(id, 'nobody')).valid).toBe(false);
  });

  it('a citizen can reopen a fix that did not hold, and the incident is active again one level up', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    for (const [a, r, x] of [['verify', 'L1', {}], ['approve', 'L2', {}], ['assign', 'L2', {}], ['resolve', 'L1', { proofHash: 'p' }], ['approve-proof', 'L2', {}]] as const) await service.act(id, { action: a, role: r, ...x });
    const reopened = await service.act(id, { action: 'reopen', role: 'CITIZEN' }, 'hNO_WATER01');
    expect([reopened.status, reopened.workflow?.stage, reopened.workflow?.level]).toEqual(['open', 'ASSIGNED', 2]);
  });

  it('a final rejection can be disputed once and overturned, which brings the incident back', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    await service.act(id, { action: 'reject', role: 'L1', reason: 'looks fake' });
    expect((await service.act(id, { action: 'approve-rejection', role: 'L2' })).status).toBe('resolved');
    const disputed = await service.act(id, { action: 'dispute', role: 'CITIZEN' }, 'hNO_WATER02');
    expect([disputed.status, disputed.workflow?.level]).toEqual(['open', 3]);
    const back = await service.act(id, { action: 'decide-dispute', role: 'L3', decision: 'overturn' });
    expect(back.workflow?.stage).toBe('VERIFIED');
  });

  it('upholding a dispute counts against the citizen who raised it', async () => {
    const { service, clock, auth } = setup();
    const phone = '9876543210';
    const { reporterId } = auth.verify(phone, '123456');
    let id = '';
    for (let i = 0; i < 4; i++) id = (await service.submitComplaint(body(i === 0 ? reporterId : `x${i}`, i * 20))).incidentId ?? id;
    await service.act(id, { action: 'reject', role: 'L1', reason: 'r' });
    await service.act(id, { action: 'approve-rejection', role: 'L2' });
    await service.act(id, { action: 'dispute', role: 'CITIZEN' }, reporterId);
    await service.act(id, { action: 'decide-dispute', role: 'L3', decision: 'uphold' });
    expect((await service.profile(reporterId)).lostDisputes).toBe(1);
  });

  it('escalates a missed deadline one level when someone next looks', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    expect((await service.getIncident(id)).workflow?.level).toBe(1);
    clock.advance(24 * 60); // a day later: past any water SLA
    expect((await service.getIncident(id)).workflow?.level).toBeGreaterThanOrEqual(2);
  });
});

describe('me-too', () => {
  const near = { lat: BASE.lat + 0.0003, lng: BASE.lng };
  it('adds one confirmation per reporter, nearby only, and never for your own report', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    const before = (await service.getIncident(id)).incident.complaintCount;
    const after = await service.metoo('neighbour', id, near.lat, near.lng);
    expect(after.incident.complaintCount).toBe(before + 1);
    expect((await failure(service.metoo('neighbour', id, near.lat, near.lng))).code).toBe('already_confirmed');
    expect((await failure(service.metoo('far', id, BASE.lat + 0.05, BASE.lng))).code).toBe('too_far');
    expect((await failure(service.metoo('hNO_WATER00', id, near.lat, near.lng))).code).toBe('own_report');
  });

  it('turns a confirmer into a Verified Contributor once the fix is confirmed', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    await service.metoo('neighbour', id, near.lat, near.lng);
    for (const [a, r, x] of [['verify', 'L1', {}], ['approve', 'L2', {}], ['assign', 'L2', {}], ['resolve', 'L1', { proofHash: 'p' }], ['approve-proof', 'L2', {}]] as const) await service.act(id, { action: a, role: r, ...x });
    await service.act(id, { action: 'confirm', role: 'CITIZEN' }, 'hNO_WATER00');
    expect(await service.certificate(id, 'neighbour')).toMatchObject({ valid: true, role: 'Verified Contributor' });
  });
});

describe('leak causing a pothole', () => {
  it('links a pothole incident within 100 m of a recent leak incident', async () => {
    const { service, clock } = setup();
    const leak = await outage(service, clock, 'LEAK', 0);
    const roads: string[] = [];
    for (let i = 0; i < 3; i++) roads.push((await service.submitComplaint(body(`rd${i}`, 60 + i * 5, 'POTHOLE'))).incidentId ?? '');
    const road = await service.getIncident(roads[2]);
    expect(road.incident.family).toBe('ROAD');
    expect(road.possibleCause).toMatchObject({ incidentId: leak });
    expect(road.possibleCause!.distanceM).toBeLessThanOrEqual(100);
  });
});

describe('stats and graph', () => {
  it('counts open incidents and builds the incident graph', async () => {
    const { service, clock } = setup();
    const id = await outage(service, clock);
    expect(await service.stats()).toMatchObject({ open: 1, needsVerification: 0 });
    const g = await service.subgraph(id);
    expect(g.nodes.filter((n) => n.type === 'Reporter')).toHaveLength(5);
    expect((await service.downstream('Z1', 3)).map((d) => d.zone)).toEqual(['Z2', 'Z3', 'Z4']);
    expect(T0).toBeGreaterThan(0);
  });
});
