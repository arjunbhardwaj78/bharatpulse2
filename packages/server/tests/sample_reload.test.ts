import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memoryStore.js';
import { IncidentService } from '../src/service.js';

describe('Load sample town twice', () => {
  it('the demo city starts it again fresh instead of failing with a 500', async () => {
    const s = new IncidentService(new MemoryStore(), {});
    const first = await s.loadSample({ replace: true });
    const n = (await s.listAll()).length;
    expect(await s.loadSample({ replace: true })).toBe(first);
    expect((await s.listAll()).length).toBe(n);
  });
  it('a real city is refused with a clear message, and its data is kept', async () => {
    const s = new IncidentService(new MemoryStore(), {});
    await s.loadSample();
    const n = (await s.listAll()).length;
    await expect(s.loadSample()).rejects.toMatchObject({ statusCode: 409, code: 'sample_already_loaded' });
    expect((await s.listAll()).length).toBe(n);
  });
});
