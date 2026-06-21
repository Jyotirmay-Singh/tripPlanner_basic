// Trip calendar-date helpers. Pure + unit-tested. The UI works in dd/mm/yyyy; the API/DB
// works in ISO 'YYYY-MM-DD' (a timezone-free calendar date). Conversions live here so a
// picked date never shifts a day via UTC:
//   - read a native Date via LOCAL components (never .toISOString())
//   - seed a native Date via the LOCAL constructor new Date(y, m-1, d) (never new Date(iso))

export type DateParts = { y: number; m: number; d: number };

export const INVALID_DATE_MESSAGE = 'Enter a valid date as dd/mm/yyyy';
export const END_BEFORE_START_MESSAGE = 'End date must be the same as or after the start date';

const pad = (n: number) => String(n).padStart(2, '0');

/** Validate y/m/d as a real calendar date via a round-trip (rejects 31/02, 32/13, etc.). */
function isRealDate({ y, m, d }: DateParts): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d); // local constructor — no timezone involved
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Parse a 'dd/mm/yyyy' string (1-2 digit day/month, 4-digit year) into parts, or null. */
export function parseDDMMYYYY(value: string): DateParts | null {
  const m = (value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const parts = { d: Number(m[1]), m: Number(m[2]), y: Number(m[3]) };
  return isRealDate(parts) ? parts : null;
}

/** Parse an ISO 'YYYY-MM-DD' string into parts, or null. */
export function parseISO(value: string): DateParts | null {
  const m = (value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const parts = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return isRealDate(parts) ? parts : null;
}

export function formatDDMMYYYY(parts: DateParts): string {
  return `${pad(parts.d)}/${pad(parts.m)}/${parts.y}`;
}

export function partsToISO(parts: DateParts): string {
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

/** 'dd/mm/yyyy' -> 'YYYY-MM-DD' (null if invalid). */
export function toISO(ddmmyyyy: string): string | null {
  const parts = parseDDMMYYYY(ddmmyyyy);
  return parts ? partsToISO(parts) : null;
}

/** 'YYYY-MM-DD' -> 'dd/mm/yyyy' (empty string if invalid/blank). */
export function fromISO(iso: string | null | undefined): string {
  const parts = iso ? parseISO(iso) : null;
  return parts ? formatDDMMYYYY(parts) : '';
}

/** Local Date from an ISO string, for seeding a native picker without a UTC shift. */
export function localDateFromISO(iso: string | null | undefined): Date {
  const parts = iso ? parseISO(iso) : null;
  if (parts) return new Date(parts.y, parts.m - 1, parts.d);
  return new Date();
}

/** Read a (picker) Date via its LOCAL components — the calendar date the user sees. */
export function partsFromLocalDate(d: Date): DateParts {
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/** ISO 'YYYY-MM-DD' from a local Date (picker output). */
export function isoFromLocalDate(d: Date): string {
  return partsToISO(partsFromLocalDate(d));
}

/** Today's calendar date as ISO, used to pre-fill the create screen. */
export function todayISO(): string {
  return isoFromLocalDate(new Date());
}

/** Both ISO dates valid and end on/after start (same-day allowed). ISO sorts chronologically. */
export function isRangeValid(startISO: string | null, endISO: string | null): boolean {
  if (!parseISO(startISO || '') || !parseISO(endISO || '')) return false;
  return (endISO as string) >= (startISO as string);
}

/** Legacy single-date fallback: 'DD-MM-YY' -> 'YYYY-MM-DD' (null if unparseable). */
function legacyToISO(value: string | null | undefined): string | null {
  const m = (value || '').trim().match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const parts = { d: Number(m[1]), m: Number(m[2]), y: 2000 + Number(m[3]) };
  return isRealDate(parts) ? partsToISO(parts) : null;
}

export type TripDates = {
  start_date?: string | null;
  end_date?: string | null;
  travel_date?: string | null; // legacy fallback for un-migrated/cached trips
};

/** Human-facing range 'dd/mm/yyyy – dd/mm/yyyy', collapsing a same-day trip to one date. */
export function formatTripDates(trip: TripDates | null | undefined): string {
  if (!trip) return '';
  const startISO = trip.start_date || legacyToISO(trip.travel_date);
  const endISO = trip.end_date || startISO;
  const start = startISO ? fromISO(startISO) : '';
  const end = endISO ? fromISO(endISO) : '';
  if (!end || start === end) return start || end;
  if (!start) return end;
  return `${start} – ${end}`;
}
