import { describe, expect, it } from 'vitest';
import type { Incident, Role, Rules } from '../src/api';
import { ageText, phaseOf, zoneIdOf, agoParts, forwardInfo, actionsFor, categoryOf, dueText, haversine, inTab, levelRole, nearby, nearbyAny, progress, reasons, signalSummary, stepsDone, topIssue } from '../src/util';

const rules: Rules = {
  verify: { from: ['REPORTED'], roles: ['L1', 'L2', 'L3'], to: 'VERIFIED' },
  approve: { from: ['VERIFIED'], roles: ['L2', 'L3'], to: 'APPROVED' },
  confirm: { from: ['RESOLVED'], roles: ['CITIZEN'], to: 'CONFIRMED' },
};
const inc = (o: Partial<Incident> = {}): Incident => ({
  id: 'i', family: 'SUPPLY', complaintCount: 5, centroid: { lat: 27.4924, lng: 77.6737 }, radiusMeters: 100, firstReportedAt: 0, lastReportedAt: 0, issueBreakdown: {}, recommendedAction: '', status: 'open',
  severity: { score: 80, level: 'CRITICAL', base: 90, credibility: 0.9, factors: [] },
  trust: { rawReports: 5, independentSources: 5, trustedSources: 5, nEff: 4, credibility: 0.9, needsVerification: false, bands: { TRUSTED: 5, REVIEW: 0, LIKELY_FAKE: 0 }, authenticity: [] },
  workflow: { stage: 'REPORTED', level: 1, slaDueAt: 0, audit: [] }, ...o,
});

