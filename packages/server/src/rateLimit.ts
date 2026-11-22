/**
 * Sliding-window limiter: at most `max` hits per key inside `windowMs`.
 * In memory, so it resets on restart and is per server instance.
 */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    if (!(max >= 1) || !(windowMs > 0)) throw new Error('limiter needs max >= 1 and windowMs > 0');
  }

  /** Milliseconds until a slot frees up for this key (0 = a hit would be allowed). Records nothing. */
  wait(key: string, now: number): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    return recent.length >= this.max ? recent[0] + this.windowMs - now : 0;
  }

  /** Returns 0 and records the hit if allowed; otherwise the milliseconds until a slot frees up. */
  tryConsume(key: string, now: number): number {
    if (this.hits.size > 10_000) this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return recent[0] + this.windowMs - now;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }

  /** Drop keys with no recent hits so the map cannot grow forever. */
  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= now - this.windowMs)) this.hits.delete(key);
    }
  }
}
