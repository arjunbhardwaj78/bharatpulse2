import { ISSUE_TYPES, isValidCoordinate, type IssueType } from '@bharatpulse/engine';
import { AppError } from './errors.js';

const CLOCK_SKEW_MS = 5 * 60_000;

export interface ComplaintInput {
  reporterId: string;
  issueType: IssueType;
  lat: number;
  lng: number;
  createdAt: number;
  deviceId?: string;
  text?: string;
  submitMs?: number;
  size?: 1 | 2 | 3;
  roadClass?: 'LOCAL' | 'MAIN' | 'HIGHWAY';
}

export interface ParseOptions {
  now: number;
  /** Oldest timestamp a client may claim (only used when client timestamps are allowed). */
  windowMs: number;
  allowClientTimestamps: boolean;
}

/**
 * Checks an untrusted request body and returns a clean complaint, or throws a
 * 400 listing EVERY problem (so the caller fixes them in one go).
 * `createdAt` is stamped by the server unless client timestamps are enabled
 * (the demo simulator needs that); otherwise anyone could backdate a report
 * to make an incident look older and more severe.
 */
export function parseComplaintInput(body: unknown, opts: ParseOptions): ComplaintInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(400, 'validation_error', 'Request body must be a JSON object');
  }
  const b = body as Record<string, unknown>;
  const problems: { field: string; message: string }[] = [];
  const bad = (field: string, message: string): void => void problems.push({ field, message });

  let reporterId = '';
  if (typeof b.reporterId !== 'string' || b.reporterId.trim() === '') bad('reporterId', 'required non-empty string');
  else if (b.reporterId.trim().length > 64) bad('reporterId', 'at most 64 characters');
  else reporterId = b.reporterId.trim();

  let issueType: IssueType = 'NO_WATER';
  if (typeof b.issueType !== 'string' || !(ISSUE_TYPES as readonly string[]).includes(b.issueType)) {
    bad('issueType', `must be one of ${ISSUE_TYPES.join(', ')}`);
  } else issueType = b.issueType as IssueType;

  const lat = b.lat;
  const lng = b.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !isValidCoordinate(lat, lng)) {
    bad('lat/lng', 'lat must be -90..90 and lng -180..180, both numbers');
  }

  let createdAt = opts.now;
  if (b.createdAt !== undefined) {
    if (!opts.allowClientTimestamps) {
      bad('createdAt', 'not accepted: the server stamps the report time');
    } else if (
      typeof b.createdAt !== 'number' ||
      !Number.isInteger(b.createdAt) ||
      b.createdAt < opts.now - opts.windowMs ||
      b.createdAt > opts.now + CLOCK_SKEW_MS
    ) {
      bad('createdAt', 'must be an integer epoch-ms inside the active window and not in the future');
    } else createdAt = b.createdAt;
  }

  const optional: Pick<ComplaintInput, 'deviceId' | 'text' | 'submitMs' | 'size' | 'roadClass'> = {};
  if (b.deviceId !== undefined) typeof b.deviceId === 'string' && b.deviceId.length <= 64 ? (optional.deviceId = b.deviceId) : bad('deviceId', 'string of at most 64 characters');
  if (b.text !== undefined) typeof b.text === 'string' && b.text.length <= 500 ? (optional.text = b.text) : bad('text', 'string of at most 500 characters');
  if (b.submitMs !== undefined) Number.isInteger(b.submitMs) && (b.submitMs as number) >= 0 ? (optional.submitMs = b.submitMs as number) : bad('submitMs', 'non-negative integer');
  if (b.size !== undefined) b.size === 1 || b.size === 2 || b.size === 3 ? (optional.size = b.size) : bad('size', '1, 2 or 3');
  if (b.roadClass !== undefined) b.roadClass === 'LOCAL' || b.roadClass === 'MAIN' || b.roadClass === 'HIGHWAY' ? (optional.roadClass = b.roadClass) : bad('roadClass', 'LOCAL, MAIN or HIGHWAY');

  if (problems.length > 0) throw new AppError(400, 'validation_error', 'Invalid complaint', problems);
  return { reporterId, issueType, lat: lat as number, lng: lng as number, createdAt, ...optional };
}
