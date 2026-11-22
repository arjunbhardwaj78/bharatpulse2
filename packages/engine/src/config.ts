import type { IssueFamily } from './types.js';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Maximum points each severity factor can contribute. They sum to 100. */
export const SEVERITY_MAX = { sources: 30, spread: 15, velocity: 25, duration: 15, family: 15 } as const;

/** Same idea for road incidents. They also sum to 100. */
export const ROAD_MAX = { sources: 25, size: 20, roadClass: 20, duration: 15, facilities: 10, photo: 10 } as const;

export interface EngineConfig {
  /** Two complaints are "near" each other if within this many metres. */
  epsMeters: number;
  /** ...and "close in time" if reported within this many milliseconds. */
  timeWindowMs: number;
  /** Minimum complaints (after de-duplication) before a cluster becomes an incident. */
  minComplaints: number;
  /** Repeat complaints from one reporter inside this window count once. */
  reporterDedupeWindowMs: number;
  /** "Recent" complaints, for the velocity factor, are those within this window of now. */
  velocityWindowMs: number;
  /** Effective independent sources at which the sources factor is maxed out. */
  sourcesCap: number;
  /** Trusted independent sources needed before an incident may be CRITICAL. */
  minIndependent: number;
  /** Cluster radius (m) at which the spread factor is maxed out. */
  spreadCapMeters: number;
  /** Recent-complaint count at which the velocity factor is maxed out. */
  velocityCap: number;
  /** Incident age at which the duration factor is maxed out. */
  durationCapMs: number;
  /** Score cut-offs (0 to 100) for each level. Below `medium` is LOW. */
  levelThresholds: { medium: number; high: number; critical: number };
  /** Points added by issue family: health risks outrank leaks. Max 15 each. */
  familyWeight: Record<IssueFamily, number>;
  /** Per-family replacements for the four settings below (roads are small and slow, water is wide and fast). */
  perFamily: Partial<Record<IssueFamily, Partial<Pick<EngineConfig, 'epsMeters' | 'timeWindowMs' | 'minComplaints' | 'durationCapMs'>>>>;
}

export const DEFAULT_CONFIG: EngineConfig = {
  epsMeters: 500,
  timeWindowMs: 3 * HOUR,
  minComplaints: 3,
  reporterDedupeWindowMs: 30 * MINUTE,
  velocityWindowMs: 30 * MINUTE,
  sourcesCap: 25,
  minIndependent: 3,
  spreadCapMeters: 800,
  velocityCap: 8,
  durationCapMs: 12 * HOUR,
  levelThresholds: { medium: 25, high: 50, critical: 75 },
  familyWeight: { QUALITY: 15, SUPPLY: 10, INFRASTRUCTURE: 6, ROAD: 0 },
  perFamily: { ROAD: { epsMeters: 40, timeWindowMs: 14 * DAY, minComplaints: 2, durationCapMs: 14 * DAY } },
};

export type ConfigOverrides = Partial<Omit<EngineConfig, 'levelThresholds' | 'familyWeight' | 'perFamily'>> & {
  perFamily?: EngineConfig['perFamily'];
  levelThresholds?: Partial<EngineConfig['levelThresholds']>;
  familyWeight?: Partial<EngineConfig['familyWeight']>;
};

/** Merge overrides onto the defaults and reject nonsense values early. */
export function resolveConfig(overrides: ConfigOverrides = {}): EngineConfig {
  const cfg: EngineConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    levelThresholds: { ...DEFAULT_CONFIG.levelThresholds, ...overrides.levelThresholds },
    familyWeight: { ...DEFAULT_CONFIG.familyWeight, ...overrides.familyWeight },
    perFamily: { ...DEFAULT_CONFIG.perFamily, ...overrides.perFamily },
  };

  check(cfg, '');
  for (const [family, o] of Object.entries(cfg.perFamily)) check({ ...cfg, ...o }, `perFamily.${family}.`);
  const { medium, high, critical } = cfg.levelThresholds;
  if (!(0 < medium && medium < high && high < critical && critical <= 100)) {
    throw new Error('Config "levelThresholds" must satisfy 0 < medium < high < critical <= 100');
  }
  for (const [family, weight] of Object.entries(cfg.familyWeight)) {
    if (!Number.isFinite(weight) || weight < 0 || weight > SEVERITY_MAX.family) {
      throw new Error(`Config "familyWeight.${family}" must be between 0 and ${SEVERITY_MAX.family}`);
    }
  }
  return cfg;
}

const POSITIVE = ['epsMeters', 'timeWindowMs', 'reporterDedupeWindowMs', 'velocityWindowMs', 'sourcesCap', 'spreadCapMeters', 'velocityCap', 'durationCapMs'] as const;

function check(cfg: EngineConfig, label: string): void {
  for (const key of POSITIVE) {
    const value = cfg[key];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Config "${label}${key}" must be a positive number`);
  }
  if (!Number.isInteger(cfg.minComplaints) || cfg.minComplaints < 2) {
    throw new Error(`Config "${label}minComplaints" must be an integer of at least 2`);
  }
}

/** The settings that apply to one family: the global ones with that family's overrides on top. */
export const cfgFor = (cfg: EngineConfig, family: IssueFamily): EngineConfig => ({ ...cfg, ...cfg.perFamily[family] });
