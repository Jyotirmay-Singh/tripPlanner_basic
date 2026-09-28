// Format a stored UTC ISO instant (a settlement/payment `created_at`/`paid_at`) in Indian Standard
// Time (UTC+05:30). The app is India-only and IST is a fixed offset (no DST), so this is a plain
// +5:30 shift with no timezone database needed. DISPLAY ONLY: storage stays UTC and every
// sort/replay input (src/payments.ts::paymentsForPair, src/settlements.ts, src/expenseSort.ts) keeps
// reading the raw ISO string — nothing here feeds the ordering/balance logic.
//
// Device-timezone-INDEPENDENT: we shift the epoch by +5:30 and then read the shifted instant's UTC
// components, so the rendered IST wall-clock is identical regardless of the phone's own timezone.

const IST_OFFSET_MIN = 330; // UTC+05:30
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Epoch ms for a stored ISO instant. A tz-aware string (ending in Z or a ±hh:mm offset) is parsed
 * as-is; a tz-less (legacy/naive) string is treated as UTC. null if unparseable.
 */
function epochUtc(iso: string): number | null {
  const s = iso.trim();
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s); // Z or ±hh:mm -> tz-aware; else naive
  const ms = Date.parse(hasTz ? s : `${s}Z`); // naive treated as UTC
  return Number.isNaN(ms) ? null : ms;
}

/** Stored UTC ISO -> '14 Jul 2026, 12:30 AM IST'. '' for missing/unparseable. */
export function formatIST(iso?: string | null): string {
  if (!iso) return '';
  const ms = epochUtc(iso);
  if (ms === null) return '';
  const d = new Date(ms + IST_OFFSET_MIN * 60_000);
  // Read UTC components of the +5:30-shifted instant = IST wall-clock, independent of device tz.
  let h = d.getUTCHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${mm} ${ampm} IST`;
}
