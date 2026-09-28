import { matchesExpenseDescription } from '../expenseSearch';

describe('matchesExpenseDescription', () => {
  it('matches case-insensitive substrings in descriptions', () => {
    expect(matchesExpenseDescription('Bengali food', 'FOOD')).toBe(true);
    expect(matchesExpenseDescription('The food biryani', 'food')).toBe(true);
    expect(matchesExpenseDescription('Seafood dinner', 'food')).toBe(true);
    expect(matchesExpenseDescription('Taxi ride', 'food')).toBe(false);
  });

  it('requires every query word, in any order', () => {
    expect(matchesExpenseDescription('The food biryani', ' BIRYANI   food ')).toBe(true);
    expect(matchesExpenseDescription('Bengali food', 'food biryani')).toBe(false);
  });

  it('shows all rows for a blank query, including rows without descriptions', () => {
    expect(matchesExpenseDescription(undefined, '')).toBe(true);
    expect(matchesExpenseDescription(undefined, '  \n  ')).toBe(true);
    expect(matchesExpenseDescription(undefined, 'food')).toBe(false);
    expect(matchesExpenseDescription('', 'food')).toBe(false);
  });
});
