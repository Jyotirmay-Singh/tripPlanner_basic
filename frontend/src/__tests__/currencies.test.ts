import {
  CURRENCY_CATALOG,
  currencyDefinition,
  currencyShortLabel,
  filterCurrencies,
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

  it('searches by code, name, and symbol', () => {
    expect(filterCurrencies('npr').map((currency) => currency.code)).toEqual(['NPR']);
    expect(filterCurrencies('Sri Lankan').map((currency) => currency.code)).toEqual(['LKR']);
    expect(filterCurrencies('€').map((currency) => currency.code)).toEqual(['EUR']);
  });
});