describe('helpers', () => {
  it('measures distance in metres', () => expect(Math.round(haversine({ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }))).toBe(111));
  it('formats the SLA clock', () => {
    expect(dueText(130 * 60_000, 0)).toBe('Act within 2 h 10 min');
    expect(dueText(0, 45 * 60_000)).toBe('Overdue by 45 min');
  });
  it('maps stages to tracker steps', () => expect(['REPORTED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'nonsense'].map(progress)).toEqual([0, 2, 3, 4, 5, 0]));
  it('lists only actions the role may take at that stage', () => {
    expect(actionsFor(rules, 'REPORTED', 'L1')).toEqual(['verify']);
    expect(actionsFor(rules, 'VERIFIED', 'L1')).toEqual([]);
    expect(actionsFor(rules, 'VERIFIED', 'L2')).toEqual(['approve']);
    expect(actionsFor(rules, 'RESOLVED', 'CITIZEN')).toEqual(['confirm']);
  });
  it('sorts incidents into the officer tabs', () => {
    expect(inTab(inc(), 'critical', 'L2', rules)).toBe(true);
    expect(inTab(inc(), 'high', 'L2', rules)).toBe(false);
    expect(inTab(inc({ trust: { ...inc().trust, needsVerification: true } }), 'verify', 'L2', rules)).toBe(true);
    expect(inTab(inc(), 'mine', 'L4', rules)).toBe(false);
    expect(inTab(inc(), 'mine', 'L1', rules)).toBe(true);
    expect(inTab(inc({ workflow: { stage: 'REPORTED', level: 2, slaDueAt: 0, audit: [] } }), 'escalated', 'L2', rules)).toBe(true);
  });
  it('finds open incidents of the same kind nearby', () => {
    const here = { lat: 27.4924, lng: 77.6737 };
    expect(nearby([inc()], here, false)).toHaveLength(1);
    expect(nearby([inc()], here, true)).toHaveLength(0);
    expect(nearby([inc({ status: 'resolved' })], here, false)).toHaveLength(0);
    expect(nearby([inc()], { lat: 27.51, lng: 77.6737 }, false)).toHaveLength(0);
  });
  it('summarises signals by total effect', () => {
    const a = (signals: { code: string; points: number }[]) => ({ complaintId: 'c', score: 50, band: 'REVIEW' as const, signals });
    const i = inc({ trust: { ...inc().trust, authenticity: [a([{ code: 'GPS_MATCH', points: 15 }, { code: 'DEVICE_SHARED', points: -25 }]), a([{ code: 'DEVICE_SHARED', points: -25 }])] } });
    expect(signalSummary(i).map((s) => [s.code, s.count])).toEqual([['DEVICE_SHARED', 2], ['GPS_MATCH', 1]]);
  });

  it('lists every kind of open problem near a point, nearest first', () => {
    const here = { lat: 27.4924, lng: 77.6737 };
    const road = inc({ id: 'r', family: 'ROAD', centroid: { lat: 27.4926, lng: 77.6737 } });
    const water = inc({ id: 'w', centroid: { lat: 27.4934, lng: 77.6737 } });
    expect(nearbyAny([water, road], here).map((i) => i.id)).toEqual(['r', 'w']);
    expect(nearbyAny([water], { lat: 27.6, lng: 77.6737 })).toHaveLength(0);
  });
  it('counts the steps a citizen sees as complete', () => expect(['REPORTED', 'VERIFIED', 'ASSIGNED', 'PROOF_REVIEW', 'RESOLVED', 'CONFIRMED', 'REJECTED'].map(stepsDone)).toEqual([1, 2, 4, 6, 7, 8, 1]));
  it('names the category, level role and main issue', () => {
    expect(['POTHOLE', 'OTHER_ROAD', 'NO_WATER', 'OTHER_WATER'].map(categoryOf)).toEqual(['ROADS', 'ROADS', 'WATER', 'WATER']);
    expect([1, 2, 3].map(levelRole)).toEqual(['L1', 'L2', 'L3']);
    expect(topIssue(inc({ issueBreakdown: { LEAK: 5, NO_WATER: 2 } }))).toBe('LEAK');
    expect(topIssue(inc({ family: 'ROAD', issueBreakdown: {} }))).toBe('OTHER_ROAD');
  });

  it('explains an incident in plain words', () => {
    const i = inc({ trust: { ...inc().trust, independentSources: 3, rawReports: 50, needsVerification: true }, severity: { ...inc().severity, factors: [{ name: 'velocity', points: 20, max: 25, detail: '' }] } });
    const r = reasons(i);
    expect(r[0]).toBe('3 different people reported this (50 reports in all).');
    expect(r).toContain('New reports are still coming in.');
    expect(r.join(' ')).toContain('Not confirmed yet');
  });

  it('says where a passed-up incident came from', () => {
    const w = (audit: { at: number; role: Role; action: string; note?: string }[], level: 1 | 2 | 3) => ({ stage: 'REPORTED', level, slaDueAt: 0, audit });
    expect(forwardInfo(inc())).toBeUndefined();
    expect(forwardInfo(inc({ workflow: w([{ at: 5, role: 'L1', action: 'forward', note: 'needs a crew' }], 2) }))).toEqual({ from: 'L1', note: 'needs a crew', at: 5, auto: false });
    expect(forwardInfo(inc({ workflow: w([{ at: 9, role: 'L1', action: 'sla-breach' }], 2) }))).toMatchObject({ from: 'L1', auto: true });
    expect(forwardInfo(inc({ workflow: w([{ at: 9, role: 'CITIZEN', action: 'dispute', note: 'it is real' }], 3) }))).toMatchObject({ from: 'CITIZEN', note: 'it is real' });
  });
  it('turns time into a message key and a number', () => {
    expect([0, 90_000, 2 * 3_600_000, 3 * 86_400_000].map((d) => agoParts(1_000_000 - d, 1_000_000))).toEqual([['ago_now', 0], ['ago_min', 2], ['ago_hr', 2], ['ago_day', 3]]);
  });

  it('says how long ago something was reported', () => {
    expect([0, 5 * 60_000, 130 * 60_000, 60 * 60_000, 3 * 86_400_000, 86_400_000].map((d) => ageText(10_000_000_000 - d, 10_000_000_000))).toEqual(['just now', '5 min ago', '2 h 10 min ago', '1 h ago', '3 days ago', '1 day ago']);
  });
  it('puts incidents in board columns and finds their zone', () => {
    expect(['REPORTED', 'APPROVED', 'REJECTED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_REVIEW', 'RESOLVED', 'CLOSED'].map(phaseOf)).toEqual(['new', 'new', 'new', 'working', 'working', 'check', 'done', 'done']);
    const city = { localities: [{ zoneId: 'Z1', lat: 0, lng: 0 }, { zoneId: 'Z2', lat: 1, lng: 1 }] };
    expect(zoneIdOf({ lat: 0.9, lng: 0.9 }, city)).toBe('Z2');
    expect(zoneIdOf({ lat: 0, lng: 0 })).toBeUndefined();
  });
});
