import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sameHash } from '@bharatpulse/engine';
import { Auth } from '../src/auth.js';
import { classify, dHash, readPhoto } from '../src/intake.js';
import { failure } from './helpers.js';

describe('Auth (simulated OTP)', () => {
  it('verifies the fixed code, hides the phone number, and rejects wrong codes', async () => {
    const a = new Auth('salt', '123456');
    expect(a.request('9876543210').demoCode).toBeUndefined(); // a fixed code is never echoed
    const s = a.verify('9876543210', '123456');
    expect(a.session(s.token)).toBe(s.reporterId);
    expect(s.reporterId).not.toContain('9876543210');
    expect(a.reporterId('9876543210')).toBe(s.reporterId);
    expect((await failure(Promise.resolve().then(() => a.verify('9876543210', '000000')))).code).toBe('bad_code');
    expect((await failure(Promise.resolve().then(() => a.verify('12', '123456')))).code).toBe('validation_error');
    expect((await failure(Promise.resolve().then(() => a.session('nope')))).code).toBe('not_verified');
  });

  it('keeps people signed in across a restart, and rejects forged or expired tokens', () => {
    let now = 1_000_000;
    const a = new Auth('salt', '123456', () => now);
    const { token, reporterId } = a.verify('9876543210', '123456');
    expect(new Auth('salt', '123456', () => now).session(token)).toBe(reporterId); // a new instance, same salt
    expect(() => new Auth('other-salt', '123456', () => now).session(token)).toThrow(/Verify your phone/);
    expect(() => a.session(`${token.slice(0, -2)}xx`)).toThrow(/Verify your phone/);
    now += 31 * 24 * 3_600_000;
    expect(() => a.session(token)).toThrow(/Verify your phone/);
  });

  it('without a fixed code, makes a random code per request that works once and expires', async () => {
    let now = 1_000_000;
    const a = new Auth('salt', undefined, () => now);
    expect((await failure(Promise.resolve().then(() => a.verify('9876543210', '123456')))).code).toBe('bad_code'); // no code requested yet
    const { demoCode } = a.request('9876543210');
    expect(demoCode).toMatch(/^\d{6}$/);
    expect(a.verify('9876543210', demoCode!).reporterId).toMatch(/^r_/);
    expect((await failure(Promise.resolve().then(() => a.verify('9876543210', demoCode!)))).code).toBe('bad_code'); // used up
    const second = a.request('9876543210').demoCode!;
    now += 11 * 60_000;
    expect((await failure(Promise.resolve().then(() => a.verify('9876543210', second)))).code).toBe('bad_code'); // expired
  });

  it('limits guessing to 5 tries per 10 minutes', async () => {
    const a = new Auth('salt', '123456');
    for (let i = 0; i < 5; i++) await failure(Promise.resolve().then(() => a.verify('9876543210', 'x')));
    expect((await failure(Promise.resolve().then(() => a.verify('9876543210', '123456')))).code).toBe('rate_limited');
  });
});

describe('classify', () => {
  it.each([
    ['paani nahi aa raha', 'NO_WATER'], ['पानी नहीं आ रहा', 'NO_WATER'], ['pipe burst near the school', 'LEAK'], ['bahut gandha paani', 'DIRTY_WATER'],
    ['सड़क पर गड्ढा है', 'POTHOLE'], ['big gadda on road', 'POTHOLE'], ['road is caving in', 'CAVE_IN'], ['jal bhar gaya', 'WATERLOGGING'], ['low pressure in tap', 'LOW_PRESSURE'],
  ])('%s -> %s', (text, expected) => expect(classify(text)).toBe(expected));
  it('returns nothing for text it does not understand', () => expect(classify('hello there')).toBeUndefined());
});

const picture = (w: number, h: number, seed = 0) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.fill((x * 5 + y * 3 + (x > w / 2 ? seed : 0)) % 256, (y * w + x) * 3, (y * w + x) * 3 + 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } });
};

describe('photo hash', () => {
  it('matches a resized and recompressed copy, but not a different picture', async () => {
    const original = await picture(120, 120).jpeg({ quality: 95 }).toBuffer();
    const copy = await sharp(original).resize(80, 80).jpeg({ quality: 40 }).toBuffer();
    const other = await sharp(Buffer.from(Array.from({ length: 120 * 120 * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width: 120, height: 120, channels: 3 } }).jpeg().toBuffer();
    expect(sameHash(await dHash(original), await dHash(copy))).toBe(true);
    expect(sameHash(await dHash(original), await dHash(other))).toBe(false);
  });

  it('reads a photo and refuses junk', async () => {
    const png = await picture(40, 40).png().toBuffer();
    expect((await readPhoto(png.toString('base64'))).hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await failure(readPhoto(Buffer.from('not an image').toString('base64')))).code).toBe('validation_error');
  });
});

