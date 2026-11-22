import type { Incident } from '@bharatpulse/engine';
import { AppError } from './errors.js';
import type { Role, Stage, Workflow } from './types.js';

const HOUR = 3_600_000;
const SLA_HOURS = { CRITICAL: 4, HIGH: 12, MEDIUM: 24, LOW: 72 } as const;

/** Roads are slower to fix than a burst pipe, so they get three times the time. */
export const slaMs = (i: Incident): number => SLA_HOURS[i.severity.level] * HOUR * (i.family === 'ROAD' ? 3 : 1);

export const newWorkflow = (i: Incident, now: number): Workflow => ({ stage: 'REPORTED', level: 1, slaDueAt: now + slaMs(i), audit: [{ at: now, role: 'L1', action: 'detected' }] });

export interface Rule { from: Stage[]; roles: Role[]; to: Stage }
const FIELD: Role[] = ['L1', 'L2', 'L3'];
const ZONAL: Role[] = ['L2', 'L3'];

/** Who may do what, and where it leads. `forward` and `decide-dispute` have extra logic in `act`. */
export const RULES: Record<string, Rule> = {
  verify: { from: ['REPORTED'], roles: FIELD, to: 'VERIFIED' },
  approve: { from: ['VERIFIED'], roles: ZONAL, to: 'APPROVED' },
  assign: { from: ['APPROVED'], roles: ZONAL, to: 'ASSIGNED' },
  start: { from: ['ASSIGNED'], roles: ['L1', 'L2'], to: 'IN_PROGRESS' },
  resolve: { from: ['ASSIGNED', 'IN_PROGRESS'], roles: ['L1', 'L2'], to: 'PROOF_REVIEW' },
  'approve-proof': { from: ['PROOF_REVIEW'], roles: ZONAL, to: 'RESOLVED' },
  'reject-proof': { from: ['PROOF_REVIEW'], roles: ZONAL, to: 'IN_PROGRESS' },
  confirm: { from: ['RESOLVED'], roles: ['CITIZEN'], to: 'CONFIRMED' },
  close: { from: ['CONFIRMED'], roles: ZONAL, to: 'CLOSED' },
  reopen: { from: ['RESOLVED', 'CONFIRMED'], roles: ['CITIZEN', 'L2', 'L3'], to: 'ASSIGNED' },
  'send-back': { from: ['VERIFIED', 'APPROVED', 'REJECTED'], roles: ZONAL, to: 'REPORTED' },
  reject: { from: ['REPORTED', 'VERIFIED'], roles: ['L1', 'L2'], to: 'REJECTED' },
  'approve-rejection': { from: ['REJECTED'], roles: ZONAL, to: 'CLOSED' },
  dispute: { from: ['REJECTED', 'CLOSED'], roles: ['CITIZEN'], to: 'DISPUTED' },
  'decide-dispute': { from: ['DISPUTED'], roles: ['L3'], to: 'CLOSED' },
  forward: { from: ['REPORTED', 'VERIFIED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'PROOF_REVIEW', 'REJECTED', 'DISPUTED'], roles: ['L1', 'L2'], to: 'REPORTED' },
};

const RANK: Record<Role, number> = { CITIZEN: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

export interface ActInput { action: string; role: Role; note?: string; reason?: string; proofHash?: string; decision?: string }

/** Pure: returns the next workflow, or throws a 4xx explaining why the step is not allowed. */
export function act(w: Workflow, input: ActInput, now: number): Workflow {
  const rule = RULES[input.action];
  if (!rule) throw new AppError(404, 'unknown_action', `Unknown action "${input.action}"`);
  if (!rule.roles.includes(input.role)) throw new AppError(403, 'forbidden', `${input.role} cannot ${input.action}`);
  if (!rule.from.includes(w.stage)) throw new AppError(409, 'wrong_stage', `Cannot ${input.action} while the incident is ${w.stage}`);

  const next: Workflow = { ...w, audit: [...w.audit, { at: now, role: input.role, action: input.action, note: input.note ?? input.reason }] };
  const need = (v: string | undefined, what: string): string => {
    if (!v?.trim()) throw new AppError(400, 'validation_error', `${input.action} needs ${what}`);
    return v.trim();
  };

  switch (input.action) {
    case 'resolve': next.proofHash = need(input.proofHash, 'a proof photo'); next.proofBy = input.role; break;
    case 'approve-proof':
    case 'reject-proof':
      if (RANK[input.role] <= RANK[w.proofBy ?? 'L1']) throw new AppError(403, 'same_level', 'A more senior officer than the one who uploaded the photo must check it');
      if (input.action === 'reject-proof') { need(input.reason, 'a reason'); delete next.proofHash; delete next.proofBy; }
      break;
    case 'reject': next.rejection = { reason: need(input.reason, 'a reason'), approved: false }; break;
    case 'approve-rejection': next.rejection = { ...w.rejection!, approved: true }; break;
    case 'send-back': delete next.rejection; break;
    case 'dispute':
      if (w.disputed || !w.rejection) throw new AppError(409, 'cannot_dispute', 'Only one dispute, and only against a rejection');
      next.disputed = true; next.level = 3; break;
    case 'decide-dispute':
      if (input.decision === 'overturn') { delete next.rejection; next.stage = 'VERIFIED'; return next; }
      if (input.decision !== 'uphold') throw new AppError(400, 'validation_error', 'decision must be "uphold" or "overturn"');
      return next;
    case 'reopen': next.level = Math.min(3, w.level + 1) as 1 | 2 | 3; delete next.proofHash; break;
    case 'forward':
      if (w.level === 3) throw new AppError(409, 'already_top', 'Already with the department head');
      next.level = (w.level + 1) as 2 | 3; next.stage = w.stage; return next;
  }
  next.stage = rule.to;
  return next;
}

/** A missed SLA moves the incident one level up and restarts the clock. Pure. */
export function escalateIfOverdue(w: Workflow, i: Incident, now: number): Workflow {
  const final: Stage[] = ['RESOLVED', 'CONFIRMED', 'CLOSED'];
  if (now < w.slaDueAt || final.includes(w.stage) || w.level === 3) return w;
  return { ...w, level: (w.level + 1) as 2 | 3, slaDueAt: now + slaMs(i), audit: [...w.audit, { at: now, role: 'L1', action: 'sla-breach', note: `moved to level ${w.level + 1}` }] };
}

/** Stages where the incident is finished for the engine (its complaints must not seed a new incident). */
export const isFinished = (s: Stage): boolean => s === 'RESOLVED' || s === 'CONFIRMED' || s === 'CLOSED';
