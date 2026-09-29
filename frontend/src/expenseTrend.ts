import { ddmmyyToDDMMYYYY, parseISO, toISO } from './date';

export type TrendPeriod = 'daily' | 'weekly' | 'monthly';
export type TrendExpense = { date?: string | null; amount: number; paid_by_member_id?: string | null };
export type TrendBucket = {
  key: string;
  total: number;
  personalTotal: number;
  count: number;
  axisLabel: string;
  detailLabel: string;
};
export type TrendWindow = {
  buckets: TrendBucket[];
  rangeLabel: string;
  total: number;
  page: number;
  canPrevious: boolean;
  canNext: boolean;
};

const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const TREND_WINDOW_SIZE: Record<TrendPeriod, number> = { daily: 7, weekly: 6, monthly: 6 };

function utcDate(iso: string): Date {
  const parts = parseISO(iso)!;
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function expenseISO(date: string | null | undefined): string | null {
  if (!date) return null;
  if (parseISO(date)) return date;
  return toISO(ddmmyyToDDMMYYYY(date));
}

function startOfPeriod(iso: string, period: TrendPeriod): string {
  const date = utcDate(iso);
  if (period === 'weekly') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (period === 'monthly') date.setUTCDate(1);
  return isoDate(date);
}

function movePeriod(iso: string, period: TrendPeriod, amount: number): string {
  const date = utcDate(iso);
  if (period === 'monthly') date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCDate(date.getUTCDate() + amount * (period === 'weekly' ? 7 : 1));
  return isoDate(date);
}

function periodDistance(first: string, last: string, period: TrendPeriod): number {
  if (period === 'monthly') {
    const a = parseISO(first)!;
    const b = parseISO(last)!;
    return (b.y - a.y) * 12 + b.m - a.m;
  }
  return Math.round((utcDate(last).getTime() - utcDate(first).getTime())
    / (DAY_MS * (period === 'weekly' ? 7 : 1)));
}

function shortDate(iso: string): string {
  const parts = parseISO(iso)!;
  return `${parts.d} ${MONTHS[parts.m - 1]}`;
}

function rangeLabel(start: string, end: string): string {
  const a = parseISO(start)!;
  const b = parseISO(end)!;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `${shortDate(start)} – ${shortDate(end)} ${a.y}`;
  return `${shortDate(start)} ${a.y} – ${shortDate(end)} ${b.y}`;
}

function bucketLabels(start: string, period: TrendPeriod): Pick<TrendBucket, 'axisLabel' | 'detailLabel'> {
  const date = utcDate(start);
  const day = date.getUTCDate();
  const month = date.getUTCMonth();
  const year = date.getUTCFullYear();
  if (period === 'monthly') return {
    axisLabel: MONTHS[month],
    detailLabel: `${MONTHS_FULL[month]} ${year}`,
  };
  if (period === 'weekly') {
    const end = isoDate(new Date(date.getTime() + 6 * DAY_MS));
    return { axisLabel: `${day} ${MONTHS[month]}`, detailLabel: rangeLabel(start, end) };
  }
  return {
    axisLabel: WEEKDAYS[date.getUTCDay()].slice(0, 3),
    detailLabel: `${WEEKDAYS[date.getUTCDay()]}, ${day} ${MONTHS_FULL[month]} ${year}`,
  };
}

/** Calendar-aligned, timezone-safe net spending. Negative expenses are refunds. */
export function expenseTrendWindow(
  expenses: readonly TrendExpense[],
  period: TrendPeriod,
  requestedPage = 0,
  requestedSize = TREND_WINDOW_SIZE[period],
  personalMemberId?: string | null,
): TrendWindow | null {
  const sums = new Map<string, { total: number; personalTotal: number; count: number }>();
  for (const expense of expenses) {
    if (!Number.isFinite(expense.amount)) continue;
    const iso = expenseISO(expense.date);
    if (!iso) continue;
    const key = startOfPeriod(iso, period);
    const current = sums.get(key) ?? { total: 0, personalTotal: 0, count: 0 };
    current.total += expense.amount;
    if (personalMemberId && expense.paid_by_member_id === personalMemberId) {
      current.personalTotal += expense.amount;
    }
    current.count += 1;
    sums.set(key, current);
  }
  if (sums.size === 0) return null;

  const dates = [...sums.keys()].sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const size = Math.max(3, Math.min(TREND_WINDOW_SIZE[period], Math.floor(requestedSize) || TREND_WINDOW_SIZE[period]));
  const maxPage = Math.floor(periodDistance(first, last, period) / size);
  const page = Math.max(0, Math.min(Math.floor(requestedPage) || 0, maxPage));
  const windowEnd = movePeriod(last, period, -page * size);
  const windowStart = movePeriod(windowEnd, period, -(size - 1));
  const buckets = Array.from({ length: size }, (_, index) => {
    const key = movePeriod(windowStart, period, index);
    const sum = sums.get(key) ?? { total: 0, personalTotal: 0, count: 0 };
    return { key, ...sum, ...bucketLabels(key, period) };
  });
  const rangeEnd = isoDate(new Date(utcDate(movePeriod(windowEnd, period, 1)).getTime() - DAY_MS));
  return {
    buckets,
    rangeLabel: rangeLabel(windowStart, rangeEnd),
    total: buckets.reduce((sum, bucket) => sum + bucket.total, 0),
    page,
    canPrevious: page < maxPage,
    canNext: page > 0,
  };
}
