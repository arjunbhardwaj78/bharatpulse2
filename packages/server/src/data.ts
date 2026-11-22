// All data here is SAMPLE data: a made-up town, made-up offices and placeholder phone numbers.
// Set CITY_CENTER="lat,lng" to place the sample town where you are testing; edit this file (or load real data) before real use.
import { haversineMeters } from '@bharatpulse/engine';

export interface Office { id: string; name: string; address: string; phone: string; handles: ('WATER' | 'ROADS')[]; zoneIds: string[]; sample?: boolean }
export interface Contact { zoneId: string; name: string; role: string; phone: string; sample?: boolean }
export interface City {
  zones: { id: string; name: string; feeds: string[] }[];
  localities: { id: string; name: string; zoneId: string; lat: number; lng: number }[];
  facilities: { id: string; type: 'HOSPITAL' | 'SCHOOL'; name: string; lat: number; lng: number }[];
  offices: Office[];
  contacts: Contact[];
  /**
   * The water network as a graph: a tank feeds a pump, the pump feeds pipelines, pipelines feed other pipelines
   * and SUPPLY zones. Used to trace several outages back to the one asset they share ("root cause").
   */
  assets: Asset[];
}
export interface Asset { id: string; kind: 'TANK' | 'PUMP' | 'PIPE'; name: string; lat: number; lng: number; feeds: string[]; supplies: string[] }

const given = process.env.CITY_CENTER?.split(',').map(Number);
export const CITY_CENTER = given?.length === 2 && given.every(Number.isFinite) ? { lat: given[0], lng: given[1] } : { lat: 27.894, lng: 77.369 }; // Hodal; set CITY_CENTER to test somewhere else
export const SERVICE_RADIUS_KM = Number(process.env.SERVICE_RADIUS_KM) || 8;
export const inServiceArea = (lat: number, lng: number): boolean => haversineMeters({ lat, lng }, CITY_CENTER) <= SERVICE_RADIUS_KM * 1000;

const PHONE = (n: number) => `+91 00000 0000${n}`; // placeholder numbers, shown with a "sample" badge

/** The sample town (8 wards, 4 zones, a small pipe network) drawn around any centre. Used by the demo city. */
export function sampleTown(C: { lat: number; lng: number }): City {
const at = (id: string, name: string, zoneId: string, dLat: number, dLng: number) => ({ id, name, zoneId, lat: C.lat + dLat, lng: C.lng + dLng });
return {
  zones: [
    { id: 'Z1', name: 'Zone 1 (main tank)', feeds: ['Z2', 'Z3'] },
    { id: 'Z2', name: 'Zone 2', feeds: ['Z4'] },
    { id: 'Z3', name: 'Zone 3', feeds: [] },
    { id: 'Z4', name: 'Zone 4', feeds: [] },
  ],
  localities: [
    at('L1', 'Ward 1', 'Z1', 0, 0), at('L2', 'Ward 2', 'Z1', 0.004, 0.003), at('L3', 'Ward 3', 'Z2', 0.008, 0),
    at('L4', 'Ward 4', 'Z2', 0.008, 0.006), at('L5', 'Ward 5', 'Z3', -0.006, 0.004), at('L6', 'Ward 6', 'Z3', -0.008, -0.004),
    at('L7', 'Ward 7', 'Z4', 0.014, 0.003), at('L8', 'Ward 8', 'Z4', 0.014, 0.009),
  ],
  facilities: [
    { id: 'F1', type: 'HOSPITAL', name: 'Sample Civil Hospital', lat: C.lat + 0.0041, lng: C.lng + 0.0031 },
    { id: 'F2', type: 'SCHOOL', name: 'Sample Primary School', lat: C.lat + 0.0081, lng: C.lng + 0.0002 },
  ],
  // Sample water network. Consistent with the zone FEEDS links above: Z1 feeds Z2 and Z3, Z2 feeds Z4.
  assets: [
    { id: 'T1', kind: 'TANK', name: 'Main overhead tank', lat: C.lat - 0.002, lng: C.lng - 0.002, feeds: ['P1'], supplies: [] },
    { id: 'P1', kind: 'PUMP', name: 'Booster pump house', lat: C.lat - 0.001, lng: C.lng - 0.001, feeds: ['M1'], supplies: [] },
    { id: 'M1', kind: 'PIPE', name: 'Trunk main', lat: C.lat + 0.001, lng: C.lng + 0.001, feeds: ['M2', 'M3'], supplies: ['Z1'] },
    { id: 'M2', kind: 'PIPE', name: 'North feeder (Wards 3-4)', lat: C.lat + 0.006, lng: C.lng + 0.003, feeds: ['M4'], supplies: ['Z2'] },
    { id: 'M3', kind: 'PIPE', name: 'South feeder (Wards 5-6)', lat: C.lat - 0.005, lng: C.lng, feeds: [], supplies: ['Z3'] },
    { id: 'M4', kind: 'PIPE', name: 'North extension (Wards 7-8)', lat: C.lat + 0.012, lng: C.lng + 0.006, feeds: [], supplies: ['Z4'] },
  ],
  // Zones 1-2 are served by a Nagar Palika that handles both; zones 3-4 have a separate water office and roads office.
  offices: [
    { id: 'O1', name: 'Nagar Palika Parishad', address: 'Main Chowk, near the bus stand', phone: PHONE(1), handles: ['WATER', 'ROADS'], zoneIds: ['Z1', 'Z2'], sample: true },
    { id: 'O2', name: 'Jal Nigam zonal office', address: 'Water Works Road, Ward 5', phone: PHONE(2), handles: ['WATER'], zoneIds: ['Z3', 'Z4'], sample: true },
    { id: 'O3', name: 'PWD division office', address: 'Civil Lines, opposite the tehsil', phone: PHONE(3), handles: ['ROADS'], zoneIds: ['Z3', 'Z4'], sample: true },
  ],
  contacts: [
    { zoneId: 'Z1', name: 'Zone 1 committee member', role: 'Zone committee member', phone: PHONE(4), sample: true },
    { zoneId: 'Z2', name: 'Zone 2 committee member', role: 'Zone committee member', phone: PHONE(5), sample: true },
    { zoneId: 'Z3', name: 'Zone 3 committee member', role: 'Zone committee member', phone: PHONE(6), sample: true },
    { zoneId: 'Z4', name: 'Zone 4 committee member', role: 'Zone committee member', phone: PHONE(7), sample: true },
  ],
};
}

