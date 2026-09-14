import {
  allocateWholeWeighted,
  apportionWholeAmounts,
  CURRENCY_CATALOG,
  currencyAmountPlaceholder,
  currencyDefinition,
  currencyIncrement,
  currencyMinorUnits,
  currencyPrecisionIssue,
  currencyShortLabel,
  filterCurrencies,
  fromCurrencyUnits,
  roundWholeMoney,
  toCurrencyUnits,
} from '../currencies';

describe('currency catalog', () => {
  it('contains unique prominent codes including Sri Lanka and Nepal', () => {
    const codes = CURRENCY_CATALOG.map((currency) => currency.code);
    expect(codes).toHaveLength(26);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual(expect.arrayContaining(['INR', 'USD', 'LKR', 'NPR']));
  });

  it('keeps ISO metadata and readable presentation symbols', () => {
    expect(currencyDefinition('INR')).toMatchObject({ symbol: '₹', name: 'Indian Rupee' });
    expect(currencyDefinition('LKR')).toMatchObject({ symbol: 'Rs', name: 'Sri Lankan Rupee' });
    expect(currencyShortLabel('USD')).toBe('USD ($)');
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('USD')).toBe(2);
    expect(currencyMinorUnits('KWD')).toBe(3);
  });

  it('uses a whole-unit increment and placeholder for every currency', () => {
    for (const currency of CURRENCY_CATALOG) {
      expect(currencyIncrement(currency.code)).toBe('1');
      expect(currencyAmountPlaceholder(currency.code)).toBe('0');
    }
  });

  it('rejects every decimal-form money input, including a zero fraction', () => {
    expect(currencyPrecisionIssue('12', 'USD')).toBeNull();
    expect(currencyPrecisionIssue('-12', 'KWD')).toBeNull();
    expect(currencyPrecisionIssue('12.0', 'USD')).toContain('whole amount');
    expect(currencyPrecisionIssue('.5', 'JPY')).toContain('whole amount');
  });

  it('rounds active units symmetrically at decimal midpoints', () => {
    expect(roundWholeMoney(400.49)).toBe(400);
    expect(roundWholeMoney(400.5)).toBe(401);
    expect(roundWholeMoney(-400.49)).toBe(-400);
    expect(roundWholeMoney(-400.5)).toBe(-401);
    expect(toCurrencyUnits(10.5, 'USD')).toBe(11);
    expect(toCurrencyUnits(-10.5, 'KWD')).toBe(-11);
    expect(fromCurrencyUnits(11, 'KWD')).toBe(11);
  });

  it('apportions leftovers payer-first and then in visible roster order', () => {
    expect(allocateWholeWeighted(10, { a: 1, b: 1, c: 1 }, ['a', 'b', 'c'], 'b')).toEqual({
      a: 3, b: 4, c: 3,
    });
    expect(allocateWholeWeighted(5, { a: 1, b: 1, c: 1 }, ['a', 'b', 'c'], 'x')).toEqual({
      a: 2, b: 2, c: 1,
    });
    expect(allocateWholeWeighted(-5, { a: 1, b: 1, c: 1 }, ['a', 'b', 'c'], 'b')).toEqual({
      a: -2, b: -2, c: -1,
    });
  });

  it('reconciles legacy exact decimals without negative allocations', () => {
    const allocated = apportionWholeAmounts(
      { a: 3.34, b: 3.33, c: 3.33 }, ['a', 'b', 'c'], 10, 'c',
    );
    expect(allocated).toEqual({ a: 3, b: 3, c: 4 });
    expect(Object.values(allocated).every((value) => value >= 0)).toBe(true);
    expect(Object.values(allocated).reduce((sum, value) => sum + value, 0)).toBe(10);
  });

  it('searches by code, name, and symbol', () => {
    expect(filterCurrencies('npr').map((currency) => currency.code)).toEqual(['NPR']);
    expect(filterCurrencies('Sri Lankan').map((currency) => currency.code)).toEqual(['LKR']);
    expect(filterCurrencies('€').map((currency) => currency.code)).toEqual(['EUR']);
  });
});
