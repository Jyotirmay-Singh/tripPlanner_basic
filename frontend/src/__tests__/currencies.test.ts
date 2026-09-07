import {
  CURRENCY_CATALOG,
  currencyAmountPlaceholder,
  currencyDefinition,
  currencyIncrement,
  currencyMinorUnits,
  currencyPrecisionIssue,
  currencyShortLabel,
  filterCurrencies,
  toCurrencyUnits,
} from '../currencies';

describe('currency catalog', () => {
  it('contains unique prominent codes including Sri Lanka and Nepal', () => {
    const codes = CURRENCY_CATALOG.map((currency) => currency.code);
    expect(codes).toHaveLength(26);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(['INR', 'USD', 'LKR', 'NPR']));
  });

  it('keeps standard symbols and readable short labels', () => {
    expect(currencyDefinition('INR')).toMatchObject({ symbol: '₹', name: 'Indian Rupee' });
    expect(currencyDefinition('LKR')).toMatchObject({ symbol: 'Rs', name: 'Sri Lankan Rupee' });
    expect(currencyShortLabel('USD')).toBe('USD ($)');
  });

  it('carries ISO minor units and validates source strings without rounding', () => {
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('USD')).toBe(2);
    expect(currencyMinorUnits('KWD')).toBe(3);
    expect(currencyIncrement('JPY')).toBe('1');
    expect(currencyIncrement('KWD')).toBe('0.001');
    expect(currencyAmountPlaceholder('OMR')).toBe('0.000');
    expect(currencyPrecisionIssue('12.1', 'JPY')).toContain('at most 0 decimal places');
    expect(currencyPrecisionIssue('12.345', 'USD')).toContain('at most 2 decimal places');
    expect(currencyPrecisionIssue('12.345', 'KWD')).toBeNull();
    expect(currencyPrecisionIssue('12.3400', 'USD')).toBeNull();
  });

  it('rounds computed positive and negative midpoint values half-up', () => {
    expect(toCurrencyUnits(10.075, 'USD')).toBe(1008);
    expect(toCurrencyUnits(-10.075, 'USD')).toBe(-1008);
    expect(toCurrencyUnits(1.2345, 'KWD')).toBe(1235);
    expect(toCurrencyUnits(-1.2345, 'KWD')).toBe(-1235);
  });

  it('searches by code, name, and symbol', () => {
    expect(filterCurrencies('npr').map((currency) => currency.code)).toEqual(['NPR']);
    expect(filterCurrencies('Sri Lankan').map((currency) => currency.code)).toEqual(['LKR']);
    expect(filterCurrencies('€').map((currency) => currency.code)).toEqual(['EUR']);
  });
});
