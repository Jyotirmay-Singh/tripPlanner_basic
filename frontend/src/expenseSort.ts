// Expenses-tab ordering. Pure + unit-tested, mirroring src/settlements.ts and src/spend.ts:
// the comparison lives here (not inline in the screen) so it's testable without a render and
// never mutates the input array (so React state stays untouched).
//
// "Latest expense on top": sort DESCENDING by the expense's own date/time. Because the API
// stores `date` as 'DD-MM-YY' (not lexicographically sortable) and `time` is optional, the key
// is built from parsed components. Same-day expenses without an explicit time fall back to the
// `created_at` entry time, so they still order by when they were added.
//
// Self-contained leaf (no module imports): the screen renders this during the Expenses tab,
// so keeping it dependency-free avoids coupling that render to other modules' test mocks.

export type SortableExpense = {
  id: string;
  date?: string | null; // 'DD-MM-YY' (2-digit year)
  time?: string | null; // optional wall-clock 'HH:MM' (24h)
  created_at?: string | null; // ISO-8601 UTC insertion timestamp
};

// 'DD-MM-YY' -> YYYYMMDD ordinal (e.g. '28-06-25' -> 20250628), or null if unparseable.
// Mirrors the `2000 + YY` 2-digit-year convention used across src/date.ts.
function dateOrdinal(value: string | null | undefined): number | null {
  const m = (value || '').trim().match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = 2000 + Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return y * 10000 + mo * 100 + d;
}

// 'HH:MM' (24h) -> minutes-of-day (0..1439), or null if unparseable. Lenient on padding,
// mirroring src/time.ts::parseHHMM (kept inline so this module stays a dependency-free leaf).
function minutesOfDay(value: string | null | undefined): number | null {
  const m = (value || '').trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// ISO-8601 'YYYY-MM-DDTHH:MM:SS...' -> { ymd, mins } via plain string slicing (no Date/UTC
// shift). Either field is null when the string isn't in the expected shape.
function fromCreatedAt(iso: string | null | undefined): { ymd: number | null; mins: number | null } {
  const s = (iso || '').trim();
  const dm = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const tm = s.match(/^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  const ymd = dm ? Number(dm[1]) * 10000 + Number(dm[2]) * 100 + Number(dm[3]) : null;
  const mins = tm ? Number(tm[1]) * 60 + Number(tm[2]) : null;
  return { ymd, mins };
}

/**
 * Compare two expenses so the LATEST sorts first (descending). Total order, so the sort is
 * stable and deterministic:
 *   1. calendar date desc — from `date`, falling back to `created_at`'s date when absent/invalid
 *   2. time-of-day desc   — explicit `time`, else `created_at`'s minutes-of-day (spec: use
 *                           created_at as the time component for same-day, no-time rows)
 *   3. `created_at` full ISO string desc — tiebreaker for identical date + explicit time
 *   4. `id` desc — final tiebreaker
 */
export function compareExpensesDesc(a: SortableExpense, b: SortableExpense): number {
  const ca = fromCreatedAt(a.created_at);
  const cb = fromCreatedAt(b.created_at);

  // 1. calendar date
  const da = dateOrdinal(a.date) ?? ca.ymd ?? 0;
  const db = dateOrdinal(b.date) ?? cb.ymd ?? 0;
  if (da !== db) return db - da;

  // 2. time-of-day (explicit time, else created_at time-of-day)
  const ta = minutesOfDay(a.time) ?? ca.mins ?? 0;
  const tb = minutesOfDay(b.time) ?? cb.mins ?? 0;
  if (ta !== tb) return tb - ta;

  // 3. created_at full ISO string
  const sa = (a.created_at || '').trim();
  const sb = (b.created_at || '').trim();
  if (sa !== sb) return sa < sb ? 1 : -1;

  // 4. id
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Return a new array sorted latest-first. Never mutates the input. */
export function sortExpensesDesc<T extends SortableExpense>(list: T[]): T[] {
  return [...list].sort(compareExpensesDesc);
}
