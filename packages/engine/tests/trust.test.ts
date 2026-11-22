import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { detectIncidents } from '../src/detect.js';
import { assessTrust, sameHash } from '../src/trust.js';
import { centroid } from '../src/geo.js';
import type { Complaint } from '../src/types.js';
import { BASE, NOW, complaint, group } from './helpers.js';

const cfg = resolveConfig();
const HOUR = 3_600_000;
const assess = (members: Complaint[], context: Complaint[] = members) => assessTrust(members, context, centroid(members), cfg);
const signalsOf = (members: Complaint[], i: number, context?: Complaint[]) => assess(members, context).authenticity[i].signals;

// Six honest-looking reports; `patch` changes some of them to trigger one signal.
const six = (patch: (i: number) => Partial<Complaint> = () => ({})) => group('c', 6, { spreadM: 100, spanMin: 8, extra: patch });

describe('authenticity signals (each report starts at 60)', () => {
  const cases: [string, (i: number) => Partial<Complaint>, string, number][] = [
    ['device shared by 3 accounts', (i) => (i < 3 ? { deviceId: 'dev-A' } : {}), 'DEVICE_SHARED', -25],
    ['IP shared by 4 accounts within an hour', (i) => (i < 4 ? { ipHash: 'ip-A' } : {}), 'IP_SHARED', -10],
    ['same photo from two accounts', (i) => (i < 2 ? { photoHashes: ['a'.repeat(64)] } : {}), 'PHOTO_REUSED', -25],
    ['near-identical photo hash (3 bits apart)', (i) => ({ photoHashes: [i === 0 ? '0000000000000000' : i === 1 ? '0000000000000007' : `${i}`.repeat(16)] }), 'PHOTO_REUSED', -25],
    ['near-identical text from two accounts', (i) => (i < 2 ? { text: 'no water since morning in our lane' } : {}), 'TEXT_DUPLICATE', -15],
    ['submitted in under 3 seconds', () => ({ submitMs: 1200 }), 'TOO_FAST', -10],
    ['EXIF time matches', () => ({ photoHashes: ['b1'.repeat(32)], exifTime: NOW - 20 * 60_000 }), 'EXIF_MATCH', 5],
    ['EXIF time far off', () => ({ photoHashes: ['b2'.repeat(32)], exifTime: NOW - 40 * HOUR }), 'EXIF_MISMATCH', -10],
    ['past confirmed report', () => ({ reporterHistory: { confirmedResolved: 1, lostDisputes: 0 } }), 'PAST_CONFIRMED', 10],
    ['past lost dispute', () => ({ reporterHistory: { confirmedResolved: 0, lostDisputes: 1 } }), 'PAST_LOST_DISPUTE', -15],
    ['five brand-new accounts in 10 minutes', () => ({ reporterAgeMs: HOUR }), 'NEW_ACCOUNT_BURST', -15],
  ];
  it.each(cases)('%s', (_name, patch, code, points) => {
    const members = six(patch);
    expect(signalsOf(members, 0)).toContainEqual({ code, points });
  });

  it('flags a photo seen at another location, even when that report is outside the incident', () => {
    const members = six((i) => (i === 0 ? { photoHashes: ['c'.repeat(64)] } : {}));
    const elsewhere = complaint({ id: 'far', north: 8000, extra: { photoHashes: ['c'.repeat(64)] } });
    expect(signalsOf(members, 0, [...members, elsewhere])).toContainEqual({ code: 'PHOTO_REUSED_ELSEWHERE', points: -40 });
  });

  it('rewards a report near the centre and corroboration by 3+ independent sources', () => {
    const codes = signalsOf(six(), 2).map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(['GPS_MATCH', 'CORROBORATED']));
  });

  it('compares hashes by bit distance only for 16-hex perceptual hashes', () => {
    expect(sameHash('0000000000000000', '000000000000001f')).toBe(true); // 5 bits
    expect(sameHash('0000000000000000', '00000000000000ff')).toBe(false); // 8 bits
    expect(sameHash('abc', 'abd')).toBe(false);
  });

  it('clamps scores to 0..100 and assigns bands', () => {
    const bad = six(() => ({ deviceId: 'd', ipHash: 'i', submitMs: 100, text: 'same words in every single report', photoHashes: ['e'.repeat(64)] }));
    for (const a of assess(bad).authenticity) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.band).toBe('LIKELY_FAKE');
    }
    for (const a of assess(six()).authenticity) expect([a.score, a.band]).toEqual([85, 'TRUSTED']);
  });
});

