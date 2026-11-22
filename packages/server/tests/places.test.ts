import { describe, expect, it } from 'vitest';
import { OFFICERS, Officers } from '../src/officers.js';
import { makePlaceFinder, makePlaceSearch } from '../src/places.js';

const here = { lat: 27.894, lng: 77.369 };
const reply = (routes: Record<string, unknown>, seen: string[] = []) => (async (url: string) => {
  seen.push(url);
  const hit = Object.entries(routes).find(([k]) => url.includes(k));
  return hit ? new Response(JSON.stringify(hit[1])) : new Response('{}', { status: 500 });
}) as unknown as typeof fetch;

describe('place finder', () => {
  const nominatim = { 'nominatim.openstreetmap.org': { display_name: 'Lane 4, Hodal, Palwal, Haryana' } };

  it('uses Google when a key is set, nearest office first', async () => {
    const seen: string[] = [];
    const find = makePlaceFinder({ googleKey: 'k', fetchFn: reply({ ...nominatim, 'places.googleapis.com': { places: [
      { displayName: { text: 'Far office' }, formattedAddress: 'Far road', nationalPhoneNumber: '011 111', location: { latitude: 27.95, longitude: 77.4 } },
      { displayName: { text: 'Nagar Palika Hodal' }, formattedAddress: 'Main Road, Hodal', nationalPhoneNumber: '01275 222222', location: { latitude: 27.895, longitude: 77.37 } },
    ] } }, seen) });
    const r = await find(here.lat, here.lng, 'WATER');
    expect(r.address).toBe('Lane 4, Hodal, Palwal, Haryana');
    expect(r.offices.map((o) => [o.name, o.phone, o.source])).toEqual([['Nagar Palika Hodal', '01275 222222', 'google'], ['Far office', '011 111', 'google']]);
    expect(seen.some((u) => u.includes('overpass'))).toBe(false);
  });

  it('falls back to OpenStreetMap, prefers offices that match the problem, and tolerates a missing phone', async () => {
    const find = makePlaceFinder({ fetchFn: reply({ ...nominatim, 'overpass-api.de': { elements: [
      { lat: 27.8945, lon: 77.3695, tags: { name: 'Nagar Palika Parishad', office: 'government', phone: '+91 1275 123456', 'addr:street': 'Main Road', 'addr:city': 'Hodal' } },
      { lat: 27.8946, lon: 77.3696, tags: { name: 'Tehsil Office', office: 'government' } },
      { center: { lat: 27.9, lon: 77.4 }, tags: { name: 'PWD Division', office: 'government' } },
    ] } }) });
    const water = await find(here.lat, here.lng, 'WATER');
    expect(water.offices.map((o) => o.name)).toEqual(['Nagar Palika Parishad']);
    expect(water.offices[0]).toMatchObject({ phone: '+91 1275 123456', address: 'Main Road, Hodal', source: 'osm' });
    const roads = await find(here.lat + 0.1, here.lng, 'ROADS');
    expect(roads.offices.find((o) => o.name === 'Tehsil Office')).toBeUndefined();
  });

  it('survives provider failures and caches good answers for a day', async () => {
    let calls = 0;
    let clock = 0;
    const find = makePlaceFinder({ now: () => clock, fetchFn: (async (url: string) => { calls++; return url.includes('nominatim') ? new Response(JSON.stringify({ display_name: 'Somewhere' })) : new Response('{}', { status: 503 }); }) as unknown as typeof fetch });
    expect(await find(1, 1, 'ROADS')).toEqual({ address: 'Somewhere', offices: [] });
    const first = calls;
    await find(1, 1, 'ROADS');
    expect(calls).toBe(first); // cached
    clock += 25 * 3_600_000;
    await find(1, 1, 'ROADS');
    expect(calls).toBeGreaterThan(first);
  });
});

describe('officer tokens', () => {
  it('survive a restart with the same secret and reject forgeries and expiry', () => {
    let now = 5;
    const a = new Officers('pw', 'secret', () => now);
    const { token } = a.login('zonal1', 'L2', 'pw');
    expect(new Officers('pw', 'secret', () => now).who(token).id).toBe('zonal1');
    expect(() => new Officers('pw', 'other', () => now).who(token)).toThrow(/Sign in/);
    expect(() => a.who(`${token}x`)).toThrow(/Sign in/);
    now += 8 * 24 * 3_600_000;
    expect(() => a.who(token)).toThrow(/Sign in/);
    expect(OFFICERS.length).toBe(4);
  });
});

describe('place search', () => {
  it('finds places by name, ignores very short text, and caches', async () => {
    let calls = 0;
    const search = makePlaceSearch({ fetchFn: (async () => { calls++; return new Response(JSON.stringify([{ display_name: 'Hodal, Palwal, Haryana, India', lat: '27.894', lon: '77.369' }])); }) as unknown as typeof fetch });
    expect(await search('ho')).toEqual([]);
    expect(await search('Hodal')).toEqual([{ name: 'Hodal, Palwal, Haryana, India', lat: 27.894, lng: 77.369 }]);
    await search('hodal');
    expect(calls).toBe(1);
  });
});
