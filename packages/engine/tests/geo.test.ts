import { describe, expect, it } from 'vitest';
import { centroid, haversineMeters, isValidCoordinate, radiusAround } from '../src/geo.js';

describe('geo', () => {
  it('returns zero for identical points', () => {
    expect(haversineMeters({ lat: 27.5, lng: 77.7 }, { lat: 27.5, lng: 77.7 })).toBe(0);
  });

  it('measures one degree of latitude as about 111.2 km', () => {
    const d = haversineMeters({ lat: 27, lng: 77 }, { lat: 28, lng: 77 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  it('is symmetric', () => {
    const a = { lat: 27.49, lng: 77.67 };
    const b = { lat: 27.51, lng: 77.7 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('computes centroid and radius', () => {
    const pts = [
      { lat: 10, lng: 20 },
      { lat: 12, lng: 22 },
    ];
    expect(centroid(pts)).toEqual({ lat: 11, lng: 21 });
    expect(radiusAround({ lat: 11, lng: 21 }, pts)).toBeGreaterThan(0);
    expect(() => centroid([])).toThrow();
  });

  it('validates coordinates', () => {
    expect(isValidCoordinate(27.4, 77.6)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
  });
});