export const CITY: City = sampleTown(CITY_CENTER);

/**
 * A starting map for a newly onboarded city: `wards` wards on a grid around the centre (about 900 m apart), grouped
 * two per zone, and a water network the city can correct later: tank -> pump -> trunk main -> one feeder per zone,
 * feeders chained outward (zone 1 feeds zones 2 and 3, zone 2 feeds 4, ...). Everything is marked as a draft.
 */
export function generateCity(center: { lat: number; lng: number }, wards: number, names: { ward?: string } = {}): City {
  const n = Math.min(40, Math.max(2, Math.floor(wards)));
  const zones = Math.ceil(n / 2);
  const side = Math.ceil(Math.sqrt(n));
  const step = 0.008;
  const localities = Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / side) - (side - 1) / 2;
    const col = (i % side) - (side - 1) / 2;
    return { id: `L${i + 1}`, name: `${names.ward ?? 'Ward'} ${i + 1}`, zoneId: `Z${Math.floor(i / 2) + 1}`, lat: center.lat + row * step, lng: center.lng + col * step };
  });
  const zoneList = Array.from({ length: zones }, (_, z) => ({ id: `Z${z + 1}`, name: z === 0 ? 'Zone 1 (main tank)' : `Zone ${z + 1}`, feeds: [2 * z + 2, 2 * z + 3].filter((k) => k <= zones).map((k) => `Z${k}`) }));
  const centre = (zid: string) => { const ls = localities.filter((l) => l.zoneId === zid); return { lat: ls.reduce((a, l) => a + l.lat, 0) / ls.length, lng: ls.reduce((a, l) => a + l.lng, 0) / ls.length }; };
  const assets: Asset[] = [
    { id: 'T1', kind: 'TANK', name: 'Main overhead tank', lat: center.lat - 0.003, lng: center.lng - 0.003, feeds: ['P1'], supplies: [] },
    { id: 'P1', kind: 'PUMP', name: 'Pump house', lat: center.lat - 0.002, lng: center.lng - 0.001, feeds: ['M1'], supplies: [] },
    ...zoneList.map((z, k) => ({ id: `M${k + 1}`, kind: 'PIPE' as const, name: k === 0 ? 'Trunk main' : `Feeder to ${z.name}`, ...centre(z.id), feeds: z.feeds.map((f) => `M${f.slice(1)}`), supplies: [z.id] })),
  ];
  return {
    zones: zoneList, localities, assets, facilities: [],
    offices: [{ id: 'O1', name: 'Municipal office', address: 'Add the address in Settings', phone: 'Add a phone number', handles: ['WATER', 'ROADS'], zoneIds: zoneList.map((z) => z.id), sample: true }],
    contacts: [],
  };
}

/** Only 112 is a real number here. Everything else must come from an official source before real use. */
export const DIRECTORY = {
  emergency: { name: 'National emergency number', phone: '112' },
  agencies: [
    { category: 'WATER', name: 'Water department zonal office', phone: 'VERIFY BEFORE USE', office: 'VERIFY BEFORE USE' },
    { category: 'ROADS', name: 'Roads / PWD office', phone: 'VERIFY BEFORE USE', office: 'VERIFY BEFORE USE' },
  ],
};

/** Who to call and where to go for this place and kind of problem. Some towns have one office for both; others split them. */
export function directoryFor(city: City, lat: number, lng: number, category?: 'WATER' | 'ROADS') {
  const near = [...city.localities].map((l) => ({ l, d: haversineMeters({ lat, lng }, l) })).sort((a, b) => a.d - b.d)[0];
  const zoneId = near && near.d <= 3000 ? near.l.zoneId : undefined;
  const office = zoneId ? city.offices.find((o) => o.zoneIds.includes(zoneId) && (!category || o.handles.includes(category))) : undefined;
  return {
    ...DIRECTORY,
    zone: zoneId ? { id: zoneId, name: city.zones.find((z) => z.id === zoneId)?.name ?? zoneId, locality: near.l.name } : undefined,
    contact: zoneId ? city.contacts.find((c) => c.zoneId === zoneId) : undefined,
    office,
    officeHandlesBoth: !!office && office.handles.length > 1,
  };
}

/** The ward (locality) nearest to a point, if one is within 3 km. */
export function wardOf(city: City, lat: number, lng: number): City['localities'][number] | undefined {
  const best = [...city.localities].map((l) => ({ l, d: haversineMeters({ lat, lng }, l) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 3000 ? best.l : undefined;
}
