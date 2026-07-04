import { compareExpensesDesc, sortExpensesDesc, SortableExpense } from '../expenseSort';

const mk = (over: Partial<SortableExpense> & { id: string }): SortableExpense => ({
  date: over.date ?? '01-01-25',
  time: over.time ?? null,
  created_at: over.created_at ?? '2025-01-01T00:00:00+00:00',
  ...over,
});

const ids = (list: SortableExpense[]) => sortExpensesDesc(list).map((e) => e.id);

describe('sortExpensesDesc', () => {
  it('orders by calendar date, newest first (DD-MM-YY parsed, not string-sorted)', () => {
    const list = [
      mk({ id: 'old', date: '15-12-24' }),
      mk({ id: 'new', date: '30-06-25' }),
      mk({ id: 'mid', date: '28-06-25' }),
    ];
    expect(ids(list)).toEqual(['new', 'mid', 'old']);
  });

  it('same date, different explicit times -> later time on top', () => {
    const list = [
      mk({ id: 'morning', date: '28-06-25', time: '09:00' }),
      mk({ id: 'evening', date: '28-06-25', time: '21:30' }),
      mk({ id: 'noon', date: '28-06-25', time: '12:15' }),
    ];
    expect(ids(list)).toEqual(['evening', 'noon', 'morning']);
  });

  it('same date, no explicit time -> created_at entry time decides (newest first)', () => {
    const list = [
      mk({ id: 'first', date: '28-06-25', time: null, created_at: '2025-06-28T08:00:00+00:00' }),
      mk({ id: 'third', date: '28-06-25', time: null, created_at: '2025-06-28T20:00:00+00:00' }),
      mk({ id: 'second', date: '28-06-25', time: null, created_at: '2025-06-28T14:00:00+00:00' }),
    ];
    expect(ids(list)).toEqual(['third', 'second', 'first']);
  });

  it('same date + same explicit time -> created_at tiebreaker, then id (deterministic)', () => {
    const list = [
      mk({ id: 'b', date: '28-06-25', time: '10:00', created_at: '2025-06-28T10:00:00+00:00' }),
      mk({ id: 'a', date: '28-06-25', time: '10:00', created_at: '2025-06-28T11:00:00+00:00' }),
      // identical date/time AND created_at as 'a' -> id breaks the tie
      mk({ id: 'c', date: '28-06-25', time: '10:00', created_at: '2025-06-28T11:00:00+00:00' }),
    ];
    // 'a' and 'c' share the newest created_at; id desc puts 'c' above 'a'; 'b' last.
    expect(ids(list)).toEqual(['c', 'a', 'b']);
  });

  it('missing/unparseable date falls back to created_at date', () => {
    const list = [
      mk({ id: 'has-date', date: '01-06-25', created_at: '2025-06-01T00:00:00+00:00' }),
      mk({ id: 'no-date', date: null, created_at: '2025-06-30T00:00:00+00:00' }),
    ];
    // no-date uses its created_at (30 Jun) which is newer than has-date (01 Jun).
    expect(ids(list)).toEqual(['no-date', 'has-date']);
  });

  it('mixed same-day: a date-only row orders by its created_at time-of-day against timed rows', () => {
    const list = [
      mk({ id: 'timed-am', date: '28-06-25', time: '08:00', created_at: '2025-06-28T08:00:00+00:00' }),
      mk({ id: 'dateonly-eve', date: '28-06-25', time: null, created_at: '2025-06-28T20:00:00+00:00' }),
      mk({ id: 'timed-pm', date: '28-06-25', time: '18:00', created_at: '2025-06-28T18:00:00+00:00' }),
      mk({ id: 'dateonly-dawn', date: '28-06-25', time: null, created_at: '2025-06-28T06:00:00+00:00' }),
    ];
    // Date-only rows use their created_at time-of-day (NOT a fabricated 23:59), so they interleave
    // with the explicit times: eve 20:00 > pm 18:00 > am 08:00 > dawn 06:00.
    expect(ids(list)).toEqual(['dateonly-eve', 'timed-pm', 'timed-am', 'dateonly-dawn']);
  });

  it('an unparseable time string falls back to the created_at time-of-day (garbage never wins)', () => {
    const list = [
      mk({ id: 'garbage-late', date: '28-06-25', time: '99:99', created_at: '2025-06-28T21:00:00+00:00' }),
      mk({ id: 'valid-noon', date: '28-06-25', time: '12:00', created_at: '2025-06-28T00:00:00+00:00' }),
      mk({ id: 'garbage-early', date: '28-06-25', time: '25:61', created_at: '2025-06-28T03:00:00+00:00' }),
    ];
    // '99:99' / '25:61' are rejected by the HH:MM parse -> use created_at minutes (21:00 / 03:00);
    // valid-noon keeps its explicit 12:00. Order: late 21:00 > noon 12:00 > early 03:00.
    expect(ids(list)).toEqual(['garbage-late', 'valid-noon', 'garbage-early']);
  });

  it('a new expense (today + latest created_at) lands at index 0', () => {
    const existing = [
      mk({ id: 'e1', date: '20-06-25', created_at: '2025-06-20T10:00:00+00:00' }),
      mk({ id: 'e2', date: '25-06-25', created_at: '2025-06-25T10:00:00+00:00' }),
    ];
    const fresh = mk({ id: 'fresh', date: '30-06-25', created_at: '2025-06-30T18:00:00+00:00' });
    expect(ids([...existing, fresh])[0]).toBe('fresh');
  });

  it('handles empty and single-item lists', () => {
    expect(sortExpensesDesc([])).toEqual([]);
    const one = [mk({ id: 'solo' })];
    expect(ids(one)).toEqual(['solo']);
  });

  it('does not mutate the input array', () => {
    const list = [
      mk({ id: 'a', date: '01-01-25' }),
      mk({ id: 'b', date: '02-01-25' }),
    ];
    const snapshot = list.map((e) => e.id);
    const sorted = sortExpensesDesc(list);
    expect(list.map((e) => e.id)).toEqual(snapshot); // original order preserved
    expect(sorted).not.toBe(list); // new array returned
  });

  it('compareExpensesDesc is a usable comparator returning 0 for identical keys', () => {
    const a = mk({ id: 'x', date: '01-01-25', time: '10:00', created_at: '2025-01-01T10:00:00+00:00' });
    expect(compareExpensesDesc(a, a)).toBe(0);
  });
});
