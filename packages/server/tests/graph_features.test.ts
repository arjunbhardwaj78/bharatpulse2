import { describe, expect, it } from 'vitest';
import { CITY } from '../src/data.js';
import { linksFrom, reach, ringsFrom } from '../src/graph.js';
import { MemoryStore } from '../src/memoryStore.js';
import { genuineOutage, rng, travellingCrowd } from '../src/scenarios.js';
import { IncidentService } from '../src/service.js';
import { BASE } from './helpers.js';

const NOW = Date.UTC(2026, 10, 21, 12, 0);
const DAY = 86_400_000;

describe('water network', () => {
  it('knows which zones each asset feeds, nearest first', () => {
    expect([...reach(CITY, 'M2')]).toEqual([['Z2', 1], ['Z4', 2]]);
    expect(reach(CITY, 'T1').get('Z4')).toBe(5); // tank -> pump -> trunk -> north feeder -> extension -> Zone 4
  });
});

describe('rings', () => {
  it('needs 3+ linked accounts: two people sharing one phone is a family, not a ring', () => {
    expect(ringsFrom([{ a: 'x', b: 'y', via: 'DEVICE' }])).toEqual([]);
    const r = ringsFrom([{ a: 'x', b: 'y', via: 'DEVICE' }, { a: 'y', b: 'z', via: 'PHOTO' }]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ accounts: ['x', 'y', 'z'], via: ['DEVICE', 'PHOTO'] }); // linked through a chain
  });

  it('does NOT link neighbours who report the same street twice', async () => {
    const service = new IncidentService(new MemoryStore(), { clock: () => NOW });
    const street = (prefix: string, now: number) => genuineOutage({ n: 8, at: BASE, now, r: rng(3), prefix, radiusM: 100 }).map((c, i) => ({ ...c, reporterId: `home${i}` }));
    await service.ingestDemo(street('w1-', NOW - 7 * DAY));
    await service.ingestDemo(street('w2-', NOW));
    expect((await service.rings()).rings).toEqual([]);
    const now = (await service.listActive()).find((s) => s.incident.complaintIds[0].startsWith('w2-'))!;
    expect(now.incident.trust.needsVerification).toBe(false);
  });

  it('catches a crowd that comes back somewhere else, and counts it as one person', async () => {
    const service = new IncidentService(new MemoryStore(), { clock: () => NOW });
    const first = await service.ingestDemo(travellingCrowd({ n: 12, at: BASE, now: NOW - 2 * DAY, r: rng(1), prefix: 'a-', crowd: 'c' }));
    expect(first[0].incident.trust.needsVerification).toBe(false); // alone, a careful crowd looks real
    const after = await service.ingestDemo(travellingCrowd({ n: 12, at: { lat: BASE.lat + 0.03, lng: BASE.lng }, now: NOW, r: rng(2), prefix: 'b-', crowd: 'c' }));
    const second = after.find((s) => s.incident.complaintIds[0].startsWith('b-'))!;
    expect(second.incident.trust.needsVerification).toBe(true);
    expect(second.incident.trust.independentSources).toBe(1);
    expect(second.incident.trust.authenticity[0].signals.map((s) => s.code)).toContain('GRAPH_RING');
    const { rings, targets } = await service.rings();
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ via: ['CO_REPORTING'] });
    expect(rings[0].accounts).toHaveLength(12);
    expect(targets.map((t) => t.incident)).toContain(second.incident.id);
    expect(linksFrom([], [])).toEqual([]);
  });
});

describe('sample town', () => {
  it('traces the two real outages to the North feeder, warns the wards it also feeds, and finds every ring', async () => {
    const service = new IncidentService(new MemoryStore(), { clock: () => NOW });
    await service.loadSample();
    const root = await service.rootCause();
    expect(root.zonesHit).toEqual(['Z2', 'Z4']);
    expect(root.suspects[0]).toMatchObject({ assetId: 'M2', covers: ['Z2', 'Z4'] });
    expect(root.atRisk.map((w) => w.localityId)).toEqual(['L4', 'L7']);
    const { rings } = await service.rings();
    expect(rings.some((r) => r.via.includes('CO_REPORTING') && r.accounts.length === 10)).toBe(true);
    expect(rings.filter((r) => r.via.includes('DEVICE'))).toHaveLength(3);
    const stats = await service.stats();
    expect(stats.avgHoursToResolve).toBeGreaterThan(5); // realistic timelines, not "0 h"
    const o = await service.overview();
    expect(o.nodes.filter((n) => n.type === 'Asset')).toHaveLength(6);
    expect(o.edges.some((e) => e.type === 'TARGETS')).toBe(true);
  });

  it('answers questions from the graph without any AI (keyword routing)', async () => {
    const service = new IncidentService(new MemoryStore(), { clock: () => NOW });
    await service.loadSample();
    const why = await service.ask('Why is there no water in Ward 3 and Ward 8?');
    expect(why).toMatchObject({ tool: 'root_cause', via: { understood: 'keywords', worded: 'template' } });
    expect(why.answer).toContain('North feeder');
    expect(why.cypher[0]).toContain('MATCH p = (a:Asset {tenant: $tenant})');
    expect((await service.ask('फर्जी शिकायतें कौन कर रहा है?')).tool).toBe('fraud_rings');
    expect((await service.ask('ward 5 ka haal')).tool).toBe('ward_status');
    expect((await service.ask('what happens downstream if zone 1 fails')).args).toEqual({ zone: 'Z1' });
  });
});
