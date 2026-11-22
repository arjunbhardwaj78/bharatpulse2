import { HOUR, MINUTE, cfgFor, type EngineConfig } from './config.js';
import { haversineMeters } from './geo.js';
import { FAMILY_OF, type Authenticity, type Band, type Complaint, type LatLng, type TrustSignal, type TrustSummary } from './types.js';

const START = 60;
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export const bandOf = (score: number): Band => (score >= 70 ? 'TRUSTED' : score >= 40 ? 'REVIEW' : 'LIKELY_FAKE');

/** Same photo: identical hash, or two 64-bit perceptual hashes (16 hex chars) at most 5 bits apart. */
export function sameHash(a: string, b: string): boolean {
  if (a === b) return true;
  const hex = /^[0-9a-f]{16}$/i;
  if (!hex.test(a) || !hex.test(b)) return false;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (diff) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits <= 5;
}

const words = (s?: string): Set<string> => new Set((s ?? '').toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean));
function nearlyIdentical(a?: string, b?: string): boolean {
  const A = words(a);
  const B = words(b);
  if (A.size < 3 || B.size < 3) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared) > 0.9;
}

const sharePhoto = (a: Complaint, b: Complaint): boolean => !!a.photoHashes?.some((h) => b.photoHashes?.some((g) => sameHash(h, g)));

/** Union-find over complaints: same reporter, same device, same photo or the same graph ring means one source. Returns a group label per item. */
function groups(items: readonly Complaint[]): number[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.reporterId === b.reporterId || (a.deviceId && a.deviceId === b.deviceId) || sharePhoto(a, b) || (a.ring && a.ring.id === b.ring?.id)) parent[find(i)] = find(j);
    }
  }
  return items.map((_, i) => find(i));
}

/**
 * Judges every report in one incident, then counts how many INDEPENDENT sources are left.
 * `context` is every report in the window, used to spot devices, IPs, photos and text reused elsewhere.
 * Each report starts at 60 and gains or loses points per signal; a missing signal changes nothing.
 */
export function assessTrust(members: readonly Complaint[], context: readonly Complaint[], center: LatLng, cfg: EngineConfig): TrustSummary {
  const fc = cfgFor(cfg, FAMILY_OF[members[0].issueType]);
  const corroborated = new Set(groups(members)).size >= 3;
  const authenticity = members.map((c) => assessOne(c, members, context, center, fc, corroborated));

  const kept = authenticity.map((a, i) => (a.band === 'LIKELY_FAKE' ? null : i)).filter((i): i is number => i !== null);
  const label = groups(kept.map((i) => members[i]));
  const bySource = new Map<number, number[]>();
  kept.forEach((i, k) => bySource.set(label[k], [...(bySource.get(label[k]) ?? []), authenticity[i].score]));

  const sources = [...bySource.values()].map(mean);
  const trustedSources = sources.filter((s) => s >= 70).length;
  const bands: Record<Band, number> = { TRUSTED: 0, REVIEW: 0, LIKELY_FAKE: 0 };
  for (const a of authenticity) bands[a.band]++;

  return {
    rawReports: members.length,
    independentSources: sources.length,
    trustedSources,
    nEff: round2(sources.reduce((sum, s) => sum + s / 100, 0)),
    credibility: kept.length ? round2(mean(kept.map((i) => authenticity[i].score)) / 100) : 0,
    needsVerification: trustedSources < cfg.minIndependent,
    bands,
    authenticity,
  };
}

function assessOne(c: Complaint, members: readonly Complaint[], context: readonly Complaint[], center: LatLng, fc: EngineConfig, corroborated: boolean): Authenticity {
  const signals: TrustSignal[] = [];
  const add = (code: string, points: number): number => signals.push({ code, points });
  const others = context.filter((o) => o.reporterId !== c.reporterId);

  const away = haversineMeters(c, center);
  if (away <= fc.epsMeters) add('GPS_MATCH', 15);
  else if (away > 2 * fc.epsMeters) add('GPS_FAR', -30);

  if (c.reporterHistory?.confirmedResolved) add('PAST_CONFIRMED', 10);
  if (c.reporterHistory?.lostDisputes) add('PAST_LOST_DISPUTE', -15);

  if (c.deviceId && new Set(context.filter((o) => o.deviceId === c.deviceId).map((o) => o.reporterId)).size > 2) add('DEVICE_SHARED', -25);
  if (c.ipHash && new Set(context.filter((o) => o.ipHash === c.ipHash && Math.abs(o.createdAt - c.createdAt) <= HOUR).map((o) => o.reporterId)).size > 3) add('IP_SHARED', -10);

  const reused = others.filter((o) => sharePhoto(c, o));
  if (reused.length) {
    if (reused.some((o) => haversineMeters(c, o) > 1000)) add('PHOTO_REUSED_ELSEWHERE', -40);
    else add('PHOTO_REUSED', -25);
  }
  if (c.exifTime !== undefined && c.photoHashes?.length) {
    if (Math.abs(c.exifTime - c.createdAt) <= 6 * HOUR) add('EXIF_MATCH', 5);
    else add('EXIF_MISMATCH', -10);
  }

  if (others.some((o) => nearlyIdentical(c.text, o.text))) add('TEXT_DUPLICATE', -15);
  const isNew = (x: Complaint): boolean => x.reporterAgeMs !== undefined && x.reporterAgeMs < 24 * HOUR;
  if (isNew(c) && members.filter((o) => isNew(o) && Math.abs(o.createdAt - c.createdAt) <= 10 * MINUTE).length >= 5) add('NEW_ACCOUNT_BURST', -15);
  if (c.submitMs !== undefined && c.submitMs < 3000) add('TOO_FAST', -10);
  // Found by the graph (Neo4j): linked to 2+ other accounts across ALL history, not just this window, through chains
  // of shared phones/photos or by reporting together in far-apart places. Only counted when the checks above did not
  // already catch the same thing here (no double penalty); the ring always counts as one source (see `groups`).
  const caughtHere = signals.some((x) => x.code === 'DEVICE_SHARED' || x.code.startsWith('PHOTO_REUSED'));
  // A ring found in ANOTHER city on the platform (the same one-way account fingerprints): caught on the first report
  // here, before this city has any local evidence. Same weight as a local ring; a local ring wins if both exist.
  if (c.ring && c.ring.accounts >= 3 && !caughtHere) add(c.ring.via.includes('NETWORK') ? 'NETWORK_RING' : 'GRAPH_RING', -20);
  if (corroborated) add('CORROBORATED', 10);

  const score = Math.min(100, Math.max(0, START + signals.reduce((sum, s) => sum + s.points, 0)));
  return { complaintId: c.id, score, band: bandOf(score), signals };
}
