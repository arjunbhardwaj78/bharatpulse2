import { detectIncidents } from '@bharatpulse/engine';
import { describe, expect, it } from 'vitest';
import { CITY } from '../src/data.js';
import { buildSubgraph, downstream, findCause } from '../src/graph.js';
import { genuineOutage, replayOutage, rng, SCENARIOS, deviceAttack } from '../src/scenarios.js';
import { fakeStored, T0 } from './helpers.js';

const at = { lat: 27.4924, lng: 77.6737 };
const o = (n: number, prefix = 's') => ({ n, at, now: T0, r: rng(3), prefix });

describe('downstream', () => {
  it('follows FEEDS breadth-first and respects the hop limit', () => {
    expect(downstream(CITY, 'Z1', 3).map((d) => [d.zone, d.hops])).toEqual([['Z2', 1], ['Z3', 1], ['Z4', 2]]);
    expect(downstream(CITY, 'Z1', 1).map((d) => d.zone)).toEqual(['Z2', 'Z3']);
    expect(downstream(CITY, 'Z4', 3)).toEqual([]);
    expect(downstream(CITY, 'Z2', 3)[0].localities).toEqual(['L7', 'L8']);
  });
});

describe('subgraph', () => {
  it('flags a device shared by more than two reporters', () => {
    const cs = deviceAttack({ ...o(12), devices: 3 });
    const g = buildSubgraph('inc', cs, cs);
    expect(g.sharedDevices).toHaveLength(3);
    expect(g.sharedDevices.every((d) => d.reporters === 4)).toBe(true);
    expect(g.edges.filter((e) => e.type === 'FROM_DEVICE')).toHaveLength(12);
  });
  it('finds no shared device among honest reporters', () => {
    const cs = genuineOutage(o(20));
    expect(buildSubgraph('inc', cs, cs).sharedDevices).toEqual([]);
  });
});

describe('findCause', () => {
  const leak = fakeStored('leak', ['a', 'b', 'c'], { family: 'INFRASTRUCTURE' });
  const road = (offsetDeg: number) => ({ ...fakeStored('road', ['d', 'e'], { family: 'ROAD' }), incident: { ...fakeStored('road', ['d', 'e'], { family: 'ROAD' }).incident, centroid: { lat: at.lat + offsetDeg, lng: at.lng }, firstReportedAt: T0 + 3_600_000 } });
  it('links within 100 m, not beyond, and only roads', () => {
    expect(findCause(road(0.0005), [leak])).toMatchObject({ incidentId: 'leak' });
    expect(findCause(road(0.002), [leak])).toBeUndefined();
    expect(findCause(leak, [leak])).toBeUndefined();
  });
});

describe('scenarios', () => {
  it('are reproducible for the same seed', () => expect(genuineOutage(o(10))).toEqual(genuineOutage(o(10))));

  it('make the outage replay rise from nothing to a trusted incident', () => {
    expect(replayOutage(0).incident).toBeNull();
    const end = replayOutage(120);
    expect(end.reports).toBe(40);
    expect(end.incident).toMatchObject({ needsVerification: false });
    expect(replayOutage(60).reports).toBeLessThan(end.reports);
  });

  it('are caught when naive and left alone when genuine', () => {
    const needs = (cs: ReturnType<typeof genuineOutage>) => detectIncidents(cs, T0).incidents[0].trust.needsVerification;
    expect(needs(SCENARIOS.attack(o(40)))).toBe(true);
    expect(needs(SCENARIOS.simfarm(o(40)))).toBe(true);
    expect(needs(SCENARIOS.photo(o(30)))).toBe(true);
    expect(needs(SCENARIOS.outage(o(40)))).toBe(false);
  });
});
