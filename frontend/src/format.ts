// Money / number formatting helpers. Pure + unit-tested. Keep display logic here so every
// amount in the app renders identically (thousands separators, fixed decimals, signed).

/**
 * Format a numeric amount with grouped thousands and exactly 2 decimals.
 * Handles negatives, zero, very large values, and non-finite input (→ "0.00").
 *
 * @param value   the amount
 * @param opts.signed     prefix non-negative values with "+" (for net/delta displays)
 * @param opts.currency   optional currency code, rendered as a prefix ("INR 1,200.00")
 */
export function formatMoney(
  value: number,
  opts: { signed?: boolean; currency?: string } = {},
): string {
  const n = Number.isFinite(value) ? value : 0;
  // Round to 2dp first so values that round to zero (e.g. -0.004) never show a stray minus.
  const abs = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  const negative = n < 0 && abs !== 0;
  const sign = negative ? '-' : opts.signed ? '+' : '';
  const fixed = abs.toFixed(2);
  const [whole, decimals] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${sign}${grouped}.${decimals}`;
  return opts.currency ? `${opts.currency} ${body}` : body;
}

/** Compact label for counts, e.g. "1 trip" / "3 trips". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
