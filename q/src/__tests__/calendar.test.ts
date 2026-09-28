import {
  WEEKDAYS_SHORT,
  MONTHS,
  monthMatrix,
  addMonths,
  isBeforeISO,
  relativeDateLabel,
} from '../calendar';

describe('constants', () => {
  it('has Monday-first weekdays and 12 month names', () => {
    expect(WEEKDAYS_SHORT).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(MONTHS).toHaveLength(12);
    expect(MONTHS[0]).toBe('January');
    expect(MONTHS[11]).toBe('December');
  });
});

describe('monthMatrix', () => {
  it('aligns the 1st under the correct Monday-first column', () => {
    // 1 July 2026 is a Wednesday -> index 2 (Mo=0, Tu=1, We=2), so 2 leading blanks.
    const weeks = monthMatrix(2026, 7);
    expect(weeks[0].slice(0, 3).map((c) => c && c.day)).toEqual([null, null, 1]);
    // Every row is exactly 7 cells.
    weeks.forEach((w) => expect(w).toHaveLength(7));
  });

  it('contains every day of the month exactly once, in order', () => {
    const days = monthMatrix(2026, 7).flat().filter(Boolean).map((c) => (c as any).day);
    expect(days).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it('emits timezone-free ISO strings for each cell', () => {
    const first = monthMatrix(2026, 7).flat().find(Boolean);
    expect(first).toEqual({ iso: '2026-07-01', day: 1 });
  });

  it('handles a leap February (29 days)', () => {
    const days = monthMatrix(2024, 2).flat().filter(Boolean).map((c) => (c as any).day);
    expect(days[days.length - 1]).toBe(29);
  });

  it('handles a non-leap February (28 days) with no trailing empty week', () => {
    const weeks = monthMatrix(2026, 2);
    const days = weeks.flat().filter(Boolean).map((c) => (c as any).day);
    expect(days[days.length - 1]).toBe(28);
    // last cell of the last rendered week is day 28's week — no fully-blank extra row
    expect(weeks.every((w) => w.some(Boolean))).toBe(true);
  });
});

describe('addMonths', () => {
  it('rolls forward across December', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });
  it('rolls backward across January', () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });
  it('handles multi-month and multi-year deltas', () => {
    expect(addMonths(2026, 7, 6)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 7, -18)).toEqual({ year: 2025, month: 1 });
  });
});

describe('isBeforeISO', () => {
  it('compares valid ISO dates chronologically', () => {
    expect(isBeforeISO('2026-07-14', '2026-07-15')).toBe(true);
    expect(isBeforeISO('2026-07-15', '2026-07-15')).toBe(false);
    expect(isBeforeISO('2026-08-01', '2026-07-31')).toBe(false);
  });
  it('returns false for malformed input', () => {
    expect(isBeforeISO('nope', '2026-07-15')).toBe(false);
    expect(isBeforeISO('2026-07-15', '')).toBe(false);
  });
});

describe('relativeDateLabel', () => {
  const today = '2026-07-15';
  it('labels today/yesterday/tomorrow relative to the given today', () => {
    expect(relativeDateLabel('2026-07-15', today)).toBe('Today');
    expect(relativeDateLabel('2026-07-14', today)).toBe('Yesterday');
    expect(relativeDateLabel('2026-07-16', today)).toBe('Tomorrow');
  });
  it('returns "" for dates further out (caller shows the raw date)', () => {
    expect(relativeDateLabel('2026-07-13', today)).toBe('');
    expect(relativeDateLabel('2026-07-20', today)).toBe('');
    expect(relativeDateLabel('2025-07-15', today)).toBe('');
  });
  it('rolls across month/year boundaries', () => {
    expect(relativeDateLabel('2026-06-30', '2026-07-01')).toBe('Yesterday');
    expect(relativeDateLabel('2027-01-01', '2026-12-31')).toBe('Tomorrow');
  });
  it('returns "" for blank/invalid input', () => {
    expect(relativeDateLabel('', today)).toBe('');
    expect(relativeDateLabel(null, today)).toBe('');
    expect(relativeDateLabel(undefined, today)).toBe('');
  });
});
