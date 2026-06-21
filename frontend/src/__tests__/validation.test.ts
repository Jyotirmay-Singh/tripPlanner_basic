import {
  isValidPassword,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_SHORT_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
  isGmail,
} from '../validation';

describe('isValidPassword', () => {
  it('rejects passwords shorter than the minimum', () => {
    expect(isValidPassword('')).toBe(false);
    expect(isValidPassword('test1234')).toBe(false); // 8 chars
    expect(MIN_PASSWORD_LENGTH).toBe(9);
  });

  it('accepts passwords at or above the minimum (length-only, no complexity rules)', () => {
    expect(isValidPassword('test12345')).toBe(true); // exactly 9
    expect(isValidPassword('a longer passphrase')).toBe(true);
    expect(isValidPassword('!!!!!!!!!')).toBe(true); // 9 symbols, no letters/numbers required
  });
});

describe('password messages', () => {
  it('mentions the minimum length', () => {
    expect(PASSWORD_TOO_SHORT_MESSAGE).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it('has a distinct mismatch message', () => {
    expect(PASSWORD_MISMATCH_MESSAGE).toMatch(/match/i);
    expect(PASSWORD_MISMATCH_MESSAGE).not.toBe(PASSWORD_TOO_SHORT_MESSAGE);
  });
});

describe('isGmail (unchanged behavior)', () => {
  it('accepts gmail and treats empty as deferred to required-field checks', () => {
    expect(isGmail('a@gmail.com')).toBe(true);
    expect(isGmail('')).toBe(true);
  });

  it('rejects non-gmail domains', () => {
    expect(isGmail('a@yahoo.com')).toBe(false);
  });
});
