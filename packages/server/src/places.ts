import { haversineMeters } from '@bharatpulse/engine';

export interface FoundOffice { name: string; address?: string; phone?: string; source: 'google' | 'osm'; lat?: number; lng?: number }
export interface Nearby { address?: string; offices: FoundOffice[] }
export type PlaceFinder = (lat: number, lng: number, category: 'WATER' | 'ROADS') => Promise<Nearby>;

const QUERY = { WATER: 'Nagar Palika or water supply department office', ROADS: 'Nagar Palika or PWD public works department office' } as const;
const NAME = { WATER: /jal|water|nigam|sansthan|nagar|municipal|palika|council|corporation|panchayat|ward/i, ROADS: /pwd|public works|road|nagar|municipal|palika|corporation|panchayat|ward|works/i } as const;
const DAY = 86_400_000;

/**
 * Looks up the real offices near a point. Google Places (needs GOOGLE_MAPS_KEY, billed per request, best phone coverage)
 * is tried first, then OpenStreetMap (free, no key, but many small-town offices have no phone listed).
 * An address for the user's own spot comes from OpenStreetMap's Nominatim, which allows light use only; results are cached for a day.
 * WRITTEN FROM THE PROVIDERS' DOCS, NOT RUN AGAINST THE LIVE SERVICES.
 */
export function makePlaceFinder(o: { googleKey?: string; email?: string; fetchFn?: typeof fetch; now?: () => number } = {}): PlaceFinder {
  const f = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const ua = { 'user-agent': `BharatPulse/1.0${o.email ? ` (${o.email})` : ''}` };
  const cache = new Map<string, { at: number; value: Nearby }>();
  const json = async (url: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };

  async function address(lat: number, lng: number): Promise<string | undefined> {
    try {
      const j = (await json(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`, { headers: { ...ua, 'accept-language': 'en' } })) as { display_name?: string };
      return j.display_name;
    } catch { return undefined; }
  }

  async function google(lat: number, lng: number, cat: 'WATER' | 'ROADS'): Promise<FoundOffice[]> {
    const j = (await json('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': o.googleKey!, 'x-goog-fieldmask': 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.location' },
      body: JSON.stringify({ textQuery: QUERY[cat], maxResultCount: 5, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 15000 } } }),
    })) as { places?: { displayName?: { text?: string }; formattedAddress?: string; nationalPhoneNumber?: string; location?: { latitude: number; longitude: number } }[] };
    return (j.places ?? []).map((p) => ({ name: p.displayName?.text ?? 'Office', address: p.formattedAddress, phone: p.nationalPhoneNumber, source: 'google' as const, lat: p.location?.latitude, lng: p.location?.longitude }));
  }

  async function osm(lat: number, lng: number, cat: 'WATER' | 'ROADS'): Promise<FoundOffice[]> {
    const q = `[out:json][timeout:20];(nwr(around:6000,${lat},${lng})["office"="government"];nwr(around:6000,${lat},${lng})["amenity"="townhall"];);out center tags 40;`;
    const j = (await json('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { ...ua, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(q)}` })) as { elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
    const all = (j.elements ?? []).filter((e) => e.tags?.name).map((e) => {
      const t = e.tags!;
      const street = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'], t['addr:city'] ?? t['addr:district']].filter(Boolean).join(', ');
      return { name: t.name, address: t['addr:full'] ?? (street || undefined), phone: t.phone ?? t['contact:phone'], source: 'osm' as const, lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon };
    });
    const matching = all.filter((x) => NAME[cat].test(x.name));
    return matching.length > 0 ? matching : all;
  }

  return async (lat, lng, cat) => {
    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${cat}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < DAY) return hit.value;
    let offices: FoundOffice[] = [];
    if (o.googleKey) offices = await google(lat, lng, cat).catch(() => []);
    if (offices.length === 0) offices = await osm(lat, lng, cat).catch(() => []);
    offices = offices
      .map((x) => ({ x, d: x.lat !== undefined && x.lng !== undefined ? haversineMeters({ lat, lng }, { lat: x.lat, lng: x.lng }) : Infinity }))
      .sort((a, b) => a.d - b.d).slice(0, 3).map(({ x }) => x);
    const value: Nearby = { address: await address(lat, lng), offices };
    if (offices.length > 0 || value.address) cache.set(key, { at: now(), value });
    return value;
  };
}

