// Money / number formatting helpers. Pure + unit-tested. Keep display logic here so every
// amount in the app renders identically (thousands separators, ISO precision, signed).

import { currencyMinorUnits, fromCurrencyUnits, toCurrencyUnits } from './currencies';

/**
 * Format a numeric amount with grouped thousands and the currency's ISO minor units.
 * Handles negatives, zero, very large values, and non-finite input (→ "0.00").
 *
 * @param value   the amount
 * @param opts.signed     prefix non-negative values with "+" (for net/delta displays)
 * @param opts.currency   optional currency code, rendered as a prefix ("INR 1,200.00")
 */
export function formatMoney(
  value: number,
  opts: { signed?: boolean; currency?: string; showCurrency?: boolean } = {},
): string {
  const n = Number.isFinite(value) ? value : 0;
  const digits = opts.currency ? currencyMinorUnits(opts.currency) : 2;
  // Round first so values that round to zero never show a stray minus.
  const abs = fromCurrencyUnits(toCurrencyUnits(Math.abs(n), opts.currency), opts.currency);
  const negative = n < 0 && abs !== 0;
  const sign = negative ? '-' : opts.signed ? '+' : '';
  const fixed = abs.toFixed(digits);
  const [whole, decimals] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = decimals === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${decimals}`;
  return opts.currency && opts.showCurrency !== false ? `${opts.currency} ${body}` : body;
}

/** Whole-unit settlement formatting; callers use this only after backend policy validation. */
export function formatWholeMoney(
  value: number,
  opts: { signed?: boolean; currency?: string; showCurrency?: boolean } = {},
): string {
  const n = Number.isFinite(value) ? Math.round(value) : 0;
  const absolute = Math.abs(n);
  const sign = n < 0 ? '-' : opts.signed ? '+' : '';
  const body = `${sign}${String(absolute).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  return opts.currency && opts.showCurrency !== false ? `${opts.currency} ${body}` : body;
}

type CompactMoneyOptions = {
  signed?: boolean;
  currency?: string;
  showCurrency?: boolean;
  maximumFractionDigits?: 0 | 1 | 2;
};

/**
 * Short, scan-friendly money for space-constrained summaries. Values below 1,000 retain the
 * exact ISO currency precision; larger values use universal K/M/B/T suffixes so the helper
 * remains consistent across every currency supported by the app. Callers must keep the exact
 * `formatMoney` value available to assistive technology whenever this compact form is displayed.
 */
export function formatCompactMoney(
  value: number,
  opts: CompactMoneyOptions = {},
): string {
  const n = Number.isFinite(value) ? value : 0;
  const abs = Math.abs(n);
  if (abs < 1_000) return formatMoney(n, opts);

  const units = [
    { value: 1_000_000_000_000, suffix: 'T' },
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'K' },
  ] as const;
  const unit = units.find((candidate) => abs >= candidate.value) ?? units[units.length - 1];
  const digits = opts.maximumFractionDigits ?? 2;
  const scaled = abs / unit.value;
  const rounded = scaled.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  const sign = n < 0 ? '-' : opts.signed ? '+' : '';
  const body = `${sign}${rounded}${unit.suffix}`;
  return opts.currency && opts.showCurrency !== false ? `${opts.currency} ${body}` : body;
}

/** Compact label for counts, e.g. "1 trip" / "3 trips". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
