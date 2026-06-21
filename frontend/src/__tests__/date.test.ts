import {
  parseDDMMYYYY,
  parseISO,
  toISO,
  fromISO,
  isRangeValid,
  formatTripDates,
  todayISO,
  isoFromLocalDate,
  localDateFromISO,
  partsFromLocalDate,
  INVALID_DATE_MESSAGE,
  END_BEFORE_START_MESSAGE,
} from '../date';

describe('parseDDMMYYYY', () => {
  it('parses valid dd/mm/yyyy (with and without leading zeros)', () => {
    expect(parseDDMMYYYY('11/12/2026')).toEqual({ d: 11, m: 12, y: 2026 });
    expect(parseDDMMYYYY('1/2/2026')).toEqual({ d: 1, m: 2, y: 2026 });
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDDMMYYYY('31/02/2026')).toBeNull(); // Feb 31
    expect(parseDDMMYYYY('32/13/2026')).toBeNull(); // out-of-range day & month
    expect(parseDDMMYYYY('29/02/2027')).toBeNull(); // 2027 not a leap year
  });

  it('accepts a real leap day', () => {
    expect(parseDDMMYYYY('29/02/2028')).toEqual({ d: 29, m: 2, y: 2028 });
  });

  it('rejects wrong formats', () => {
    expect(parseDDMMYYYY('1/2/26')).toBeNull(); // 2-digit year
    expect(parseDDMMYYYY('2026-12-11')).toBeNull(); // ISO, not dd/mm/yyyy
    expect(parseDDMMYYYY('11-12-2026')).toBeNull(); // dashes
    expect(parseDDMMYYYY('abc')).toBeNull();
    expect(parseDDMMYYYY('')).toBeNull();
  });
});

describe('ISO round-trips', () => {
  it('toISO converts dd/mm/yyyy to YYYY-MM-DD', () => {
    expect(toISO('11/12/2026')).toBe('2026-12-11');
    expect(toISO('1/2/2026')).toBe('2026-02-01');
    expect(toISO('31/02/2026')).toBeNull();
  });

  it('fromISO converts YYYY-MM-DD to dd/mm/yyyy', () => {
    expect(fromISO('2026-12-11')).toBe('11/12/2026');
    expect(fromISO('2026-02-01')).toBe('01/02/2026');
    expect(fromISO('')).toBe('');
    expect(fromISO('garbage')).toBe('');
  });

  it('parseISO validates real dates', () => {
    expect(parseISO('2026-12-11')).toEqual({ y: 2026, m: 12, d: 11 });
    expect(parseISO('2026-02-31')).toBeNull();
  });
});

describe('isRangeValid', () => {
  it('accepts end after start and same-day', () => {
    expect(isRangeValid('2026-12-11', '2026-12-21')).toBe(true);
    expect(isRangeValid('2026-12-11', '2026-12-11')).toBe(true); // same-day allowed
  });

  it('rejects end before start and invalid inputs', () => {
    expect(isRangeValid('2026-12-21', '2026-12-11')).toBe(false);
    expect(isRangeValid('2026-12-11', '')).toBe(false);
    expect(isRangeValid(null, '2026-12-11')).toBe(false);
  });
});

describe('formatTripDates', () => {
  it('shows a range with an en-dash', () => {
    expect(formatTripDates({ start_date: '2026-12-11', end_date: '2026-12-21' })).toBe(
      '11/12/2026 – 21/12/2026',
    );
  });

  it('collapses a same-day trip to a single date', () => {
    expect(formatTripDates({ start_date: '2026-12-11', end_date: '2026-12-11' })).toBe('11/12/2026');
  });

  it('defaults a missing end to the start', () => {
    expect(formatTripDates({ start_date: '2026-12-11' })).toBe('11/12/2026');
  });

  it('falls back to a legacy travel_date (DD-MM-YY)', () => {
    expect(formatTripDates({ travel_date: '15-12-26' })).toBe('15/12/2026');
  });

  it('returns empty for an empty trip', () => {
    expect(formatTripDates({})).toBe('');
    expect(formatTripDates(null)).toBe('');
  });
});

describe('timezone-safe local helpers', () => {
  it('round-trips a Date through local components without shifting', () => {
    const d = new Date(2026, 11, 11); // local Dec 11 2026
    expect(isoFromLocalDate(d)).toBe('2026-12-11');
    expect(partsFromLocalDate(d)).toEqual({ y: 2026, m: 12, d: 11 });
  });

  it('localDateFromISO yields a Date whose local components match the ISO date', () => {
    const d = localDateFromISO('2026-12-11');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(11);
  });

  it('todayISO is a well-formed ISO date', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('messages', () => {
  it('are distinct and meaningful', () => {
    expect(INVALID_DATE_MESSAGE).toMatch(/dd\/mm\/yyyy/);
    expect(END_BEFORE_START_MESSAGE).toMatch(/start/i);
  });
});
