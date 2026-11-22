import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { SlidingWindowLimiter } from './rateLimit.js';

const SESSION_MS = 30 * 24 * 3_600_000;
const CODE_MS = 10 * 60_000;

/**
 * Phone verification. No SMS provider is connected in this build, so:
 *  - with a fixed `code` (OTP_CODE, used by tests), every phone uses that code;
 *  - otherwise (the default) each request gets a fresh random 6-digit code that expires in 10 minutes, and because no
 *    SMS can be sent the code is returned to the app, which shows it as a "demo SMS". Connecting an SMS provider
 *    (e.g. MSG91) means sending it instead of returning it.
 * The phone number itself is never stored, only a salted hash. Reporter history lives in the store (Reporter node).
 */
export class Auth {
  private attempts = new SlidingWindowLimiter(5, 10 * 60_000);
  private requests = new SlidingWindowLimiter(5, 10 * 60_000);
  private codes = new Map<string, { code: string; until: number }>();

  constructor(private readonly salt: string, private readonly code?: string, private readonly clock: () => number = Date.now) {}

  readonly reporterId = (phone: string): string => `r_${createHmac('sha256', this.salt).update(phone).digest('hex').slice(0, 16)}`;
  readonly ipHash = (ip: string): string => createHmac('sha256', this.salt).update(`ip:${ip}`).digest('hex').slice(0, 16);

  /** Step 1: make a code. `demoCode` is only set when no SMS is sent (see the class note). */
  request(phone: unknown): { sent: true; simulated: true; demoCode?: string } {
    if (typeof phone !== 'string' || !/^\+?\d{10,13}$/.test(phone)) throw new AppError(400, 'validation_error', 'Enter a valid phone number');
    const id = this.reporterId(phone);
    if (this.requests.tryConsume(id, this.clock()) > 0) throw new AppError(429, 'rate_limited', 'Too many codes requested, try again later');
    if (this.code) return { sent: true, simulated: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.codes.set(id, { code, until: this.clock() + CODE_MS });
    return { sent: true, simulated: true, demoCode: code };
  }

  verify(phone: unknown, code: unknown): { token: string; reporterId: string; simulated: true } {
    if (typeof phone !== 'string' || !/^\+?\d{10,13}$/.test(phone)) throw new AppError(400, 'validation_error', 'phone must be 10 to 13 digits');
    const id = this.reporterId(phone);
    if (this.attempts.tryConsume(id, this.clock()) > 0) throw new AppError(429, 'rate_limited', 'Too many attempts, try again later');
    const want = this.code ?? this.codes.get(id)?.code;
    const live = this.code !== undefined || (this.codes.get(id)?.until ?? 0) > this.clock();
    if (!want || !live || typeof code !== 'string' || code.length !== want.length || !timingSafeEqual(Buffer.from(code), Buffer.from(want))) throw new AppError(401, 'bad_code', 'Wrong or expired code');
    this.codes.delete(id);
    return { token: this.issue(id), reporterId: id, simulated: true };
  }

  /** Signed token: it carries the reporter and an expiry, so a restart does not sign anyone out as long as the salt stays the same. */
  private issue(id: string): string {
    const iat = this.clock();
    const body = Buffer.from(JSON.stringify({ r: id, i: iat, e: iat + SESSION_MS })).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }
  private sign = (body: string): string => createHmac('sha256', this.salt).update(`session:${body}`).digest('base64url').slice(0, 32);

  /** The reporter behind a session token, or a 401. */
  session(token: unknown): string {
    const bad = new AppError(401, 'not_verified', 'Verify your phone first');
    if (typeof token !== 'string') throw bad;
    const [body, sig] = token.split('.');
    if (!body || !sig || sig.length !== 32 || !timingSafeEqual(Buffer.from(sig), Buffer.from(this.sign(body)))) throw bad;
    try {
      const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as { r: string; i: number; e: number };
      if (this.clock() > t.e) throw bad;
      return t.r;
    } catch {
      throw bad;
    }
  }
}
