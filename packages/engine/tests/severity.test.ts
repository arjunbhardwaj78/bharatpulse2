import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { levelFor, scoreSeverity } from '../src/severity.js';
import type { TrustSummary } from '../src/types.js';
import { NOW, fakeCluster } from './helpers.js';

const cfg = resolveConfig();
const trust = (o: Partial<TrustSummary>): TrustSummary => ({
  rawReports: 10, independentSources: 10, trustedSources: 10, nEff: 10, credibility: 1, needsVerification: false,
  bands: { TRUSTED: 10, REVIEW: 0, LIKELY_FAKE: 0 }, authenticity: [], ...o,
});

describe('scoreSeverity', () => {
  it('stays within 0..100 and the factors add up to the score', () => {
    const s = scoreSeverity(fakeCluster({ complaintCount: 500, radiusMeters: 9000, ageMin: 99_999, recent: 200 }), NOW, cfg);
    expect(s.score).toBeLessThanOrEqual(100);
    expect(s.score).toBeGreaterThan(0);
    const sum = s.factors.reduce((t, f) => t + f.points, 0);
    expect(s.score).toBeCloseTo(sum, 1);
    for (const f of s.factors) expect(f.points).toBeLessThanOrEqual(f.max);
  });

  it('ranks more complaints higher', () => {
    const small = scoreSeverity(fakeCluster({ complaintCount: 3 }), NOW, cfg).score;
    const big = scoreSeverity(fakeCluster({ complaintCount: 20 }), NOW, cfg).score;
    expect(big).toBeGreaterThan(small);
  });

  it('ranks a still-growing incident above a stalled one of the same size', () => {
    const growing = scoreSeverity(fakeCluster({ complaintCount: 10, recent: 6 }), NOW, cfg).score;
    const stalled = scoreSeverity(fakeCluster({ complaintCount: 10, recent: 0 }), NOW, cfg).score;
    expect(growing).toBeGreaterThan(stalled);
  });

  it('gives longer-running incidents more duration points', () => {
    // Compare the duration factor alone: age also changes which reports count as "recent".
    const durationPoints = (ageMin: number): number =>
      scoreSeverity(fakeCluster({ ageMin }), NOW, cfg).factors.find((f) => f.name === 'duration')!.points;
    expect(durationPoints(600)).toBeGreaterThan(durationPoints(20));
    expect(durationPoints(100_000)).toBe(15); // capped at its maximum
  });

  it('weights health risk above supply above leaks', () => {
    const q = scoreSeverity(fakeCluster({ family: 'QUALITY' }), NOW, cfg).score;
    const s = scoreSeverity(fakeCluster({ family: 'SUPPLY' }), NOW, cfg).score;
    const i = scoreSeverity(fakeCluster({ family: 'INFRASTRUCTURE' }), NOW, cfg).score;
    expect(q).toBeGreaterThan(s);
    expect(s).toBeGreaterThan(i);
  });

  it('maps scores to levels at the configured thresholds', () => {
    expect([10, 25, 50, 75].map((n) => levelFor(n, cfg))).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  });

  it('puts a small fresh cluster at LOW and a large, growing health risk at CRITICAL', () => {
    const small = scoreSeverity(fakeCluster({ complaintCount: 3, radiusMeters: 80, ageMin: 20 }), NOW, cfg);
    const severe = scoreSeverity(
      fakeCluster({ family: 'QUALITY', complaintCount: 30, radiusMeters: 800, ageMin: 720, recent: 8 }),
      NOW,
      cfg,
    );
    expect(small.level).not.toBe('CRITICAL');
    expect(small.score).toBeLessThan(severe.score);
    expect(severe.level).toBe('CRITICAL');
  });

  it('follows the log curve for independent sources (points out of 30)', () => {
    const points = (n: number): number => scoreSeverity(fakeCluster(), NOW, cfg, trust({ nEff: n })).factors[0].points;
    expect([1, 3, 10, 25, 100].map(points)).toEqual([6.4, 12.8, 22.1, 30, 30]);
  });

  it('multiplies the base by credibility', () => {
    const s = scoreSeverity(fakeCluster({ complaintCount: 12 }), NOW, cfg, trust({ nEff: 12, credibility: 0.5 }));
    expect(s.score).toBeCloseTo(s.base * 0.5, 1);
  });

  it('never lets an unverified incident be CRITICAL', () => {
    const big = fakeCluster({ family: 'QUALITY', complaintCount: 30, radiusMeters: 800, ageMin: 720, recent: 8 });
    expect(scoreSeverity(big, NOW, cfg, trust({ nEff: 30 })).level).toBe('CRITICAL');
    expect(scoreSeverity(big, NOW, cfg, trust({ nEff: 30, needsVerification: true })).level).toBe('HIGH');
  });

  it('scores roads on size, road class, facilities and photos', () => {
    const road = (r: Partial<NonNullable<ReturnType<typeof fakeCluster>['road']>>) =>
      scoreSeverity(fakeCluster({ family: 'ROAD', road: { size: 1, roadClass: 'LOCAL', nearFacility: false, photoShare: 0, ...r } }), NOW, cfg).score;
    const base = road({});
    for (const better of [{ size: 3 }, { roadClass: 'HIGHWAY' as const }, { nearFacility: true }, { photoShare: 1 }]) expect(road(better)).toBeGreaterThan(base);
    expect(scoreSeverity(fakeCluster({ family: 'ROAD' }), NOW, cfg).factors).toHaveLength(6);
  });
});
