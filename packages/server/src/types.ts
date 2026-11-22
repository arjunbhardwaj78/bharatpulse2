import type { Incident } from '@bharatpulse/engine';

/**
 * open      - being watched, nobody has acted on it yet
 * escalated - an officer flagged it as needing more than the first response
 * resolved  - closed, either by an officer ('manual') or because every complaint aged out ('expired')
 * merged    - swallowed by an older incident when two outages grew into one (see mergedInto)
 */
export type IncidentStatus = 'open' | 'escalated' | 'resolved' | 'merged';
export type Resolution = 'manual' | 'expired';

/**
 * What we persist per incident. `incident` is the engine's latest view of it
 * (members, severity, advice) with `incident.id` replaced by OUR stable id.
 */
export type Role = 'L1' | 'L2' | 'L3' | 'L4' | 'CITIZEN';
export type Stage = 'REPORTED' | 'VERIFIED' | 'APPROVED' | 'ASSIGNED' | 'IN_PROGRESS' | 'PROOF_REVIEW' | 'RESOLVED' | 'CONFIRMED' | 'REJECTED' | 'DISPUTED' | 'CLOSED';

export interface Workflow {
  stage: Stage;
  /** Who must act now: 1 field officer, 2 zonal officer, 3 department head. */
  level: 1 | 2 | 3;
  slaDueAt: number;
  audit: { at: number; role: Role; action: string; note?: string }[];
  proofHash?: string;
  /** Who uploaded the fix photo. A more senior officer must check it. */
  proofBy?: Role;
  rejection?: { reason: string; approved: boolean };
  disputed?: boolean;
  disputedBy?: string;
}

export interface StoredIncident {
  incident: Incident;
  workflow?: Workflow;
  /** The photo an officer uploaded to show the problem is fixed (a small JPEG/PNG as a data URL). */
  /** `photo` is only filled by getIncident (it is kept out of list reads, which run on every request). */
  proof?: { photo?: string; hash: string; by: Role; at: number };
  /** A road incident near a recent leak: the officer confirms or rejects the link. */
  possibleCause?: { incidentId: string; distanceM: number; confirmed?: boolean };
  status: IncidentStatus;
  /** When the server first noticed it (clock time, not complaint time). */
  detectedAt: number;
  updatedAt: number;
  resolvedAt?: number;
  resolution?: Resolution;
  mergedInto?: string;
}

export const isActive = (s: StoredIncident): boolean => s.status === 'open' || s.status === 'escalated';

/** One household's answer to "did water come today?". One per person per day. */
export interface Checkin { id: string; reporterId: string; date: string; status: 'CAME' | 'LATE' | 'NONE'; lat: number; lng: number; wardId?: string; at: number }

/** An announcement by officers: a planned water cut or road work, for an area and a time window. */
export interface Notice { id: string; kind: 'WATER_CUT' | 'ROAD_WORK' | 'OTHER'; title: string; note?: string; wardIds: string[]; lat: number; lng: number; radiusM: number; startsAt: number; endsAt: number; createdBy: Role; createdAt: number }

/** What we remember about a reporter between visits (feeds the trust score). Stored on the Reporter node. */
export interface Profile { firstSeen: number; confirmedResolved: number; lostDisputes: number }
