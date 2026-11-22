import { describe, expect, it } from 'vitest';
import { reconcile } from '../src/reconcile.js';
import { T0, fakeIncident, fakeStored } from './helpers.js';

const NOW = T0 + 60_000;

describe('reconcile: keeping incident identity stable', () => {
  it('a group with no stored match becomes a NEW open incident using the engine id', () => {
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c'])], stored: [], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].incident.id).toBe('SUPPLY:a');
    expect(out[0].status).toBe('open');
    expect(out[0].detectedAt).toBe(NOW);
  });

  it('the same members keep the stored id, detectedAt, and get a refreshed snapshot', () => {
    const stored = fakeStored('SUPPLY:a', ['a', 'b', 'c'], { detectedAt: T0 });
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c', 'd'])], stored: [stored], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].incident.id).toBe('SUPPLY:a');
    expect(out[0].incident.complaintCount).toBe(4);
    expect(out[0].detectedAt).toBe(T0);
    expect(out[0].updatedAt).toBe(NOW);
  });

  it('keeps the stored id even when the earliest complaint aged out (engine id changed)', () => {
    const stored = fakeStored('SUPPLY:a', ['a', 'b', 'c']);
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:b', ['b', 'c', 'd'])], stored: [stored], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].incident.id).toBe('SUPPLY:a');
    expect(out[0].incident.complaintIds).toEqual(['b', 'c', 'd']);
  });

  it('merge: the OLDEST incident survives, the other becomes merged with a pointer', () => {
    const older = fakeStored('SUPPLY:a', ['a', 'b', 'c'], { detectedAt: T0 });
    const newer = fakeStored('SUPPLY:x', ['x', 'y', 'z'], { detectedAt: T0 + 1000 });
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c', 'x', 'y', 'z'])], stored: [newer, older], now: NOW });
    const survivor = out.find((s) => s.incident.id === 'SUPPLY:a')!;
    const absorbed = out.find((s) => s.incident.id === 'SUPPLY:x')!;
    expect(survivor.status).toBe('open');
    expect(survivor.incident.complaintCount).toBe(6);
    expect(absorbed.status).toBe('merged');
    expect(absorbed.mergedInto).toBe('SUPPLY:a');
  });

  it('merge keeps "escalated" if either incident was escalated', () => {
    const older = fakeStored('SUPPLY:a', ['a', 'b', 'c'], { detectedAt: T0 });
    const newer = fakeStored('SUPPLY:x', ['x', 'y', 'z'], { detectedAt: T0 + 1000, status: 'escalated' });
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c', 'x', 'y', 'z'])], stored: [older, newer], now: NOW });
    expect(out.find((s) => s.incident.id === 'SUPPLY:a')!.status).toBe('escalated');
  });

  it('split: the group sharing the most complaints keeps the id, the other is new', () => {
    const stored = fakeStored('SUPPLY:a', ['a', 'b', 'c', 'd', 'e']);
    const out = reconcile({
      clusters: [fakeIncident('SUPPLY:d', ['d', 'e'], { firstReportedAt: T0 + 5 }), fakeIncident('SUPPLY:a', ['a', 'b', 'c'])],
      stored: [stored],
      now: NOW,
    });
    const keeper = out.find((s) => s.incident.complaintIds.includes('a'))!;
    const spinOff = out.find((s) => s.incident.complaintIds.includes('d'))!;
    expect(keeper.incident.id).toBe('SUPPLY:a');
    expect(spinOff.incident.id).toBe('SUPPLY:d');
    expect(spinOff.status).toBe('open');
    expect(spinOff.detectedAt).toBe(NOW);
  });

  it('a new incident never reuses an id that is already taken (suffix #2)', () => {
    const stored = fakeStored('SUPPLY:a', ['a', 'b', 'c', 'd', 'e']);
    const out = reconcile({
      clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c']), fakeIncident('SUPPLY:a', ['d', 'e'], { firstReportedAt: T0 + 5 })],
      stored: [stored],
      now: NOW,
    });
    const ids = out.map((s) => s.incident.id).sort();
    expect(ids).toEqual(['SUPPLY:a', 'SUPPLY:a#2']);
  });

  it('an active incident with no group left expires', () => {
    const stored = fakeStored('SUPPLY:a', ['a', 'b', 'c']);
    const out = reconcile({ clusters: [], stored: [stored], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('resolved');
    expect(out[0].resolution).toBe('expired');
    expect(out[0].resolvedAt).toBe(NOW);
  });

  it('resolved and merged incidents are left alone and never matched', () => {
    const resolved = fakeStored('SUPPLY:a', ['a', 'b', 'c'], { status: 'resolved', resolution: 'manual', resolvedAt: T0 });
    const out = reconcile({ clusters: [fakeIncident('SUPPLY:a', ['a', 'b', 'c'])], stored: [resolved], now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('open');
    expect(out[0].incident.id).toBe('SUPPLY:a#2');
  });

  it('gives the same result whatever order the stored incidents arrive in', () => {
    const s1 = fakeStored('SUPPLY:a', ['a', 'b', 'c'], { detectedAt: T0 });
    const s2 = fakeStored('SUPPLY:x', ['x', 'y', 'z'], { detectedAt: T0 + 1000 });
    const cluster = fakeIncident('SUPPLY:a', ['a', 'b', 'c', 'x', 'y', 'z']);
    const one = reconcile({ clusters: [cluster], stored: [s1, s2], now: NOW });
    const two = reconcile({ clusters: [cluster], stored: [s2, s1], now: NOW });
    const key = (r: typeof one) => r.map((s) => `${s.incident.id}:${s.status}`).sort();
    expect(key(one)).toEqual(key(two));
  });
});
