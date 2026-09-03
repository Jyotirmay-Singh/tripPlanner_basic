import { formatCompactMoney, formatMoney, formatWholeMoney, pluralize } from '../format';

describe('formatMoney', () => {
  it('formats with grouped thousands and 2 decimals', () => {
    expect(formatMoney(1200)).toBe('1,200.00');
    expect(formatMoney(1234567.5)).toBe('1,234,567.50');
    expect(formatMoney(0)).toBe('0.00');
    expect(formatMoney(42.1)).toBe('42.10');
  });

  it('handles negatives (sign before the grouped digits)', () => {
    expect(formatMoney(-1500.5)).toBe('-1,500.50');
    expect(formatMoney(-0.004)).toBe('0.00'); // rounds to zero, no stray minus
  });

  it('adds a + only for non-negative values when signed', () => {
    expect(formatMoney(250, { signed: true })).toBe('+250.00');
    expect(formatMoney(0, { signed: true })).toBe('+0.00');
    expect(formatMoney(-250, { signed: true })).toBe('-250.00');
  });

  it('prefixes a currency code when given', () => {
    expect(formatMoney(1200, { currency: 'INR' })).toBe('INR 1,200.00');
    expect(formatMoney(-99.9, { currency: 'USD', signed: true })).toBe('USD -99.90');
  });

  it('falls back to 0.00 for non-finite input', () => {
    expect(formatMoney(NaN)).toBe('0.00');
    expect(formatMoney(Infinity)).toBe('0.00');
  });
});

describe('formatCompactMoney', () => {
  it('keeps small values exact and abbreviates large values with trimmed precision', () => {
    expect(formatCompactMoney(0, { currency: 'INR' })).toBe('INR 0.00');
    expect(formatCompactMoney(100_000, { currency: 'INR' })).toBe('INR 100K');
    expect(formatCompactMoney(9_999_999.99, { currency: 'INR' })).toBe('INR 10M');
    expect(formatCompactMoney(123_456_789, { currency: 'INR' })).toBe('INR 123.46M');
  });

  it('supports shorter fallback precision without losing sign or currency context', () => {
    expect(formatCompactMoney(-123_456_789, { currency: 'USD', maximumFractionDigits: 1 })).toBe('USD -123.5M');
    expect(formatCompactMoney(123_456_789, { signed: true, maximumFractionDigits: 0 })).toBe('+123M');
    expect(formatCompactMoney(NaN, { currency: 'INR' })).toBe('INR 0.00');
  });
});

describe('pluralize', () => {
  it('uses singular for 1 and plural otherwise', () => {
    expect(pluralize(1, 'trip')).toBe('1 trip');
    expect(pluralize(0, 'trip')).toBe('0 trips');
    expect(pluralize(3, 'trip')).toBe('3 trips');
  });

  it('respects an explicit plural form', () => {
    expect(pluralize(2, 'person', 'people')).toBe('2 people');
    expect(pluralize(1, 'person', 'people')).toBe('1 person');
  });
});

describe('formatWholeMoney', () => {
  it('renders LKR/NPR settlement units without decimal places', () => {
    expect(formatWholeMoney(1250, { currency: 'LKR' })).toBe('LKR 1,250');
    expect(formatWholeMoney(-1250, { currency: 'NPR' })).toBe('NPR -1,250');
    expect(formatWholeMoney(4, { signed: true })).toBe('+4');
  });
});
