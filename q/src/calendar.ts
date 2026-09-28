// Pure calendar-grid + relative-label helpers for the redesigned date picker. Unit-tested, no I/O.
// Built on the timezone-free ISO helpers in src/date.ts, so a rendered/selected day never shifts
// via UTC (all dates are constructed from y/m/d integers, never parsed from an ISO into a UTC Date).

import { parseISO, partsToISO, todayISO } from './date';

// Monday-first weekday headers (global user base; ISO-8601 weeks start on Monday).
export const WEEKDAYS_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export type DayCell = { iso: string; day: number };

/** Number of days in a 1-based month (day 0 of the next month == last day of this one). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Weekday of the 1st, 0=Mon … 6=Sun (JS getDay() is Sun=0, so shift to Monday-first). */
function mondayFirstDow(year: number, month: number): number {
  return (new Date(year, month - 1, 1).getDay() + 6) % 7;
}

/**
 * Week-by-week matrix for a 1-based month. Each row is exactly 7 cells; leading blanks (before the
 * 1st) and trailing blanks (after the last day) are null — no adjacent-month spill. Rows grow only
 * as needed (4–6), so short months don't render empty trailing weeks.
 */
export function monthMatrix(year: number, month: number): (DayCell | null)[][] {
  const lead = mondayFirstDow(year, month);
  const total = daysInMonth(year, month);
  const cells: (DayCell | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push({ iso: partsToISO({ y: year, m: month, d }), day: d });
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (DayCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Add delta months to a 1-based (year, month), rolling the year across December/January. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zeroBased / 12), month: (((zeroBased % 12) + 12) % 12) + 1 };
}

/** True when ISO a is a strictly-earlier calendar date than ISO b (both 'YYYY-MM-DD'). */
export function isBeforeISO(a: string, b: string): boolean {
  if (!parseISO(a) || !parseISO(b)) return false;
  return a < b; // zero-padded ISO sorts chronologically as a string
}

/**
 * 'Today' | 'Yesterday' | 'Tomorrow' for near dates, else '' (the caller shows the raw dd/mm/yyyy).
 * Compared as calendar dates via local Date day-difference — Math.round absorbs any DST ±1h skew.
 */
export function relativeDateLabel(iso: string | null | undefined, todayIso: string = todayISO()): string {
  const parts = iso ? parseISO(iso) : null;
  const t = parseISO(todayIso);
  if (!parts || !t) return '';
  const a = new Date(parts.y, parts.m - 1, parts.d).getTime();
  const b = new Date(t.y, t.m - 1, t.d).getTime();
  const diffDays = Math.round((a - b) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays === 1) return 'Tomorrow';
  return '';
}
