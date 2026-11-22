import { ROAD_MAX, SEVERITY_MAX, cfgFor, type EngineConfig } from './config.js';
import type { Cluster, IssueFamily, RoadClass, Severity, SeverityFactor, SeverityLevel, TrustSummary } from './types.js';

const round1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const FAMILY_LABEL: Record<IssueFamily, string> = {
  SUPPLY: 'supply failure',
  QUALITY: 'water-quality (health) risk',
  INFRASTRUCTURE: 'infrastructure leak',
  ROAD: 'road defect',
};
const SIZE_LABEL = ['', 'small', 'medium', 'large'];
const CLASS_POINTS: Record<RoadClass, number> = { LOCAL: 1, MAIN: 2, HIGHWAY: 3 };

/**
 * Transparent 0-100 priority score: factor points add up to `base`, and `base` is
 * multiplied by the credibility of the reports (1 when no trust data is given).
 *
 * Water (max points): sources 30, velocity 25, spread 15, duration 15, issue type 15.
 * Roads: sources 25, size 20, road class 20, duration 15, facilities 10, photo 10.
 *
 * `sources` follows a log curve of the effective number of independent sources:
 * the 3rd matters far more than the 30th, and 25 or more is the maximum.
 */
export function scoreSeverity(cluster: Cluster, now: number, cfg: EngineConfig, trust?: TrustSummary): Severity {
  const fc = cfgFor(cfg, cluster.family);
  const ageMs = Math.max(0, now - cluster.firstReportedAt);
  const duration = clamp01(ageMs / fc.durationCapMs);
  const nEff = trust?.nEff ?? cluster.complaintCount;
  const sources: SeverityFactor = {
    name: 'sources',
    points: 0,
    max: cluster.family === 'ROAD' ? ROAD_MAX.sources : SEVERITY_MAX.sources,
    detail: trust ? `${trust.independentSources} independent sources from ${trust.rawReports} reports` : `${cluster.complaintCount} households reporting`,
  };
  sources.points = sources.max * clamp01(Math.log1p(nEff) / Math.log1p(cfg.sourcesCap));
  const age = `ongoing for ${round1(ageMs / 3_600_000)} h`;

  const factors: SeverityFactor[] = [sources];
  if (cluster.family === 'ROAD') {
    const road = cluster.road ?? { size: 1, roadClass: 'LOCAL' as RoadClass, nearFacility: false, photoShare: 0 };
    factors.push(
      { name: 'size', points: (ROAD_MAX.size * road.size) / 3, max: ROAD_MAX.size, detail: `${SIZE_LABEL[road.size] ?? 'unknown'} (picked by citizens)` },
      { name: 'road class', points: (ROAD_MAX.roadClass * CLASS_POINTS[road.roadClass]) / 3, max: ROAD_MAX.roadClass, detail: `${road.roadClass.toLowerCase()} road` },
      { name: 'duration', points: ROAD_MAX.duration * duration, max: ROAD_MAX.duration, detail: age },
      { name: 'facilities', points: road.nearFacility ? ROAD_MAX.facilities : 0, max: ROAD_MAX.facilities, detail: road.nearFacility ? 'school or hospital nearby' : 'none reported nearby' },
      { name: 'photo', points: ROAD_MAX.photo * clamp01(road.photoShare), max: ROAD_MAX.photo, detail: `${Math.round(road.photoShare * 100)}% of reports have a photo` },
    );
  } else {
    const recent = cluster.reportedAt.filter((t) => t <= now && now - t <= cfg.velocityWindowMs).length;
    factors.push(
      { name: 'velocity', points: SEVERITY_MAX.velocity * clamp01(recent / cfg.velocityCap), max: SEVERITY_MAX.velocity, detail: `${recent} new reports in the last ${Math.round(cfg.velocityWindowMs / 60_000)} min` },
      { name: 'spread', points: SEVERITY_MAX.spread * clamp01(cluster.radiusMeters / cfg.spreadCapMeters), max: SEVERITY_MAX.spread, detail: `affects an area about ${Math.round(cluster.radiusMeters)} m wide from the centre` },
      { name: 'duration', points: SEVERITY_MAX.duration * duration, max: SEVERITY_MAX.duration, detail: age },
      { name: 'issue type', points: Math.min(SEVERITY_MAX.family, cfg.familyWeight[cluster.family]), max: SEVERITY_MAX.family, detail: FAMILY_LABEL[cluster.family] },
    );
  }
  for (const f of factors) f.points = round1(f.points);

  const base = round1(factors.reduce((sum, f) => sum + f.points, 0));
  const credibility = trust?.credibility ?? 1;
  const score = round1(base * credibility);
  let level = levelFor(score, cfg);
  if (trust?.needsVerification && level === 'CRITICAL') level = 'HIGH';
  return { score, level, factors, base, credibility };
}

export function levelFor(score: number, cfg: EngineConfig): SeverityLevel {
  const t = cfg.levelThresholds;
  if (score >= t.critical) return 'CRITICAL';
  if (score >= t.high) return 'HIGH';
  if (score >= t.medium) return 'MEDIUM';
  return 'LOW';
}
