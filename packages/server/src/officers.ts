import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import type { Role } from './types.js';

export interface Officer { id: string; name: string; role: Role; office: string }

/**
 * Officer sign-in. SAMPLE accounts that share one password (OFFICER_PASSWORD, default below).
 * shortcut: replace with the department's real login (SSO) before real use. Tokens live in memory and reset on restart.
 */
export const OFFICERS: Officer[] = [
  { id: 'field1', name: 'Field Officer', role: 'L1', office: 'Nagar Palika Parishad' },
  { id: 'zonal1', name: 'Zonal Officer', role: 'L2', office: 'Nagar Palika Parishad' },
  { id: 'head1', name: 'Department Head', role: 'L3', office: 'Nagar Palika Parishad' },
  { id: 'commissioner1', name: 'Commissioner', role: 'L4', office: 'Nagar Palika Parishad' },
];

const hash = (s: string): Buffer => createHash('sha256').update(s).digest();

const TOKEN_MS = 7 * 24 * 3_600_000;

export class Officers {
  /** `secret` signs the sign-in tokens; keep it stable and a restart will not sign officers out. */
  constructor(private readonly password = 'officer@123', private readonly secret = password, private readonly clock: () => number = Date.now) {}

  /** Wrong passwords per account (city + officer id): 8 in 15 minutes locks that account's sign-in for the rest of the window.
   *  Per account, not per IP, so it holds even when a client fakes X-Forwarded-For to look like many people. */
  private failures = new SlidingWindowLimiter(8, 15 * 60_000);

  private sign = (body: string): string => createHmac('sha256', this.secret).update(`officer:${body}`).digest('base64url').slice(0, 32);

  /**
   * `city` is the city the officer signs in to. A city may have its own password check (set when it was onboarded);
   * otherwise OFFICER_PASSWORD is used (the demo city). The token remembers the city.
   */
  login(id: unknown, role: unknown, password: unknown, city: { id: string; check?: (pw: string) => boolean } = { id: 'demo' }): { token: string; officer: Officer & { city: string } } {
    const o = OFFICERS.find((x) => x.id === id);
    const key = `${city.id}:${o?.id ?? '?'}`;
    const wait = this.failures.wait(key, this.clock());
    if (wait > 0) { const seconds = Math.ceil(wait / 1000); throw new AppError(429, 'rate_limited', `Too many wrong passwords for this account. Try again in ${Math.ceil(seconds / 60)} min.`, { retryAfterSeconds: seconds }, { 'retry-after': String(seconds) }); }
    const okPassword = typeof password === 'string' && (city.check ? city.check(password) : timingSafeEqual(hash(password), hash(this.password)));
    if (!o || !okPassword) { this.failures.tryConsume(key, this.clock()); throw new AppError(401, 'bad_login', 'Wrong officer ID or password'); }
    // The level comes from the account. A client may still send the level it expects; a mismatch is refused.
    if (role !== undefined && role !== null && role !== '' && o.role !== role) throw new AppError(403, 'wrong_role', `${o.id} is a ${o.role} account, not ${String(role)}`);
    const body = Buffer.from(JSON.stringify({ o: o.id, c: city.id, e: this.clock() + TOKEN_MS })).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, officer: { ...o, city: city.id } };
  }

  /** The signed-in officer behind a token, or a 401. */
  who(token: unknown): Officer & { city: string } {
    const bad = new AppError(401, 'not_signed_in', 'Sign in as an officer first');
    if (typeof token !== 'string') throw bad;
    const [body, sig] = token.split('.');
    if (!body || !sig || sig.length !== 32 || !timingSafeEqual(Buffer.from(sig), Buffer.from(this.sign(body)))) throw bad;
    try {
      const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as { o: string; c?: string; e: number };
      const o = OFFICERS.find((x) => x.id === t.o);
      if (!o || this.clock() > t.e) throw bad;
      return { ...o, city: t.c ?? 'demo' };
    } catch {
      throw bad;
    }
  }
}
