import { describe, expect, it } from 'vitest';
import { Officers } from '../src/officers.js';

describe('officer password guessing', () => {
  it('locks one account after 8 wrong passwords in 15 minutes, whatever IP the guesses claim to come from', () => {
    let now = 1_000_000;
    const o = new Officers('right-pass', 'secret', () => now);
    for (let i = 0; i < 8; i++) expect(() => o.login('head1', undefined, `guess${i}`)).toThrow(/Wrong officer ID or password/);
    expect(() => o.login('head1', undefined, 'right-pass')).toThrow(/Too many wrong passwords/); // even the right one waits
    expect(o.login('zonal1', undefined, 'right-pass').officer.id).toBe('zonal1'); // other accounts are not affected
    now += 15 * 60_000 + 1;
    expect(o.login('head1', undefined, 'right-pass').officer.id).toBe('head1');
  });
});
