import {
  buildCategorySpendBreakdown,
  type CategorySpendExpense,
} from '../categorySpend';

const members = [
  { id: 'a', name: 'Alex', kind: 'individual' as const },
  { id: 'b', name: 'Blair', kind: 'individual' as const },
  { id: 'fam', name: 'Patel', kind: 'family' as const },
];

const expense = (
  id: string,
  amount: number,
  paidBy: string,
  over: Partial<CategorySpendExpense> = {},
): CategorySpendExpense => ({
  id,
  amount,
  paid_by_member_id: paidBy,
  category: 'Food',
  date: '01-01-25',
  time: null,
  created_at: `2025-01-01T00:00:0${id.length}+00:00`,
  ...over,
});

describe('buildCategorySpendBreakdown', () => {
  it('groups positive fronted amounts by payer and reconciles gross, refunds, and net', () => {
    const result = buildCategorySpendBreakdown([
      expense('a1', 70.1, 'a'),
      expense('a2', 29.9, 'a'),
      expense('b1', 50, 'b'),
      expense('r1', -20, 'a'),
      expense('x1', 999, 'a', { category: 'Travel' }),
    ], members, 'Food');

    expect(result.grossPaid).toBe(150);
    expect(result.refunds).toBe(20);
    expect(result.net).toBe(130);
    expect(result.transactionCount).toBe(4);
    expect(result.payerSummary).toMatchObject({ total: 150, count: 2 });
    expect(result.payerSummary.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: 'a', paid: 100, expense_count: 2 }),
      expect.objectContaining({ entity_id: 'b', paid: 50, expense_count: 1 }),
    ]));
  });

  it('keeps a family as one payer entity and labels unknown legacy payers safely', () => {
    const result = buildCategorySpendBreakdown([
      expense('f1', 200, 'fam'),
      expense('u1', 10, 'removed'),
    ], members, 'Food');

    expect(result.payerSummary.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_id: 'fam', entity_type: 'family', name: 'Patel' }),
      expect.objectContaining({ entity_id: 'removed', entity_type: 'individual', name: 'Unknown payer' }),
    ]));
  });

  it('uses integer cents so repeated decimal amounts do not drift', () => {
    const result = buildCategorySpendBreakdown([
      expense('a1', 0.1, 'a'),
      expense('a2', 0.2, 'a'),
      expense('r1', -0.1, 'a'),
    ], members, 'Food');
    expect(result.grossPaid).toBe(0.3);
    expect(result.refunds).toBe(0.1);
    expect(result.net).toBe(0.2);
  });

  it('orders largest spends first, then largest refunds, with newest ties first', () => {
    const result = buildCategorySpendBreakdown([
      expense('small', 20, 'a'),
      expense('large-old', 100, 'a', { date: '01-01-25', time: '09:00' }),
      expense('large-new', 100, 'b', { date: '02-01-25', time: '09:00' }),
      expense('refund-small', -10, 'a'),
      expense('refund-large', -80, 'b'),
    ], members, 'Food');

    expect(result.transactions.map((row) => row.id)).toEqual([
      'large-new', 'large-old', 'small', 'refund-large', 'refund-small',
    ]);
  });

  it('does not mutate its input and returns an empty breakdown for no match', () => {
    const input = [expense('travel', 10, 'a', { category: 'Travel' })];
    const snapshot = [...input];
    const result = buildCategorySpendBreakdown(input, members, 'Food');
    expect(input).toEqual(snapshot);
    expect(result).toEqual({
      net: 0,
      grossPaid: 0,
      refunds: 0,
      transactionCount: 0,
      payerSummary: { total: 0, count: 0, entities: [] },
      transactions: [],
    });
  });
});
