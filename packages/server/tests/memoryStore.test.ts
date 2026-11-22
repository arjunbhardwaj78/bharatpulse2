import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memoryStore.js';
import { T0, failure, fakeStored } from './helpers.js';

const c = (id: string, createdAt: number) => ({ id, reporterId: 'r', issueType: 'NO_WATER' as const, lat: 27.49, lng: 77.67, createdAt });

describe('MemoryStore', () => {
  it('returns complaints since a time, oldest first', async () => {
    const store = new MemoryStore();
    await store.addComplaint(c('late', T0 + 20));
    await store.addComplaint(c('early', T0 + 10));
    await store.addComplaint(c('old', T0 - 5));
    const got = await store.complaintsSince(T0);
    expect(got.map((x) => x.id)).toEqual(['early', 'late']);
  });

  it('rejects a duplicate complaint id', async () => {
    const store = new MemoryStore();
    await store.addComplaint(c('a', T0));
    const err = await failure(store.addComplaint(c('a', T0)));
    expect(err instanceof Error).toBe(true);
  });

  it('saves incidents by id (insert, then replace) and reads them back', async () => {
    const store = new MemoryStore();
    await store.saveIncidents([fakeStored('i1', ['a', 'b', 'c'])]);
    await store.saveIncidents([fakeStored('i1', ['a', 'b', 'c', 'd'])]);
    const all = await store.listIncidents();
    expect(all).toHaveLength(1);
    expect(all[0].incident.complaintCount).toBe(4);
    expect((await store.getIncident('i1'))?.incident.id).toBe('i1');
    expect(await store.getIncident('nope')).toBeUndefined();
  });

  it('hands out copies: changing a result does not change the store', async () => {
    const store = new MemoryStore();
    await store.saveIncidents([fakeStored('i1', ['a', 'b', 'c'])]);
    const copy = (await store.getIncident('i1'))!;
    copy.status = 'resolved';
    expect((await store.getIncident('i1'))!.status).toBe('open');
  });
});