describe('independent sources', () => {
  it('counts one device or one photo as one source, however many accounts use it', () => {
    const farm = group('f', 50, { spreadM: 200, extra: (i) => ({ deviceId: `dev-${i % 3}` }) });
    const t = assess(farm);
    expect(t.rawReports).toBe(50);
    expect(t.independentSources).toBe(3);
    expect(t.needsVerification).toBe(true); // 3 sources, but shared devices make them untrusted
  });

  it('drops likely-fake reports from the count and from credibility', () => {
    const mixed = [...group('ok', 8, { spreadM: 100 }), ...group('bad', 4, { spreadM: 100, extra: () => ({ submitMs: 500, text: 'water water water water', reporterAgeMs: HOUR, ipHash: 'x', deviceId: 'dd' }) })];
    const t = assess(mixed);
    expect(t.bands.LIKELY_FAKE + t.bands.REVIEW).toBeGreaterThan(0);
    expect(t.independentSources).toBeLessThan(12);
  });

  it('a scripted fake campaign from many SIMs is caught by behaviour signals', () => {
    const scripted = group('s', 40, { spreadM: 150, extra: (i) => ({ ipHash: 'one-ip', text: 'pipe burst please send help now', submitMs: 800, reporterAgeMs: HOUR, deviceId: `d${i}` }) });
    const { incidents } = detectIncidents(scripted, NOW);
    expect(incidents[0].trust.needsVerification).toBe(true);
    expect(incidents[0].trust.trustedSources).toBe(0);
    expect(incidents[0].severity.score).toBeLessThan(25);
  });

  it('does NOT treat a genuine mass outage as fake', () => {
    const real = group('r', 40, { spreadM: 400, extra: (i) => ({ deviceId: `d${i}`, ipHash: `ip${i}`, text: `report number ${i} from house ${i * 7}`, submitMs: 20_000 + i * 900, reporterAgeMs: (30 + i) * 24 * HOUR }) });
    const { incidents } = detectIncidents(real, NOW);
    const t = incidents[0].trust;
    expect(t.bands.LIKELY_FAKE).toBe(0);
    expect(t.trustedSources).toBe(40);
    expect(t.needsVerification).toBe(false);
  });
});

describe('detectIncidents with trust and roads', () => {
  it('attaches trust and applies credibility to the score', () => {
    const { incidents } = detectIncidents(group('a', 8, { spreadM: 300 }), NOW);
    expect(incidents[0].trust.credibility).toBe(0.85);
    expect(incidents[0].severity.score).toBeCloseTo(incidents[0].severity.base * 0.85, 1);
  });

  it('keeps potholes as small, slow incidents of their own', () => {
    const spot = group('p', 3, { type: 'POTHOLE', spreadM: 20, minutesAgo: 3 * 24 * 60, spanMin: 2 * 24 * 60, extra: () => ({ size: 3, roadClass: 'MAIN', photoHashes: [] }) });
    const water = group('w', 5, { spreadM: 100 });
    const { incidents } = detectIncidents([...spot, ...water], NOW);
    expect(incidents.map((i) => i.family).sort()).toEqual(['ROAD', 'SUPPLY']);
    const road = incidents.find((i) => i.family === 'ROAD')!;
    expect(road.road).toMatchObject({ size: 3, roadClass: 'MAIN' });
    expect(road.severity.factors).toHaveLength(6);
  });

  it('does not join two potholes 100 m apart, but does join two 30 m apart', () => {
    const at = (id: string, north: number) => complaint({ id, type: 'POTHOLE', north, minutesAgo: 60 });
    expect(detectIncidents([at('a', 0), at('b', 100)], NOW).incidents).toHaveLength(0);
    expect(detectIncidents([at('a', 0), at('b', 30)], NOW).incidents).toHaveLength(1);
  });

  it('rejects a per-family setting that makes no sense', () => {
    expect(() => resolveConfig({ perFamily: { ROAD: { epsMeters: -1 } } })).toThrow(/perFamily.ROAD.epsMeters/);
  });
});

describe('rings from the graph and from the network', () => {
  it('a ring found in another city is NETWORK_RING, counts as one source, and a local ring wins', () => {
    const net = { id: 'net:demo:r1', accounts: 10, via: ['NETWORK', 'CO_REPORTING'] };
    const members = six((i) => (i < 4 ? { ring: net } : {}));
    const t = assess(members);
    expect(t.authenticity[0].signals).toContainEqual({ code: 'NETWORK_RING', points: -20 });
    expect(t.authenticity[5].signals.some((s) => s.code.endsWith('_RING'))).toBe(false);
    expect(t.independentSources).toBe(3); // 4 ring accounts -> 1, plus 2 others
    const local = assess(six((i) => (i < 4 ? { ring: { id: 'r9', accounts: 4, via: ['DEVICE'] } } : {}))).authenticity[0].signals;
    expect(local.map((s) => s.code)).toContain('GRAPH_RING');
  });
});
