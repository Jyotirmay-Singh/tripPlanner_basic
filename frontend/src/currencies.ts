export type CurrencyDefinition = {
  code: string;
  symbol: string;
  name: string;
};

// Prominent travel currencies. Keep the ISO-code order aligned with
// backend/utils/currency_rules.py; codes are persisted while names/symbols are display-only.
export const CURRENCY_CATALOG: readonly CurrencyDefinition[] = [
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar' },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc' },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan' },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar' },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal' },
  { code: 'QAR', symbol: 'ر.ق', name: 'Qatari Riyal' },
  { code: 'KWD', symbol: 'د.ك', name: 'Kuwaiti Dinar' },
  { code: 'BHD', symbol: 'د.ب', name: 'Bahraini Dinar' },
  { code: 'OMR', symbol: 'ر.ع.', name: 'Omani Rial' },
  { code: 'THB', symbol: '฿', name: 'Thai Baht' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit' },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah' },
  { code: 'KRW', symbol: '₩', name: 'South Korean Won' },
  { code: 'TRY', symbol: '₺', name: 'Turkish Lira' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand' },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan Rupee' },
  { code: 'NPR', symbol: 'रू', name: 'Nepalese Rupee' },
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
