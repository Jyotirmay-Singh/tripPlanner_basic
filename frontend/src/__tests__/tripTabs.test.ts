import { tripTabFromParam } from '../tripTabs';


describe('trip notification tab parameter', () => {
  it('accepts only the Expenses deep-link tab', () => {
    expect(tripTabFromParam('expenses')).toBe('expenses');
    expect(tripTabFromParam(['expenses'])).toBe('expenses');
  });

  it('preserves Summary as the default for absent or untrusted values', () => {
    expect(tripTabFromParam(undefined)).toBe('summary');
    expect(tripTabFromParam('balances')).toBe('summary');
    expect(tripTabFromParam('anything')).toBe('summary');
  });
});
