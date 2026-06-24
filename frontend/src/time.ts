// Optional wall-clock time helpers for expenses. Pure + unit-tested. Mirrors src/date.ts.
// Time is stored/transported as a timezone-free 'HH:MM' (24h) string (or '' for none); only the
// DISPLAY is 12-hour. Native pickers are seeded/read via LOCAL components so no UTC offset drift.

export type TimeParts = { h: number; m: number };

const pad = (n: number) => String(n).padStart(2, '0');

/** Parse an 'HH:MM' (24h) string into parts, or null. Lenient on padding (e.g. '9:5'). */
export function parseHHMM(value: string | null | undefined): TimeParts | null {
  const m = (value || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

/** 'HH:MM' (24h) -> canonical 'HH:MM' (zero-padded), or '' if invalid/blank. */
export function normalizeHHMM(value: string | null | undefined): string {
  const parts = parseHHMM(value);
  return parts ? `${pad(parts.h)}:${pad(parts.m)}` : '';
}

/** 'HH:MM' -> '2:30 PM' for human-facing display; '' if invalid/blank. */
export function formatTime12h(value: string | null | undefined): string {
  const parts = parseHHMM(value);
  if (!parts) return '';
  const suffix = parts.h < 12 ? 'AM' : 'PM';
  const h12 = parts.h % 12 || 12;
  return `${h12}:${pad(parts.m)} ${suffix}`;
}

/** Read a (picker) Date via its LOCAL components -> 'HH:MM' (the wall-clock the user picked). */
export function hhmmFromLocalDate(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local Date seeded with the given 'HH:MM' (today's date), for a native time picker.
 * Blank/invalid -> now, so opening an empty picker starts at the current time. */
export function localDateFromHHMM(value: string | null | undefined): Date {
  const parts = parseHHMM(value);
  const d = new Date();
  if (parts) {
    d.setHours(parts.h, parts.m, 0, 0);
  }
  return d;
}
