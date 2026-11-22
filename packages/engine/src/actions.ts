import type { IssueFamily, SeverityLevel } from './types.js';

/**
 * Rule-based first response, deliberately not AI-generated: an officer must be
 * able to trust and audit it. Replace with department SOPs for real use.
 */
const ACTIONS: Record<IssueFamily, Record<SeverityLevel, string>> = {
  SUPPLY: {
    LOW: 'Watch this area. Ask the ward staff to confirm supply on the affected streets.',
    MEDIUM: 'Check pump and valve status for the zone and confirm the supply schedule.',
    HIGH: 'Send a crew to inspect the supply line and keep a water tanker on standby.',
    CRITICAL: 'Dispatch a crew now, send tankers to the area and alert the zone engineer.',
  },
  QUALITY: {
    LOW: 'Collect a water sample from the affected area for testing.',
    MEDIUM: 'Test water at the nearest supply point and check for recent pipe work.',
    HIGH: 'Test immediately and advise residents to boil water until results arrive.',
    CRITICAL: 'Issue a do-not-drink advisory, arrange alternate water and inform the health department.',
  },
  INFRASTRUCTURE: {
    LOW: 'Log the leak for the next maintenance round.',
    MEDIUM: 'Schedule a repair crew within 24 hours.',
    HIGH: 'Send a repair crew today and prepare to isolate the pipe section.',
    CRITICAL: 'Isolate the pipe section now and dispatch a repair crew to prevent road and property damage.',
  },
  ROAD: {
    LOW: 'Log the road defect for the next inspection round.',
    MEDIUM: 'Schedule a repair within the week and check for a nearby leak.',
    HIGH: 'Put up a warning and send a repair crew within 24 hours.',
    CRITICAL: 'Barricade the spot now and dispatch a repair crew; check for a leak under the road.',
  },
};

export function recommendAction(family: IssueFamily, level: SeverityLevel): string {
  return ACTIONS[family][level];
}
