import { resolveConfig, type ConfigOverrides } from './config.js';
import { recommendAction } from './actions.js';
import { clusterComplaints } from './cluster.js';
import { dedupeByReporter } from './dedupe.js';
import { isValidCoordinate } from './geo.js';
import { scoreSeverity } from './severity.js';
import { assessTrust } from './trust.js';
import { ISSUE_TYPES, type Complaint, type Incident } from './types.js';

/** Allow a few minutes of phone-clock drift before calling a timestamp "future". */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface RejectedComplaint {
  complaint: Complaint;
  reason: string;
}

export interface DetectionResult {
  /** Highest severity first. */
  incidents: Incident[];
  /** Valid complaints that have not (yet) joined an incident. */
  isolated: Complaint[];
  /** Complaints dropped as invalid, with the reason. Nothing is silently lost. */
  rejected: RejectedComplaint[];
  /** Repeat complaints from the same reporter that were merged away. */
  duplicatesRemoved: number;
  evaluatedAt: number;
}

/**
 * The whole pipeline: validate -> de-duplicate -> cluster -> judge trust -> score -> advise.
 * Pure function of (complaints, now, config): same input always gives the same
 * output, which makes it easy to test and safe to re-run on every new complaint.
 */
export function detectIncidents(
  complaints: readonly Complaint[],
  now: number,
  overrides: ConfigOverrides = {},
): DetectionResult {
  const cfg = resolveConfig(overrides);

  const { valid, rejected } = validate(complaints, now);
  const { kept, removed } = dedupeByReporter(valid, cfg.reporterDedupeWindowMs);
  const { clusters, noise } = clusterComplaints(kept, cfg);

  const byId = new Map(kept.map((c) => [c.id, c]));
  const incidents: Incident[] = clusters.map((cluster) => {
    const members = cluster.complaintIds.map((id) => byId.get(id) as Complaint);
    const trust = assessTrust(members, kept, cluster.centroid, cfg);
    const severity = scoreSeverity(cluster, now, cfg, trust);
    return { ...cluster, severity, trust, recommendedAction: recommendAction(cluster.family, severity.level) };
  });
  incidents.sort((a, b) => b.severity.score - a.severity.score || a.id.localeCompare(b.id));

  return { incidents, isolated: noise, rejected, duplicatesRemoved: removed.length, evaluatedAt: now };
}

function validate(complaints: readonly Complaint[], now: number) {
  const valid: Complaint[] = [];
  const rejected: RejectedComplaint[] = [];
  const seenIds = new Set<string>();

  for (const c of complaints) {
    const reason = problemWith(c, now, seenIds);
    if (reason) {
      rejected.push({ complaint: c, reason });
      continue;
    }
    seenIds.add(c.id);
    valid.push(c);
  }
  return { valid, rejected };
}

function problemWith(c: Complaint, now: number, seenIds: Set<string>): string | null {
  if (!c.id) return 'missing id';
  if (seenIds.has(c.id)) return 'duplicate complaint id';
  if (!c.reporterId) return 'missing reporter id';
  if (!(ISSUE_TYPES as readonly string[]).includes(c.issueType)) return `unknown issue type "${c.issueType}"`;
  if (!isValidCoordinate(c.lat, c.lng)) return 'invalid coordinates';
  if (!Number.isFinite(c.createdAt)) return 'invalid timestamp';
  if (c.createdAt > now + CLOCK_SKEW_MS) return 'timestamp is in the future';
  return null;
}
