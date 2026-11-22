import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../src/rateLimit.js';

describe('SlidingWindowLimiter', () => {
  it('allows up to max hits, then says how long to wait', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect(l.tryConsume('a', 0)).toBe(0);
    expect(l.tryConsume('a', 100)).toBe(0);
    expect(l.tryConsume('a', 200)).toBe(800);
  });

  it('frees a slot once the oldest hit leaves the window', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    l.tryConsume('a', 0);
    l.tryConsume('a', 100);
    expect(l.tryConsume('a', 1001)).toBe(0);
  });

  it('keeps keys independent', () => {
    const l = new SlidingWindowLimiter(1, 1000);
    expect(l.tryConsume('a', 0)).toBe(0);
    expect(l.tryConsume('b', 0)).toBe(0);
    expect(l.tryConsume('a', 1)).toBe(999);
  });

  it('rejects nonsense settings', () => {
    expect(() => new SlidingWindowLimiter(0, 1000)).toThrow();
  });
});
