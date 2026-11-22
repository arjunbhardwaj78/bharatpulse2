/** The kinds of water or road problem a citizen can report. */
export const ISSUE_TYPES = ['NO_WATER', 'LOW_PRESSURE', 'DIRTY_WATER', 'LEAK', 'POTHOLE', 'CAVE_IN', 'WATERLOGGING', 'OTHER_WATER', 'OTHER_ROAD'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * Issues are grouped into families. Complaints only cluster with others in the
 * same family: "no water" and "low pressure" are the same supply failure seen
 * by different households, but "dirty water" is a health problem with a
 * different response, so it must never be hidden inside a supply incident.
 */
export type IssueFamily = 'SUPPLY' | 'QUALITY' | 'INFRASTRUCTURE' | 'ROAD';

export const FAMILY_OF: Record<IssueType, IssueFamily> = {
  NO_WATER: 'SUPPLY',
  LOW_PRESSURE: 'SUPPLY',
  DIRTY_WATER: 'QUALITY',
  LEAK: 'INFRASTRUCTURE',
  POTHOLE: 'ROAD',
  CAVE_IN: 'ROAD',
  WATERLOGGING: 'ROAD',
  OTHER_WATER: 'SUPPLY',
  OTHER_ROAD: 'ROAD',
};

export interface LatLng {
  lat: number;
  lng: number;
}

export type RoadClass = 'LOCAL' | 'MAIN' | 'HIGHWAY';

/** One citizen report. `createdAt` is epoch milliseconds. */
export interface Complaint extends LatLng {
  id: string;
  reporterId: string;
  issueType: IssueType;
  createdAt: number;
  /** Trust signals. A missing signal is neutral, never a penalty. */
  deviceId?: string;
  ipHash?: string;
  /** Hex SHA-256, or a 16-hex-char perceptual hash. */
  photoHashes?: string[];
  exifTime?: number;
  /** Milliseconds between opening the form and submitting it. */
  submitMs?: number;
  text?: string;
  /** English version of `text` (Sarvam translation), and the language it was written or spoken in (BCP-47, e.g. ta-IN). */
  textEn?: string;
  language?: string;
  reporterAgeMs?: number;
  reporterHistory?: { confirmedResolved: number; lostDisputes: number };
  /** Set by the server from the nearest locality. */
  localityId?: string;
  /** Street, house or landmark typed by the citizen. */
  address?: string;
  /** Road reports only: citizen-picked size (1 small .. 3 large), road class, school/hospital nearby. */
  size?: 1 | 2 | 3;
  roadClass?: RoadClass;
  nearFacility?: boolean;
  /**
   * Set by the server from the graph database: this reporter's account is linked to 2+ other accounts
   * (shared phone or photo anywhere in history, or the same group of accounts reporting together in places far apart).
   * Accounts in one ring count as ONE source. `via` holds 'NETWORK' when the ring was found in another city on the
   * platform and this city has no local evidence yet.
   */
  ring?: { id: string; accounts: number; via: string[] };
}

/** A group of complaints that point at the same underlying problem. */
export interface Cluster {
  /** Stable id: family + the earliest complaint in the group. */
  id: string;
  family: IssueFamily;
  complaintIds: string[];
  /** Report times, ascending. Used for velocity and duration scoring. */
  reportedAt: number[];
  issueBreakdown: Partial<Record<IssueType, number>>;
  centroid: LatLng;
  /** Distance from the centroid to the furthest complaint, in metres. */
  radiusMeters: number;
  complaintCount: number;
  firstReportedAt: number;
  lastReportedAt: number;
  /** Road incidents only: the worst case among the members. */
  road?: { size: number; roadClass: RoadClass; nearFacility: boolean; photoShare: number };
}

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** One line of the score explanation, so an officer can see WHY. */
export interface SeverityFactor {
  name: 'sources' | 'spread' | 'velocity' | 'duration' | 'issue type' | 'size' | 'road class' | 'facilities' | 'photo';
  points: number;
  max: number;
  detail: string;
}

export interface Severity {
  /** 0 to 100: `base` times `credibility`. */
  score: number;
  level: SeverityLevel;
  /** The factor points. They add up to `base`. */
  factors: SeverityFactor[];
  base: number;
  /** 0 to 1, from the authenticity of the reports. 1 when no trust data is given. */
  credibility: number;
}

export type Band = 'TRUSTED' | 'REVIEW' | 'LIKELY_FAKE';

export interface TrustSignal {
  code: string;
  points: number;
}

/** Why one report is, or is not, believed. */
export interface Authenticity {
  complaintId: string;
  score: number;
  band: Band;
  signals: TrustSignal[];
}

export interface TrustSummary {
  rawReports: number;
  /** Groups of reports that do not share a reporter, device or photo, after dropping LIKELY_FAKE ones. */
  independentSources: number;
  /** Independent sources whose average authenticity is TRUSTED. Fewer than the minimum means "needs verification". */
  trustedSources: number;
  /** Independent sources weighted by authenticity (0 to 1 each). */
  nEff: number;
  credibility: number;
  needsVerification: boolean;
  bands: Record<Band, number>;
  authenticity: Authenticity[];
}

export interface Incident extends Cluster {
  severity: Severity;
  trust: TrustSummary;
  recommendedAction: string;
}
