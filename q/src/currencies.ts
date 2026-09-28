export type CurrencyDefinition = {
  code: string;
  symbol: string;
  name: string;
  /** Historical ISO metadata; active app money always uses whole major units. */
  minorUnits: 0 | 2 | 3;
};

// Prominent travel currencies. Keep the ISO-code order aligned with
// backend/utils/currency_rules.py; codes are persisted while names/symbols are display-only.
export const CURRENCY_CATALOG: readonly CurrencyDefinition[] = [
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', minorUnits: 2 },
  { code: 'USD', symbol: '$', name: 'US Dollar', minorUnits: 2 },
  { code: 'EUR', symbol: '€', name: 'Euro', minorUnits: 2 },
  { code: 'GBP', symbol: '£', name: 'British Pound', minorUnits: 2 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', minorUnits: 2 },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', minorUnits: 0 },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', minorUnits: 2 },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', minorUnits: 2 },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', minorUnits: 2 },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc', minorUnits: 2 },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', minorUnits: 2 },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', minorUnits: 2 },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', minorUnits: 2 },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', minorUnits: 2 },
  { code: 'QAR', symbol: 'ر.ق', name: 'Qatari Riyal', minorUnits: 2 },
  { code: 'KWD', symbol: 'د.ك', name: 'Kuwaiti Dinar', minorUnits: 3 },
  { code: 'BHD', symbol: 'د.ب', name: 'Bahraini Dinar', minorUnits: 3 },
  { code: 'OMR', symbol: 'ر.ع.', name: 'Omani Rial', minorUnits: 3 },
  { code: 'THB', symbol: '฿', name: 'Thai Baht', minorUnits: 2 },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', minorUnits: 2 },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah', minorUnits: 2 },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won', minorUnits: 0 },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira', minorUnits: 2 },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', minorUnits: 2 },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee', minorUnits: 2 },
  { code: 'NPR', symbol: 'रू', name: 'Nepalese Rupee', minorUnits: 2 },
] as const;

const CURRENCY_BY_CODE = new Map(CURRENCY_CATALOG.map((currency) => [currency.code, currency]));

export function currencyDefinition(code: string | null | undefined): CurrencyDefinition {
  return CURRENCY_BY_CODE.get((code || '').toUpperCase()) ?? CURRENCY_BY_CODE.get('INR')!;
}

export function filterCurrencies(query: string): readonly CurrencyDefinition[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return CURRENCY_CATALOG;
  return CURRENCY_CATALOG.filter(({ code, name, symbol }) =>
    `${code} ${name} ${symbol}`.toLocaleLowerCase().includes(needle),
  );
}

export function currencyShortLabel(code: string | null | undefined): string {
  const currency = currencyDefinition(code);
  return `${currency.code} (${currency.symbol})`;
}

export function currencyMinorUnits(code: string | null | undefined): 0 | 2 | 3 {
  return currencyDefinition(code).minorUnits;
}

export function currencyScale(code: string | null | undefined): number {
  return 10 ** currencyMinorUnits(code);
}

export function currencyIncrement(code: string | null | undefined): string {
  void code;
  return '1';
}

export function currencyAmountPlaceholder(code: string | null | undefined): string {
  void code;
  return '0';
}

/** Updated clients accept monetary input as whole major-currency units only. */
export function currencyPrecisionIssue(
  raw: string,
  code: string | null | undefined,
  label = 'Amount',
): string | null {
  const normalized = raw.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  if (!normalized.includes('.')) return null;
  return `${label} in ${currencyDefinition(code).code} must be a whole amount without decimal places.`;
}

/** Round the decimal value represented by a JS number, avoiding binary-float midpoint drift. */
function decimalHalfUpUnits(value: number, minorUnits: number): number {
  if (!Number.isFinite(value)) return value;

  const negative = value < 0;
  const [coefficient, exponentText] = Math.abs(value).toString().toLowerCase().split('e');
  const exponent = Number(exponentText || 0);
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
  const decimalPlaces = fraction.length - exponent;
  const shift = minorUnits - decimalPlaces;

  let magnitude = BigInt(digits);
  if (shift >= 0) {
    magnitude *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    magnitude = quotient + (remainder * 2n >= divisor ? 1n : 0n);
  }

  const units = Number(magnitude);
  return negative ? -units : units;
}

export function toCurrencyUnits(value: number, code: string | null | undefined): number {
  void code;
  return decimalHalfUpUnits(value, 0);
}

export function fromCurrencyUnits(units: number, code: string | null | undefined): number {
  void code;
  return units;
}

/** Round active money to whole units with decimal ROUND_HALF_UP semantics. */
export function roundWholeMoney(value: number): number {
  return decimalHalfUpUnits(value, 0);
}

/**
 * Proportionally apportion a whole target while conserving it exactly. Base shares are floored;
 * the first leftover unit goes to an eligible payer, then the remaining units follow roster order.
 */
export function apportionWholeAmounts(
  values: Record<string, number>,
  rosterOrder: readonly string[],
  target: number,
  preferredId?: string | null,
): Record<string, number> {
  const keys = rosterOrder.filter((id, index) => (
    Object.prototype.hasOwnProperty.call(values, id) && rosterOrder.indexOf(id) === index
  ));
  const extras = Object.keys(values).filter((id) => !keys.includes(id)).sort();
  keys.push(...extras);

  const targetUnits = roundWholeMoney(target);
  if (!Number.isFinite(targetUnits)) throw new Error('Allocation total must be finite.');
  if (keys.length === 0) {
    if (targetUnits !== 0) throw new Error('Whole-unit apportionment has no recipients.');
    return {};
  }

  const weights: Record<string, number> = {};
  let totalWeight = 0;
  for (const id of keys) {
    const value = Math.abs(values[id]);
    if (!Number.isFinite(value)) throw new Error(`Allocation for '${id}' must be finite.`);
    weights[id] = value;
    totalWeight += value;
  }
  if (totalWeight === 0) {
    if (targetUnits !== 0) throw new Error('Whole-unit apportionment has no positive weight.');
    return Object.fromEntries(keys.map((id) => [id, 0]));
  }

  const magnitude = Math.abs(targetUnits);
  const sign = targetUnits < 0 ? -1 : 1;
  const allocated = Object.fromEntries(
    keys.map((id) => [id, Math.floor((magnitude * weights[id]) / totalWeight)]),
  ) as Record<string, number>;
  let needed = magnitude - keys.reduce((sum, id) => sum + allocated[id], 0);
  if (needed < 0 || needed > keys.length) {
    throw new Error('Whole-unit apportionment could not conserve the target.');
  }

  const priority = preferredId && keys.includes(preferredId)
    ? [preferredId, ...keys.filter((id) => id !== preferredId)]
    : keys;
  for (const id of priority) {
    if (needed <= 0) break;
    allocated[id] += 1;
    needed -= 1;
  }

  return Object.fromEntries(keys.map((id) => [id, sign * allocated[id]]));
}

export function allocateWholeWeighted(
  total: number,
  weights: Record<string, number>,
  rosterOrder: readonly string[],
  preferredId?: string | null,
): Record<string, number> {
  const positive: Record<string, number> = {};
  for (const [id, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight)) throw new Error(`Weight for '${id}' must be finite.`);
    if (weight < 0) throw new Error(`Weight for '${id}' cannot be negative.`);
    if (weight > 0) positive[id] = weight;
  }
  return apportionWholeAmounts(positive, rosterOrder, total, preferredId);
}
