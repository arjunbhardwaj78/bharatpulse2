import type { LatLng } from './types.js';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function isValidCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Great-circle distance in metres (haversine formula). Accurate to well under
 * 1% at neighbourhood scale, which is all this engine needs.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Plain average of coordinates. Fine for the few-kilometre areas we cluster. */
export function centroid(points: readonly LatLng[]): LatLng {
  if (points.length === 0) throw new Error('Cannot take the centroid of zero points');
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/** Distance from `center` to the furthest of `points`, in metres. */
export function radiusAround(center: LatLng, points: readonly LatLng[]): number {
  let max = 0;
  for (const p of points) max = Math.max(max, haversineMeters(center, p));
  return max;
}
