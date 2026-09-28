import { formatIST } from '../istTime';

describe('formatIST', () => {
  it('renders a same-day afternoon instant (+5:30)', () => {
    // 09:05 UTC + 5:30 = 14:35 IST.
    expect(formatIST('2026-07-13T09:05:00+00:00')).toBe('13 Jul 2026, 2:35 PM IST');
  });

  it('crosses midnight into the next day (core case)', () => {
    // 19:00 UTC + 5:30 = 00:30 IST the next day.
    expect(formatIST('2026-07-13T19:00:00+00:00')).toBe('14 Jul 2026, 12:30 AM IST');
  });

  it('treats a Z suffix and an explicit +00:00 offset identically', () => {
    expect(formatIST('2026-07-13T19:00:00Z')).toBe('14 Jul 2026, 12:30 AM IST');
    expect(formatIST('2026-07-13T19:00:00Z')).toBe(formatIST('2026-07-13T19:00:00+00:00'));
  });

  it('treats a tz-less (naive/legacy) string as UTC', () => {
    expect(formatIST('2026-07-13T19:00:00')).toBe('14 Jul 2026, 12:30 AM IST');
  });

  it('handles the real stored shape with microseconds', () => {
    expect(formatIST('2026-07-13T19:00:00.123456+00:00')).toBe('14 Jul 2026, 12:30 AM IST');
  });

  it('renders the 12:00 AM and 12:00 PM boundaries', () => {
    // 18:30 UTC + 5:30 = 00:00 IST next day -> 12:00 AM; 06:30 UTC + 5:30 = 12:00 IST -> 12:00 PM.
    expect(formatIST('2026-07-13T18:30:00+00:00')).toBe('14 Jul 2026, 12:00 AM IST');
    expect(formatIST('2026-07-13T06:30:00+00:00')).toBe('13 Jul 2026, 12:00 PM IST');
  });

  it('renders 00:00 UTC as 5:30 AM IST the same day', () => {
    expect(formatIST('2026-07-13T00:00:00+00:00')).toBe('13 Jul 2026, 5:30 AM IST');
  });

  it('honors a non-UTC input offset', () => {
    expect(formatIST('2026-07-14T00:30:00+05:30')).toBe('14 Jul 2026, 12:30 AM IST');
  });

  it('returns an empty string for missing or unparseable input', () => {
    expect(formatIST(undefined)).toBe('');
    expect(formatIST(null)).toBe('');
    expect(formatIST('')).toBe('');
    expect(formatIST('not-a-timestamp')).toBe('');
  });
});
