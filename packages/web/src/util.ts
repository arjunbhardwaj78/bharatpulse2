import type { Incident, Level, Role, Rules } from './api';

export const LEVEL_COLOR: Record<Level, string> = { CRITICAL: '#DC2626', HIGH: '#EA580C', MEDIUM: '#B45309', LOW: '#78716C' };
export const VERIFY_COLOR = '#57534E';

export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** The deadline for the current handler, in words. If it passes, the incident moves up a level by itself. */
export function dueText(dueAt: number, now: number): string {
  const mins = Math.round(Math.abs(dueAt - now) / 60_000);
  const t = mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`;
  return dueAt >= now ? `Act within ${t}` : `Overdue by ${t}`;
}

const DONE_STAGES = ['RESOLVED', 'CONFIRMED', 'CLOSED'];
export const isDone = (i: Incident): boolean => DONE_STAGES.includes(i.workflow?.stage ?? '');

/** Where a citizen's complaint is on the six-step tracker (0 = reported ... 5 = confirmed). */
export function progress(stage: string): number {
  return ({ REPORTED: 0, VERIFIED: 1, APPROVED: 1, ASSIGNED: 2, IN_PROGRESS: 3, RESOLVED: 4, CONFIRMED: 5, CLOSED: 5, REJECTED: 0, DISPUTED: 1 } as Record<string, number>)[stage] ?? 0;
}

/** Actions this role may take right now. The rules come from the server so there is one source of truth. */
export function actionsFor(rules: Rules, stage: string, role: Role): string[] {
  return Object.entries(rules).filter(([, r]) => r.from.includes(stage) && r.roles.includes(role)).map(([a]) => a);
}

export type Tab = 'critical' | 'high' | 'urgent' | 'verify' | 'mine' | 'escalated' | 'forwarded' | 'all';
export function inTab(i: Incident, tab: Tab, role: Role, rules: Rules): boolean {
  const live = !isDone(i) || i.workflow?.stage === 'RESOLVED';
  switch (tab) {
    case 'critical': return live && i.severity.level === 'CRITICAL';
    case 'high': return live && i.severity.level === 'HIGH';
    case 'urgent': return live && (i.severity.level === 'CRITICAL' || i.severity.level === 'HIGH') && !i.trust.needsVerification;
    case 'verify': return i.trust.needsVerification && !isDone(i);
    case 'mine': return actionsFor(rules, i.workflow?.stage ?? 'REPORTED', role).some((a) => !['confirm', 'dispute', 'reopen'].includes(a));
    case 'forwarded': return !isDone(i) && !!forwardInfo(i) && levelRole(i.workflow?.level ?? 1) === role;
    case 'escalated': return (i.workflow?.level ?? 1) > 1 && !isDone(i);
    default: return true;
  }
}

/** Open incidents of the same kind close to a point: the "someone already reported this" candidates. */
export function nearby(incidents: Incident[], at: { lat: number; lng: number }, road: boolean, metres = 300): Incident[] {
  return incidents.filter((i) => i.status === 'open' && (i.family === 'ROAD') === road && haversine(at, i.centroid) <= metres + i.radiusMeters / 2);
}

/** Total points per signal across an incident's reports, biggest effect first. */
export function signalSummary(i: Incident): { code: string; count: number; points: number }[] {
  const m = new Map<string, { code: string; count: number; points: number }>();
  for (const a of i.trust.authenticity) for (const s of a.signals) {
    const e = m.get(s.code) ?? { code: s.code, count: 0, points: s.points };
    e.count++;
    m.set(s.code, e);
  }
  return [...m.values()].sort((a, b) => Math.abs(b.points * b.count) - Math.abs(a.points * a.count));
}

export const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Every open incident within `metres` of a point, whatever the kind: the "problems near you" list. */
export const nearbyAny = (incidents: Incident[], at: { lat: number; lng: number }, metres = 500): Incident[] =>
  incidents.filter((i) => i.status === 'open' && haversine(at, i.centroid) <= metres + i.radiusMeters / 2).sort((a, b) => haversine(at, a.centroid) - haversine(at, b.centroid));

export const ROLE_LABEL: Record<Role, string> = { L1: 'Field officer', L2: 'Zonal officer', L3: 'Department head', L4: 'Commissioner', CITIZEN: 'Citizen' };
export const levelRole = (level: number): Role => (level >= 3 ? 'L3' : level === 2 ? 'L2' : 'L1');
export const categoryOf = (issueType: string): 'WATER' | 'ROADS' => (['POTHOLE', 'CAVE_IN', 'WATERLOGGING', 'OTHER_ROAD'].includes(issueType) ? 'ROADS' : 'WATER');
export const topIssue = (i: Incident): string => Object.entries(i.issueBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? (i.family === 'ROAD' ? 'OTHER_ROAD' : 'OTHER_WATER');

/** How many of the seven citizen-facing steps are complete for a workflow stage. */
export const stepsDone = (stage: string): number => ({ REPORTED: 1, VERIFIED: 2, APPROVED: 3, ASSIGNED: 4, IN_PROGRESS: 5, PROOF_REVIEW: 6, RESOLVED: 7, CONFIRMED: 8, CLOSED: 8, REJECTED: 1, DISPUTED: 1 } as Record<string, number>)[stage] ?? 1;

/** Officer-friendly names for the workflow stages. */
export const STAGE_WORDS: Record<string, string> = { REPORTED: 'New, needs a site check', VERIFIED: 'Checked, waiting for approval', APPROVED: 'Approved, assign a crew', ASSIGNED: 'Crew assigned', IN_PROGRESS: 'Work in progress', PROOF_REVIEW: 'Fix photo waiting for a senior officer', RESOLVED: 'Fixed, waiting for the citizen', CONFIRMED: 'Confirmed by the citizen', CLOSED: 'Closed', REJECTED: 'Rejected, waiting for approval', DISPUTED: 'Citizen objected' };

/** Why an incident ranks where it does, in plain sentences (the numbers stay under "Technical details"). */
export function reasons(i: Incident): string[] {
  const t = i.trust;
  const f = (name: string) => i.severity.factors.find((x) => x.name === name);
  const high = (name: string) => { const x = f(name); return !!x && x.points >= x.max * 0.4; };
  const out = [`${t.independentSources} different ${t.independentSources === 1 ? 'person' : 'people'} reported this${t.rawReports > t.independentSources ? ` (${t.rawReports} reports in all)` : ''}.`];
  if (high('velocity')) out.push('New reports are still coming in.');
  if (high('spread')) out.push('It affects a wide area.');
  if (high('duration')) out.push('It has been going on for a long time.');
  if (high('size')) out.push('The damage is large.');
  if (high('road class')) out.push('It is on a busy road.');
  if ((f('facilities')?.points ?? 0) > 0) out.push('It is near a school or hospital.');
  if (i.family === 'QUALITY') out.push('Dirty water is a health risk.');
  if (i.trust.authenticity.some((a) => a.signals.some((g) => g.code === 'DEVICE_SHARED'))) out.push('Several reports came from the same phone, so they count as one person.');
  if (t.needsVerification) out.push('Not confirmed yet: fewer than 3 trusted people have reported it.');
  else if (t.bands.LIKELY_FAKE > 0) out.push(`${t.bands.LIKELY_FAKE} report${t.bands.LIKELY_FAKE > 1 ? 's' : ''} looked fake and ${t.bands.LIKELY_FAKE > 1 ? 'were' : 'was'} left out.`);
  return out.slice(0, 5);
}

/** Where an incident came from if it was passed up: by an officer, or automatically because the deadline passed. */
export function forwardInfo(i: Incident): { from: Role; note?: string; at: number; auto: boolean } | undefined {
  if ((i.workflow?.level ?? 1) < 2) return undefined;
  const e = [...(i.workflow?.audit ?? [])].reverse().find((a) => a.action === 'forward' || a.action === 'sla-breach' || a.action === 'dispute');
  if (!e) return undefined;
  return { from: e.action === 'dispute' ? 'CITIZEN' : e.action === 'sla-breach' ? levelRole((i.workflow?.level ?? 2) - 1) : e.role, note: e.note, at: e.at, auto: e.action === 'sla-breach' };
}

/** "5 min ago" as a key plus a number, so the caller can translate it. */
export function agoParts(at: number, now: number): ['ago_now' | 'ago_min' | 'ago_hr' | 'ago_day', number] {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  return mins < 1 ? ['ago_now', 0] : mins < 60 ? ['ago_min', mins] : mins < 1440 ? ['ago_hr', Math.round(mins / 60)] : ['ago_day', Math.round(mins / 1440)];
}

/** How long ago, in short words: "5 min ago", "2 h 10 min ago", "3 days ago". */
export function ageText(at: number, now: number): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) { const m = mins % 60; return `${Math.floor(mins / 60)} h${m ? ` ${m} min` : ''} ago`; }
  const d = Math.floor(mins / 1440);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

export type Phase = 'new' | 'working' | 'check' | 'done';
/** Which column of the board an incident belongs in. */
export const phaseOf = (stage: string): Phase => (['ASSIGNED', 'IN_PROGRESS'].includes(stage) ? 'working' : stage === 'PROOF_REVIEW' ? 'check' : ['RESOLVED', 'CONFIRMED', 'CLOSED'].includes(stage) ? 'done' : 'new');

/** The zone an incident is in: the zone of the nearest ward. */
export const zoneIdOf = (pt: { lat: number; lng: number }, city?: { localities: { zoneId: string; lat: number; lng: number }[] }): string | undefined =>
  city ? [...city.localities].sort((a, b) => haversine(pt, a) - haversine(pt, b))[0]?.zoneId : undefined;

/** Reads text out loud with the browser's own voice (Hindi or English). No server and no key needed. */
export const canSpeak = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window;
export function speak(text: string, hindi: boolean): void {
  if (!canSpeak()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = hindi ? 'hi-IN' : 'en-IN';
  window.speechSynthesis.speak(u);
}
export const stopSpeaking = (): void => { if (canSpeak()) window.speechSynthesis.cancel(); };
/** The calendar date in India (YYYY-MM-DD): what "today" means for the water diary. */
export const istDate = (t: number): string => new Date(t + 19_800_000).toISOString().slice(0, 10);
