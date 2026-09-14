import { CURRENCY_CATALOG } from '../currencies';
import {
  formatAccessibleMoney,
  formatBudgetWarning,
  formatMoney,
  formatWholeMoney,
  pluralize,
} from '../format';

describe('whole-unit money formatting', () => {
  it('groups complete values without decimals or compact suffixes', () => {
    expect(formatMoney(1_200)).toBe('1,200');
    expect(formatMoney(1_234_567.5)).toBe('1,234,568');
    expect(formatMoney(9_876_543_210_123)).toBe('9,876,543,210,123');
    expect(formatMoney(0)).toBe('0');
  });

  it('uses symmetric decimal ROUND_HALF_UP and never leaves a negative zero', () => {
    expect(formatMoney(400.49)).toBe('400');
    expect(formatMoney(400.5)).toBe('401');
    expect(formatMoney(-400.49)).toBe('-400');
    expect(formatMoney(-400.5)).toBe('-401');
    expect(formatMoney(-0.49)).toBe('0');
  });

  it('places the sign before the attached presentation symbol', () => {
    expect(formatMoney(4_125, { currency: 'INR' })).toBe('₹4,125');
    expect(formatMoney(-400, { currency: 'USD' })).toBe('-$400');
    expect(formatMoney(400, { currency: 'SGD', signed: true })).toBe('+S$400');
    expect(formatMoney(4_125, { currency: 'INR', showCurrency: false })).toBe('4,125');
  });

  it.each(CURRENCY_CATALOG)('uses the catalog symbol for $code', ({ code, symbol }) => {
    expect(formatMoney(1_234.5, { currency: code })).toBe(`${symbol}1,235`);
  });

  it('uses ISO codes in accessibility labels', () => {
    expect(formatAccessibleMoney(4_125, { currency: 'INR' })).toBe('INR 4,125');
    expect(formatAccessibleMoney(-400, { currency: 'USD', signed: true })).toBe('USD -400');
    expect(formatAccessibleMoney(400, { currency: 'SGD', signed: true })).toBe('SGD +400');
  });

  it('falls back to zero for non-finite values', () => {
    expect(formatMoney(Number.NaN, { currency: 'INR' })).toBe('₹0');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('keeps formatWholeMoney as a compatibility alias', () => {
    expect(formatWholeMoney(1_250, { currency: 'LKR' })).toBe('Rs1,250');
    expect(formatWholeMoney(-1_250, { currency: 'NPR' })).toBe('-रू1,250');
  });

  it('formats structured budget overages with symbols and complete grouped values', () => {
    expect(formatBudgetWarning({
      budget_overage: 4_125,
      currency: 'INR',
      warning: 'Legacy INR warning',
    })).toBe('This expense puts you ₹4,125 over the trip budget.');
    expect(formatBudgetWarning({
      budget_overage: 400,
      currency: 'SGD',
    })).toBe('This expense puts you S$400 over the trip budget.');
  });

  it('falls back to legacy or generic budget warnings for older or invalid responses', () => {
    expect(formatBudgetWarning({ warning: 'Legacy server warning.' }))
      .toBe('Legacy server warning.');
    expect(formatBudgetWarning({
      budget_overage: 400.5,
      currency: 'INR',
      warning: 'Invalid structured response fallback.',
    })).toBe('Invalid structured response fallback.');
    expect(formatBudgetWarning(undefined)).toBe('This exceeds the trip budget.');
  });
});

describe('pluralize', () => {
  it('uses singular for 1 and plural otherwise', () => {
    expect(pluralize(1, 'trip')).toBe('1 trip');
    expect(pluralize(0, 'trip')).toBe('0 trips');
    expect(pluralize(3, 'trip')).toBe('3 trips');
    expect(pluralize(2, 'person', 'people')).toBe('2 people');
  });
});