/** Finds places in India by name (OpenStreetMap Nominatim). Light use only; answers are cached for a day. */
export function makePlaceSearch(o: { email?: string; fetchFn?: typeof fetch; now?: () => number } = {}) {
  const f = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; value: { name: string; lat: number; lng: number }[] }>();
  return async (q: string): Promise<{ name: string; lat: number; lng: number }[]> => {
    const key = q.trim().toLowerCase();
    if (key.length < 3) return [];
    const hit = cache.get(key);
    if (hit && now() - hit.at < DAY) return hit.value;
    const res = await f(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&limit=5&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': `BharatPulse/1.0${o.email ? ` (${o.email})` : ''}`, 'accept-language': 'en' }, signal: AbortSignal.timeout(9000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const value = ((await res.json()) as { display_name: string; lat: string; lon: string }[]).map((x) => ({ name: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }));
    cache.set(key, { at: now(), value });
    return value;
  };
}

export type PlaceSuggest = (q: string) => Promise<{ name: string; detail: string; lat: number; lng: number; kind: string }[]>;

/**
 * Place names as you type, like a maps search box: OpenStreetMap's Photon autocomplete (free, no key), limited to
 * India, cached for a day. Falls back to Nominatim search if Photon does not answer.
 */
export function makePlaceSuggest(o: { fetchFn?: typeof fetch; email?: string; now?: () => number } = {}): PlaceSuggest {
  const f = o.fetchFn ?? fetch;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Awaited<ReturnType<PlaceSuggest>> }>();
  const ua = { 'user-agent': `BharatPulse/1.0${o.email ? ` (${o.email})` : ''}`, 'accept-language': 'en' };
  return async (q) => {
    const key = q.trim().toLowerCase().slice(0, 80);
    if (key.length < 2) return [];
    const hit = cache.get(key);
    if (hit && now() - hit.at < 86_400_000) return hit.value;
    let value: Awaited<ReturnType<PlaceSuggest>> = [];
    try {
      const res = await f(`https://photon.komoot.io/api/?q=${encodeURIComponent(key)}&limit=7&lang=en&bbox=68.1,6.5,97.4,35.7`, { headers: ua, signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { features?: { geometry: { coordinates: [number, number] }; properties: { name?: string; city?: string; district?: string; county?: string; state?: string; osm_value?: string; countrycode?: string } }[] };
      value = (j.features ?? []).filter((x) => !x.properties.countrycode || x.properties.countrycode === 'IN').map((x) => {
        const p = x.properties;
        const detail = [p.city !== p.name ? p.city : undefined, p.district ?? p.county, p.state].filter(Boolean).join(', ');
        return { name: p.name ?? detail, detail, lat: x.geometry.coordinates[1], lng: x.geometry.coordinates[0], kind: p.osm_value ?? 'place' };
      }).filter((x) => x.name);
    } catch {
      const res = await f(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&limit=6&q=${encodeURIComponent(key)}`, { headers: ua, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
      const j = res?.ok ? ((await res.json()) as { display_name: string; lat: string; lon: string; type?: string }[]) : [];
      value = j.map((x) => { const [name, ...rest] = x.display_name.split(', '); return { name, detail: rest.slice(0, 3).join(', '), lat: Number(x.lat), lng: Number(x.lon), kind: x.type ?? 'place' }; });
    }
    const seen = new Set<string>();
    value = value.filter((v) => { const k = `${v.name}|${v.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
    cache.set(key, { at: now(), value });
    return value;
  };
}
