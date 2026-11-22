import { describe, expect, it } from 'vitest';
import { isDevanagari, toHindiName } from '../src/translit';

describe('Hindi names', () => {
  it('uses the right spelling for common names and surnames', () => {
    expect(toHindiName('Arjun')).toBe('अर्जुन');
    expect(toHindiName('arjun bhardwaj')).toBe('अर्जुन भारद्वाज');
    expect(toHindiName('Priya Sharma')).toBe('प्रिया शर्मा');
  });
  it('makes a reasonable guess for other names, and leaves Hindi text alone', () => {
    expect(toHindiName('Dhruv')).toBe('ध्रुव'); // a guess for names not in the list; the person can edit it
    expect(toHindiName('Mitra')).toMatch(/^[\u0900-\u097F]+$/);
    expect(toHindiName('अर्जुन')).toBe('अर्जुन');
    expect(isDevanagari('अर्जुन')).toBe(true);
    expect(isDevanagari('Arjun')).toBe(false);
  });
});
