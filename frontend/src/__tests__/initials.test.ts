import { initials } from '../initials';

describe('initials', () => {
  // Rule A — first char of first token + first char of last token (middle ignored).
  it('takes first + last initials for 2+ tokens', () => {
    expect(initials('Ram Mohan Sharma')).toBe('RS'); // 3 tokens, middle ignored
    expect(initials('Ram Sharma')).toBe('RS'); // 2 tokens
    expect(initials('Ram S')).toBe('RS'); // 1-char last token
  });

  // Rule B — single token of 2+ chars -> first two chars.
  it('takes the first two chars of a single multi-char token', () => {
    expect(initials('Ram')).toBe('RA');
    expect(initials('Jo')).toBe('JO');
  });

  // Rule C — single one-char token -> that char.
  it('returns the single char of a one-char token', () => {
    expect(initials('R')).toBe('R');
    expect(initials('a')).toBe('A');
  });

  it('always uppercases the output', () => {
    expect(initials('ram sharma')).toBe('RS');
    expect(initials('ram SHARMA')).toBe('RS');
  });

  it('trims and collapses whitespace (incl. tabs/newlines)', () => {
    expect(initials('  Ram   Sharma  ')).toBe('RS');
    expect(initials('Ram\tMohan\nSharma')).toBe('RS');
    expect(initials('ram   mohan   sharma')).toBe('RS');
  });

  it('falls back to an empty string for a missing/empty name', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
    expect(initials(undefined)).toBe('');
    expect(initials(null)).toBe('');
  });
});
