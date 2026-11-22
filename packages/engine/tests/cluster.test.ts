import { describe, expect, it } from 'vitest';
import { clusterComplaints } from '../src/cluster.js';
import { resolveConfig } from '../src/config.js';
import { complaint, group } from './helpers.js';

const cfg = resolveConfig();

describe('clusterComplaints', () => {
  it('groups nearby, same-time complaints into one cluster', () => {
    const { clusters, noise } = clusterComplaints(group('a', 5, { spreadM: 200 }), cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].complaintCount).toBe(5);
    expect(noise).toHaveLength(0);
  });

  it('keeps two distant neighbourhoods as separate clusters', () => {
    const complaints = [...group('a', 4), ...group('b', 4, { north: 3000 })];
    const { clusters } = clusterComplaints(complaints, cfg);
    expect(clusters).toHaveLength(2);
  });

  it('does not join complaints that are far apart in time', () => {
    const complaints = [...group('old', 3, { minutesAgo: 600 }), ...group('new', 3, { minutesAgo: 10 })];
    const { clusters } = clusterComplaints(complaints, cfg);
    expect(clusters).toHaveLength(2);
  });

  it('treats no-water and low-pressure as one supply failure', () => {
    const complaints = [
      ...group('n', 2, { type: 'NO_WATER' }).map((c) => c),
      complaint({ id: 'p1', type: 'LOW_PRESSURE', north: 50, minutesAgo: 25 }),
      complaint({ id: 'p2', type: 'LOW_PRESSURE', north: 80, minutesAgo: 20 }),
    ];
    const { clusters } = clusterComplaints(complaints, cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].issueBreakdown).toEqual({ NO_WATER: 2, LOW_PRESSURE: 2 });
  });

  it('never mixes dirty water into a supply cluster', () => {
    const complaints = [
      ...group('s', 3, { type: 'NO_WATER' }),
      complaint({ id: 'd1', type: 'DIRTY_WATER', north: 20, minutesAgo: 25 }),
      complaint({ id: 'd2', type: 'DIRTY_WATER', north: 40, minutesAgo: 22 }),
    ];
    const { clusters, noise } = clusterComplaints(complaints, cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].family).toBe('SUPPLY');
    expect(noise.map((c) => c.id)).toEqual(['d1', 'd2']);
  });

  it('leaves sparse complaints as noise instead of inventing an incident', () => {
    const { clusters, noise } = clusterComplaints(group('a', 2), cfg);
    expect(clusters).toHaveLength(0);
    expect(noise).toHaveLength(2);
  });

  it('follows an outage that spreads along a street (chaining)', () => {
    const line = Array.from({ length: 7 }, (_, i) =>
      complaint({ id: `l${i}`, north: i * 300, minutesAgo: 30 - i }),
    );
    const { clusters } = clusterComplaints(line, cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].complaintCount).toBe(7);
    expect(clusters[0].radiusMeters).toBeGreaterThan(800); // wider than eps: it chained
  });

  it('includes complaints exactly on the time-window boundary', () => {
    const tight = resolveConfig({ minComplaints: 2, timeWindowMs: 60 * 60_000 });
    const pair = [complaint({ id: 'x1', minutesAgo: 90 }), complaint({ id: 'x2', minutesAgo: 30 })];
    expect(clusterComplaints(pair, tight).clusters).toHaveLength(1);
  });

  it('gives identical results whatever order the input arrives in', () => {
    const complaints = [...group('a', 5), ...group('b', 4, { north: 3000 }), ...group('c', 2, { east: 5000 })];
    const forward = clusterComplaints(complaints, cfg);
    const reversed = clusterComplaints([...complaints].reverse(), cfg);
    expect(reversed).toEqual(forward);
  });

  it('returns nothing for empty input', () => {
    expect(clusterComplaints([], cfg)).toEqual({ clusters: [], noise: [] });
  });
});
