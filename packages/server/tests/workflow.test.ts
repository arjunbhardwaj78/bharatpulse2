import { describe, expect, it } from 'vitest';
import { act, escalateIfOverdue, newWorkflow, slaMs } from '../src/workflow.js';
import { fakeIncident, T0 } from './helpers.js';

const w0 = newWorkflow(fakeIncident('i', ['a', 'b', 'c']), T0);
const step = (w: typeof w0, action: string, role: string, extra: object = {}) => act(w, { action, role: role as never, ...extra }, T0 + 1);

describe('workflow rules', () => {
  it('walks the happy path from detection to closed', () => {
    let w = w0;
    for (const [action, role, extra] of [['verify', 'L1', {}], ['approve', 'L2', {}], ['assign', 'L2', {}], ['start', 'L1', {}], ['resolve', 'L1', { proofHash: 'abc' }], ['approve-proof', 'L2', {}], ['confirm', 'CITIZEN', {}], ['close', 'L2', {}]] as const) w = step(w, action, role, extra);
    expect(w.stage).toBe('CLOSED');
    expect(w.audit.map((a) => a.action)).toEqual(['detected', 'verify', 'approve', 'assign', 'start', 'resolve', 'approve-proof', 'confirm', 'close']);
  });

  it.each([
    ['a field officer cannot approve', 'VERIFIED', 'approve', 'L1', 403],
    ['the commissioner is read-only', 'REPORTED', 'verify', 'L4', 403],
    ['a citizen cannot verify', 'REPORTED', 'verify', 'CITIZEN', 403],
    ['cannot approve before verifying', 'REPORTED', 'approve', 'L2', 409],
    ['cannot confirm before it is resolved', 'IN_PROGRESS', 'confirm', 'CITIZEN', 409],
  ])('%s', (_n, stage, action, role, status) => {
    expect(() => step({ ...w0, stage: stage as never }, action, role)).toThrow(expect.objectContaining({ statusCode: status }));
  });

  it('needs a proof photo to resolve and a reason to reject', () => {
    expect(() => step({ ...w0, stage: 'IN_PROGRESS' }, 'resolve', 'L1')).toThrow(/proof photo/);
    expect(() => step(w0, 'reject', 'L1')).toThrow(/reason/);
  });

  it('sends the fix photo to a more senior officer, who can approve it or send the work back', () => {
    const review = step({ ...w0, stage: 'IN_PROGRESS' }, 'resolve', 'L1', { proofHash: 'h' });
    expect([review.stage, review.proofBy]).toEqual(['PROOF_REVIEW', 'L1']);
    expect(() => step(review, 'approve-proof', 'L1')).toThrow(expect.objectContaining({ statusCode: 403 }));
    expect(step(review, 'approve-proof', 'L2').stage).toBe('RESOLVED');
    expect(() => step(review, 'reject-proof', 'L2')).toThrow(/reason/);
    const back = step(review, 'reject-proof', 'L2', { reason: 'photo shows a different street' });
    expect([back.stage, back.proofHash]).toEqual(['IN_PROGRESS', undefined]);
    const byZonal = step({ ...w0, stage: 'IN_PROGRESS' }, 'resolve', 'L2', { proofHash: 'h' });
    expect(() => step(byZonal, 'approve-proof', 'L2')).toThrow(expect.objectContaining({ statusCode: 403 })); // L3 must check an L2 upload
    expect(step(byZonal, 'approve-proof', 'L3').stage).toBe('RESOLVED');
  });

  it('allows one dispute against a final rejection, and L3 can overturn it', () => {
    const closed = step(step(w0, 'reject', 'L1', { reason: 'duplicate' }), 'approve-rejection', 'L2');
    expect(closed.stage).toBe('CLOSED');
    const disputed = step(closed, 'dispute', 'CITIZEN');
    expect([disputed.stage, disputed.level]).toEqual(['DISPUTED', 3]);
    expect(() => step({ ...disputed, stage: 'CLOSED' }, 'dispute', 'CITIZEN')).toThrow(/one dispute/);
    expect(step(disputed, 'decide-dispute', 'L3', { decision: 'overturn' }).stage).toBe('VERIFIED');
    expect(step(disputed, 'decide-dispute', 'L3', { decision: 'uphold' }).stage).toBe('DISPUTED'); // service closes it
    expect(() => step(w0, 'dispute', 'CITIZEN')).toThrow();
  });

  it('lets the citizen object as soon as a complaint is marked not valid', () => {
    const rejected = step(w0, 'reject', 'L1', { reason: 'duplicate' });
    expect(step(rejected, 'dispute', 'CITIZEN').stage).toBe('DISPUTED');
  });

  it('forwards one level up and stops at the department head', () => {
    const up = step(w0, 'forward', 'L1');
    expect([up.level, up.stage]).toEqual([2, 'REPORTED']);
    expect(() => step({ ...w0, level: 3 }, 'forward', 'L2')).toThrow(/top|head/i);
  });
});

describe('SLA', () => {
  const i = fakeIncident('i', ['a', 'b', 'c']);
  it('roads get three times as long', () => expect(slaMs({ ...i, family: 'ROAD' })).toBe(slaMs(i) * 3));
  it('escalates a missed deadline once, then restarts the clock', () => {
    const late = T0 + slaMs(i) + 1;
    const w = escalateIfOverdue(w0, i, late);
    expect([w.level, w.slaDueAt > late]).toEqual([2, true]);
    expect(escalateIfOverdue(w, i, late)).toBe(w);
    expect(escalateIfOverdue(w0, i, T0 + 1)).toBe(w0);
    expect(escalateIfOverdue({ ...w0, stage: 'RESOLVED' }, i, late).level).toBe(1);
  });
});
