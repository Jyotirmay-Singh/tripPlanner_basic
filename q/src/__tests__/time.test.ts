import {
  parseHHMM,
  normalizeHHMM,
  formatTime12h,
  formatTime24h,
  hhmmFromLocalDate,
  localDateFromHHMM,
} from '../time';

describe('parseHHMM', () => {
  it('parses valid 24h times (with and without leading zeros)', () => {
    expect(parseHHMM('14:30')).toEqual({ h: 14, m: 30 });
    expect(parseHHMM('9:5')).toEqual({ h: 9, m: 5 });
    expect(parseHHMM('00:00')).toEqual({ h: 0, m: 0 });
    expect(parseHHMM('23:59')).toEqual({ h: 23, m: 59 });
  });

  it('rejects out-of-range and malformed input', () => {
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('12:60')).toBeNull();
    expect(parseHHMM('25:99')).toBeNull();
    expect(parseHHMM('1430')).toBeNull();
    expect(parseHHMM('ab:cd')).toBeNull();
    expect(parseHHMM('')).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });
});

describe('normalizeHHMM', () => {
  it('zero-pads valid times, returns "" otherwise', () => {
    expect(normalizeHHMM('9:5')).toBe('09:05');
    expect(normalizeHHMM('14:30')).toBe('14:30');
    expect(normalizeHHMM('')).toBe('');
    expect(normalizeHHMM('25:00')).toBe('');
  });
});

describe('formatTime12h', () => {
  it('renders 12-hour with AM/PM', () => {
    expect(formatTime12h('00:00')).toBe('12:00 AM');
    expect(formatTime12h('12:00')).toBe('12:00 PM');
    expect(formatTime12h('14:30')).toBe('2:30 PM');
    expect(formatTime12h('09:05')).toBe('9:05 AM');
    expect(formatTime12h('23:59')).toBe('11:59 PM');
  });

  it('returns "" for blank/invalid', () => {
    expect(formatTime12h('')).toBe('');
    expect(formatTime12h(null)).toBe('');
    expect(formatTime12h('25:00')).toBe('');
  });
});

describe('formatTime24h', () => {
  it('renders canonical zero-padded 24-hour time', () => {
    expect(formatTime24h('00:00')).toBe('00:00');
    expect(formatTime24h('9:5')).toBe('09:05');
    expect(formatTime24h('14:30')).toBe('14:30');
    expect(formatTime24h('23:59')).toBe('23:59');
  });

  it('returns "" for blank/invalid', () => {
    expect(formatTime24h('')).toBe('');
    expect(formatTime24h(null)).toBe('');
    expect(formatTime24h('25:00')).toBe('');
  });
});

describe('local Date <-> HH:MM round-trip (timezone-safe)', () => {
  it('reads a Date via local components', () => {
    const d = new Date(2026, 5, 24, 14, 30, 0, 0);
    expect(hhmmFromLocalDate(d)).toBe('14:30');
    expect(hhmmFromLocalDate(new Date(2026, 0, 1, 9, 5))).toBe('09:05');
  });

  it('seeds a Date from HH:MM without drift', () => {
    const d = localDateFromHHMM('14:30');
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
    expect(hhmmFromLocalDate(localDateFromHHMM('09:05'))).toBe('09:05');
  });

  it('falls back to now-ish for blank input (no throw)', () => {
    expect(() => localDateFromHHMM('')).not.toThrow();
    expect(localDateFromHHMM('') instanceof Date).toBe(true);
  });
});
