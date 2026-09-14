// Money / number formatting helpers. Active money always uses whole major-currency units.

import { currencyDefinition, roundWholeMoney } from './currencies';

export type MoneyFormatOptions = {
  signed?: boolean;
  currency?: string;
  showCurrency?: boolean;
};

export type BudgetWarningPayload = {
  budget_overage?: unknown;
  currency?: unknown;
  warning?: unknown;
};

function groupedWhole(value: number): { sign: string; digits: string } {
  const rounded = Number.isFinite(value) ? roundWholeMoney(value) : 0;
  const absolute = Math.abs(rounded);
  return {
    sign: rounded < 0 ? '-' : '',
    digits: String(absolute).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  };
}

/** Render complete grouped values with an attached currency symbol and no fractional digits. */
export function formatMoney(value: number, opts: MoneyFormatOptions = {}): string {
  const { sign: negativeSign, digits } = groupedWhole(value);
  const sign = negativeSign || (opts.signed ? '+' : '');
  const symbol = opts.currency && opts.showCurrency !== false
    ? currencyDefinition(opts.currency).symbol
    : '';
  return `${sign}${symbol}${digits}`;
}

/** Unambiguous spoken/export label using the ISO code rather than a potentially shared symbol. */
export function formatAccessibleMoney(value: number, opts: MoneyFormatOptions = {}): string {
  const { sign: negativeSign, digits } = groupedWhole(value);
  const sign = negativeSign || (opts.signed ? '+' : '');
  if (!opts.currency || opts.showCurrency === false) return `${sign}${digits}`;
  return `${currencyDefinition(opts.currency).code} ${sign}${digits}`;
}

/** Prefer the structured API overage while retaining compatibility with older servers. */
export function formatBudgetWarning(payload: BudgetWarningPayload | null | undefined): string {
  const overage = payload?.budget_overage;
  const normalizedCurrency = typeof payload?.currency === 'string'
    ? payload.currency.trim().toUpperCase()
    : '';
  const hasSupportedCurrency = normalizedCurrency !== ''
    && currencyDefinition(normalizedCurrency).code === normalizedCurrency;

  if (typeof overage === 'number' && Number.isInteger(overage) && overage > 0
      && hasSupportedCurrency) {
    return `This expense puts you ${formatMoney(overage, {
      currency: normalizedCurrency,
    })} over the trip budget.`;
  }
  if (typeof payload?.warning === 'string' && payload.warning.trim()) {
    return payload.warning;
  }
  return 'This exceeds the trip budget.';
}

/** Compatibility alias while callers migrate to the application-wide whole-unit formatter. */
export function formatWholeMoney(value: number, opts: MoneyFormatOptions = {}): string {
  return formatMoney(value, opts);
}

/** Compact label for counts, e.g. "1 trip" / "3 trips". */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
