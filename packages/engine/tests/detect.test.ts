import { describe, expect, it } from 'vitest';
import { detectIncidents } from '../src/detect.js';
import { resolveConfig } from '../src/config.js';
import type { Complaint } from '../src/types.js';
import { NOW, complaint, group } from './helpers.js';

describe('detectIncidents', () => {
  it('turns complaints into scored incidents with an explanation and an action', () => {
    const { incidents } = detectIncidents(group('a', 8, { spreadM: 300 }), NOW);
    expect(incidents).toHaveLength(1);
    const [incident] = incidents;
    expect(incident.severity.factors).toHaveLength(5);
    expect(incident.recommendedAction.length).toBeGreaterThan(10);
    expect(incident.complaintIds).toHaveLength(8);
  });

  it('lists the most severe incident first', () => {
    const complaints = [...group('minor', 3, { type: 'LEAK' }), ...group('major', 15, { north: 4000, type: 'DIRTY_WATER', minutesAgo: 10 })];
    const { incidents } = detectIncidents(complaints, NOW);
    expect(incidents).toHaveLength(2);
    expect(incidents[0].family).toBe('QUALITY');
    expect(incidents[0].severity.score).toBeGreaterThan(incidents[1].severity.score);
  });

  it('counts one reporter spamming once, so spam cannot fake an outage', () => {
    const spam: Complaint[] = Array.from({ length: 10 }, (_, i) =>
      complaint({ id: `s${i}`, reporter: 'same-person', minutesAgo: 20 - i }),
    );
    const result = detectIncidents(spam, NOW);
    expect(result.duplicatesRemoved).toBe(9);
    expect(result.incidents).toHaveLength(0);
  });

  it('rejects invalid complaints with a reason instead of dropping them silently', () => {
    const good = group('g', 3);
    const bad: Complaint[] = [
      { ...complaint({ id: 'b1' }), lat: 200 },
      { ...complaint({ id: 'b2' }), issueType: 'FIRE' as never },
      { ...complaint({ id: 'b3' }), createdAt: Number.NaN },
      { ...complaint({ id: 'g1' }) },
      { ...complaint({ id: 'b5' }), createdAt: NOW + 60 * 60_000 },
    ];
    const { rejected, incidents } = detectIncidents([...good, ...bad], NOW);
    expect(rejected.map((r) => r.complaint.id)).toEqual(['b1', 'b2', 'b3', 'g1', 'b5']);
    expect(rejected.map((r) => r.reason)).toEqual([
      'invalid coordinates',
      'unknown issue type "FIRE"',
      'invalid timestamp',
      'duplicate complaint id',
      'timestamp is in the future',
    ]);
    expect(incidents).toHaveLength(1);
  });

  it('reports lone complaints as isolated', () => {
    const { isolated, incidents } = detectIncidents(group('a', 2), NOW);
    expect(incidents).toHaveLength(0);
    expect(isolated).toHaveLength(2);
  });

  it('handles empty input', () => {
    const r = detectIncidents([], NOW);
    expect(r).toEqual({ incidents: [], isolated: [], rejected: [], duplicatesRemoved: 0, evaluatedAt: NOW });
  });

  it('is deterministic: same input, same output', () => {
    const complaints = [...group('a', 6), ...group('b', 5, { north: 3000, type: 'LEAK' })];
    expect(detectIncidents(complaints, NOW)).toEqual(detectIncidents([...complaints].reverse(), NOW));
  });

  it('rejects an invalid configuration early', () => {
    expect(() => detectIncidents([], NOW, { epsMeters: -5 })).toThrow(/epsMeters/);
    expect(() => detectIncidents([], NOW, { minComplaints: 1 })).toThrow(/minComplaints/);
    expect(() => resolveConfig({ levelThresholds: { medium: 60, high: 50 } })).toThrow(/levelThresholds/);
  });
});
