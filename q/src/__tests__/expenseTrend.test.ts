import { expenseTrendWindow } from '../expenseTrend';

describe('expenseTrendWindow', () => {
  it('fills quiet days and nets refunds against the trip-currency amount', () => {
    const expenses = [
      { date: '29-09-26', amount: 120 },
      { date: '29-09-26', amount: -20 },
      { date: '01-10-26', amount: 50 },
      { date: '01-10-26', amount: 25 },
    ];
    const window = expenseTrendWindow(expenses, 'daily')!;
    expect(window.buckets).toHaveLength(7);
    expect(window.buckets.map((bucket) => bucket.key)).toEqual([
      '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28',
      '2026-09-29', '2026-09-30', '2026-10-01',
    ]);
    expect(window.buckets[4]).toMatchObject({ total: 100, count: 2, axisLabel: 'Tue' });
    expect(window.buckets[5]).toMatchObject({ total: 0, count: 0 });
    expect(window.buckets[6]).toMatchObject({ total: 75, count: 2 });
    expect(window.total).toBe(175);
  });

  it('starts weeks on Monday, including weeks that cross a year', () => {
    const expenses = [
      { date: '31-12-26', amount: 100 },
      { date: '01-01-27', amount: -40 },
      { date: '04-01-27', amount: 90 },
    ];
    const window = expenseTrendWindow(expenses, 'weekly')!;
    expect(window.buckets.at(-2)).toMatchObject({
      key: '2026-12-28', total: 60, count: 2,
      detailLabel: '28 Dec 2026 – 3 Jan 2027',
    });
    expect(window.buckets.at(-1)).toMatchObject({ key: '2027-01-04', total: 90, count: 1 });
  });

  it('groups calendar months across the year boundary', () => {
    const window = expenseTrendWindow([
      { date: '30-12-26', amount: 150 },
      { date: '02-01-27', amount: 80 },
      { date: '28-02-27', amount: -10 },
    ], 'monthly')!;
    expect(window.buckets.slice(-3).map((bucket) => [bucket.key, bucket.total])).toEqual([
      ['2026-12-01', 150], ['2027-01-01', 80], ['2027-02-01', -10],
    ]);
    expect(window.buckets.at(-1)?.detailLabel).toBe('February 2027');
  });

  it('pages through older periods and clamps to the first expense', () => {
    const expenses = [
      { date: '01-09-26', amount: 10 },
      { date: '29-09-26', amount: 20 },
    ];
    const latest = expenseTrendWindow(expenses, 'daily')!;
    expect(latest).toMatchObject({ page: 0, canPrevious: true, canNext: false });
    expect(latest.buckets.at(-1)?.key).toBe('2026-09-29');

    const first = expenseTrendWindow(expenses, 'daily', 99)!;
    expect(first).toMatchObject({ page: 4, canPrevious: false, canNext: true });
    expect(first.buckets.at(-1)?.key).toBe('2026-09-01');
    expect(first.total).toBe(10);

    const compact = expenseTrendWindow(expenses, 'daily', 0, 5)!;
    expect(compact.buckets).toHaveLength(5);
    expect(compact.buckets.at(-1)?.key).toBe('2026-09-29');
    expect(compact.buckets[0].key).toBe('2026-09-25');
  });

  it('skips invalid dates and amounts, and reports an empty series when none remain', () => {
    expect(expenseTrendWindow([
      { date: '31-02-26', amount: 10 },
      { date: '02-03-26', amount: Number.NaN },
    ], 'daily')).toBeNull();
    const window = expenseTrendWindow([
      { date: '2026-03-02', amount: 30 },
      { date: '31-02-26', amount: 10 },
    ], 'daily')!;
    expect(window.total).toBe(30);
  });
});
