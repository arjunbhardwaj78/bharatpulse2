import { detectIncidents, type Complaint, type IssueType } from '@bharatpulse/engine';

// Synthetic data generators for the demo and the evaluation. Seeded, so the same seed gives the same reports.
const M = 111_195;
const MIN = 60_000;
const DAY = 86_400_000;
export interface Spot { lat: number; lng: number }

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Opts { n: number; at: Spot; now: number; r: () => number; prefix: string; minutes?: number; radiusM?: number; type?: IssueType }
const PHRASES = ['no water since morning', 'tap is dry at our house', 'water has stopped coming', 'pipe seems to be empty', 'supply cut again today', 'nothing coming from the tap'];

function base(o: Opts, i: number): Complaint {
  const span = o.minutes ?? 40;
  const r = o.r;
  return {
    id: `${o.prefix}${i}`, reporterId: `${o.prefix}-u${i}`, issueType: o.type ?? 'NO_WATER',
    lat: o.at.lat + ((r() - 0.5) * 2 * (o.radiusM ?? 350)) / M, lng: o.at.lng + ((r() - 0.5) * 2 * (o.radiusM ?? 350)) / M,
    createdAt: o.now - span * MIN + Math.floor((i / o.n) * span * MIN),
  };
}

/** Real households: own phone, own device (one in ten shares a device with a neighbour), varied wording, normal typing time. */
export const genuineOutage = (o: Opts): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({
    ...base(o, i),
    deviceId: i % 10 === 9 ? `${o.prefix}-d${i - 1}` : `${o.prefix}-d${i}`, ipHash: `${o.prefix}-ip${i}`,
    text: `${PHRASES[Math.floor(o.r() * PHRASES.length)]} house ${Math.floor(o.r() * 900)}`,
    submitMs: 12_000 + Math.floor(o.r() * 60_000), reporterAgeMs: (10 + o.r() * 300) * DAY,
  }));

/** Many accounts on a few phones. `devices` is how many phones. */
export const deviceAttack = (o: Opts & { devices: number }): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({ ...base(o, i), deviceId: `${o.prefix}-phone${i % o.devices}` }));

/** Many SIMs, many devices, one script: same wording, same network, instant submits, brand-new accounts. */
export const simFarm = (o: Opts): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({ ...base(o, i), deviceId: `${o.prefix}-d${i}`, ipHash: `${o.prefix}-one-ip`, text: 'pipe burst please send help now', submitMs: 700, reporterAgeMs: 3_600_000 }));

/** One photo (or a lightly edited copy) pasted into many accounts. */
export const photoReuse = (o: Opts): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({ ...base(o, i), deviceId: `${o.prefix}-d${i}`, photoHashes: [i % 2 ? 'a1b2c3d4e5f60718' : 'a1b2c3d4e5f6071f'] }));

/** A careful attacker: every signal looks human. We expect this to get through; the eval reports it honestly. */
export const sophisticated = (o: Opts): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({
    ...base({ ...o, minutes: 90 }, i), deviceId: `${o.prefix}-d${i}`, ipHash: `${o.prefix}-ip${i}`,
    text: `${PHRASES[Math.floor(o.r() * PHRASES.length)]} number ${Math.floor(o.r() * 900)}`, submitMs: 15_000 + Math.floor(o.r() * 50_000), reporterAgeMs: 40 * DAY,
  }));

/**
 * A hired crowd: the SAME accounts, each looking human on every signal, report a fake outage in one ward and later
 * in another ward far away. One incident alone gets through (that is `sophisticated`). The graph links the two:
 * the same accounts reporting together in far-apart places is a ring, and the ring counts as one source.
 */
export const travellingCrowd = (o: Opts & { crowd: string }): Complaint[] =>
  sophisticated(o).map((c, i) => ({ ...c, reporterId: `${o.crowd}-u${i}`, deviceId: `${o.crowd}-d${i}`, ipHash: `${o.prefix}-ip${i}` }));

export const roadCluster = (o: Opts): Complaint[] =>
  Array.from({ length: o.n }, (_, i) => ({ ...base({ ...o, minutes: 3 * 24 * 60, radiusM: 15, type: 'POTHOLE' }, i), deviceId: `${o.prefix}-d${i}`, size: 3, roadClass: 'MAIN' }));

export const SCENARIOS: Record<string, (o: Opts) => Complaint[]> = { outage: genuineOutage, attack: (o) => deviceAttack({ ...o, devices: 3 }), simfarm: simFarm, photo: photoReuse, sophisticated, road: roadCluster, crowd: (o) => travellingCrowd({ ...o, crowd: 'crowd' }) };

const T0 = Date.UTC(2026, 10, 1, 9, 0);
const REPLAY_SPOT: Spot = { lat: 27.4924, lng: 77.6737 };

