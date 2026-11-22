import { describe, expect, it } from 'vitest';
import type { City, Incident } from '../src/api';
import { twinModel } from '../src/twinModel';

const C = { lat: 27.89, lng: 77.37 };
const at = (id: string, zoneId: string, dLat: number, dLng: number) => ({ id, name: `Ward ${id.slice(1)}`, zoneId, lat: C.lat + dLat, lng: C.lng + dLng });
const city: City = {
  zones: [{ id: 'Z1', name: 'Z1', feeds: ['Z2', 'Z3'] }, { id: 'Z2', name: 'Z2', feeds: ['Z4'] }, { id: 'Z3', name: 'Z3', feeds: [] }, { id: 'Z4', name: 'Z4', feeds: [] }],
  localities: [at('L1', 'Z1', 0, 0), at('L3', 'Z2', 0.008, 0), at('L5', 'Z3', -0.006, 0.004), at('L7', 'Z4', 0.014, 0.003)],
  facilities: [],
  assets: [
    { id: 'T1', kind: 'TANK', name: 'Tank', lat: C.lat - 0.002, lng: C.lng - 0.002, feeds: ['M1'], supplies: [] },
    { id: 'M1', kind: 'PIPE', name: 'Trunk', lat: C.lat, lng: C.lng, feeds: ['M2', 'M3'], supplies: ['Z1'] },
    { id: 'M2', kind: 'PIPE', name: 'North feeder', lat: C.lat + 0.006, lng: C.lng, feeds: ['M4'], supplies: ['Z2'] },
    { id: 'M3', kind: 'PIPE', name: 'South feeder', lat: C.lat - 0.005, lng: C.lng, feeds: [], supplies: ['Z3'] },
    { id: 'M4', kind: 'PIPE', name: 'North ext', lat: C.lat + 0.012, lng: C.lng, feeds: [], supplies: ['Z4'] },
  ],
};
const inc = (id: string, w: { lat: number; lng: number }, held = false): Incident => ({ id, family: 'SUPPLY', complaintCount: 9, centroid: { lat: w.lat, lng: w.lng }, radiusMeters: 100, firstReportedAt: 0, lastReportedAt: 0, issueBreakdown: { NO_WATER: 9 }, recommendedAction: '', status: 'open', severity: { score: 61.4, level: 'HIGH', base: 0, credibility: 1, factors: [] }, trust: { rawReports: 9, independentSources: held ? 1 : 8, trustedSources: 8, nEff: 8, credibility: 1, needsVerification: held, bands: { TRUSTED: 0, UNCERTAIN: 0, LIKELY_FAKE: 0 }, authenticity: [] } } as unknown as Incident);

describe('twin model', () => {
  it('traces outages in two zones to the feeder they share, stops the water past it, warns the rest', () => {
    const m = twinModel(city, [inc('a', city.localities[1]), inc('b', city.localities[3])]);
    expect(m.suspect?.name).toBe('North feeder');
    expect(m.pipes.filter((p) => p.from === 'M2').every((p) => p.state === 'suspect')).toBe(true);
    expect(m.pipes.filter((p) => p.from === 'M4').every((p) => p.state === 'dry')).toBe(true);
    expect(m.wards.find((w) => w.id === 'L3')?.state).toBe('hit');
    expect(m.beacons[0].score).toBe(61);
  });
  it('held (possibly fake) outages do not point at a pipe', () => {
    const m = twinModel(city, [inc('a', city.localities[1], true), inc('b', city.localities[3], true)]);
    expect(m.suspect).toBeUndefined();
    expect(m.beacons.every((b) => b.held)).toBe(true);
  });
  it('one outage upstream puts the wards below it at risk', () => {
    const m = twinModel(city, [inc('a', city.localities[0]), inc('b', city.localities[2])]); // Z1 + Z3 -> trunk
    expect(m.suspect?.name).toBe('Trunk');
    expect(m.atRisk.sort()).toEqual(['Ward 3', 'Ward 7']);
  });
});
