import { describe, expect, it } from 'vitest';
import { DICT, makeT } from '../src/i18n';

describe('translations', () => {
  it('has a Hindi text for every English text, with the same placeholders', () => {
    for (const [k, en] of Object.entries(DICT.en)) {
      const hi = (DICT.hi as Record<string, string>)[k];
      expect(hi, k).toBeTruthy();
      expect(hi.match(/\{\w+\}/g)?.sort(), k).toEqual(en.match(/\{\w+\}/g)?.sort());
    }
  });
  it('fills in values', () => {
    expect(makeT('hi')('accuracy', { n: 122 })).toBe('करीब 122 मीटर तक सटीक');
    expect(makeT('en')('accuracy', { n: 122 })).toBe('accurate to about 122 m');
  });
});