/** The outage replay: 40 real reports that arrive slowly at first, then fast. Slider position `minute` is 0 to 120. */
export function replayOutage(minute: number): { minute: number; reports: number; incident: null | { score: number; level: string; independentSources: number; needsVerification: boolean } } {
  const all = genuineOutage({ n: 40, at: REPLAY_SPOT, now: T0 + 120 * MIN, r: rng(7), prefix: 'rp', minutes: 120 }).map((c, i) => ({ ...c, createdAt: T0 + Math.floor(120 * MIN * (i / 40) ** 1.8) }));
  const now = T0 + minute * MIN;
  const seen = all.filter((c) => c.createdAt <= now);
  const top = detectIncidents(seen, now).incidents[0];
  return { minute, reports: seen.length, incident: top ? { score: top.severity.score, level: top.severity.level, independentSources: top.trust.independentSources, needsVerification: top.trust.needsVerification } : null };
}

/**
 * A ready-made picture of a town on a bad day (synthetic). Laid out so every graph feature has something to find:
 *  - real outages in Ward 3 (Zone 2) and Ward 8 (Zone 4): both fed by the North feeder -> root cause, Wards 4 and 7 at risk
 *  - three naive fake campaigns (shared phones in Ward 1, a SIM farm in Ward 6, one photo pasted into many accounts in Ward 6's south)
 *  - a travelling crowd: the same 10 accounts faked an outage in Ward 5 two days ago and are doing it again in Ward 7 now
 *  - a leak with a pothole next to it (Ward 1), a school-side pothole and dirty water that were fixed earlier, a few single reports
 */
/** Sample voices in several languages, with the English an officer would see (pre-translated sample text). */
const VOICES: { text: string; textEn: string; language: string }[] = [
  { text: 'सुबह से पानी नहीं आया, टंकी भी खाली है', textEn: 'No water since morning, the tank is also empty', language: 'hi-IN' },
  { text: 'எங்கள் தெருவில் இரண்டு நாட்களாக தண்ணீர் வரவில்லை', textEn: 'No water has come in our street for two days', language: 'ta-IN' },
  { text: 'সকাল থেকে কলে জল আসছে না', textEn: 'Water has not been coming from the tap since morning', language: 'bn-IN' },
  { text: 'नळाला पाणी अगदी कमी दाबाने येत आहे', textEn: 'Water is coming to the tap at very low pressure', language: 'mr-IN' },
  { text: 'ਸਵੇਰ ਤੋਂ ਪਾਣੀ ਨਹੀਂ ਆਇਆ', textEn: 'Water has not come since morning', language: 'pa-IN' },
];
const withVoices = (cs: Complaint[]): Complaint[] => cs.map((c, i) => (i % 3 === 1 ? { ...c, ...VOICES[i % VOICES.length] } : c));

export function sampleDataset(now: number, at: (id: string) => Spot): Complaint[] {
  // Each scenario sits in its own ward and is kept tight (100 m) so the groups do not run into each other.
  const o = (n: number, locality: string, prefix: string, more: Partial<Opts> = {}): Opts => ({ n, at: at(locality), now, r: rng(n * 31 + locality.charCodeAt(1)), prefix, radiusM: 100, ...more });
  const leak = at('L1');
  const shift = (p: Spot, dLat: number, dLng = 0): Spot => ({ lat: p.lat + dLat, lng: p.lng + dLng });
  const stray = (locality: string, type: IssueType, i: number, dLat: number, dLng: number): Complaint[] => genuineOutage({ ...o(1, locality, `s9${i}-`, { type, minutes: 5 }), at: shift(at(locality), dLat, dLng) });
  const H = 3_600_000;
  return [
    ...withVoices(genuineOutage(o(28, 'L3', 's1-', { minutes: 60 }))),
    ...withVoices(genuineOutage(o(12, 'L8', 's10-', { minutes: 45, type: 'LOW_PRESSURE' }))),
    ...deviceAttack({ ...o(45, 'L1', 's2-'), devices: 3 }),
    ...simFarm(o(30, 'L6', 's3-')),
    ...photoReuse({ ...o(20, 'L6', 's4-'), at: shift(at('L6'), -0.009) }),
    ...travellingCrowd({ ...o(10, 'L5', 'cr1-', { now: now - 48 * H }), crowd: 'crowd' }),
    ...travellingCrowd({ ...o(10, 'L7', 'cr2-'), at: shift(at('L7'), 0.006), crowd: 'crowd' }),
    ...genuineOutage(o(6, 'L1', 's5-', { type: 'LEAK', now: now - 70 * 60_000, minutes: 40 })),
    ...genuineOutage({ ...o(3, 'L1', 's6-', { type: 'POTHOLE', minutes: 40, radiusM: 12 }), at: shift(leak, 0.0005) }).map((c) => ({ ...c, size: 3 as const, roadClass: 'MAIN' as const })),
    ...genuineOutage({ ...o(4, 'L3', 's7-', { type: 'POTHOLE', now: now - 50 * H, minutes: 180, radiusM: 10 }), at: shift(at('L3'), 0.0001) }).map((c) => ({ ...c, size: 2 as const, roadClass: 'LOCAL' as const, nearFacility: true })),
    ...genuineOutage(o(8, 'L4', 's8-', { type: 'DIRTY_WATER', now: now - 30 * H, minutes: 90 })),
    ...stray('L1', 'LOW_PRESSURE', 0, 0, -0.010), ...stray('L2', 'OTHER_WATER', 1, 0, 0.008), ...stray('L5', 'WATERLOGGING', 2, -0.004, 0),
  ];
}
