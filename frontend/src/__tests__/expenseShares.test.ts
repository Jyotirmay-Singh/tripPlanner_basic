import { hasShareBreakdown, shareVerbs, type ExpenseShares } from '../expenseShares';

const sample: ExpenseShares = {
  mode: 'PER_CAPITA',
  kind: 'expense',
  payer_id: 'i1',
  amount: 130,
  entities: [
    { id: 'i1', name: 'I1', share: 10, is_payer: true, members: [] },
    {
      id: 'f1', name: 'F1', share: 40, is_payer: false,
      members: [{ id: 'f1a', name: 'A', share: 20 }, { id: 'f1b', name: 'B', share: 20 }],
    },
  ],
};

describe('hasShareBreakdown', () => {
  it('true when there is at least one entity', () => {
    expect(hasShareBreakdown(sample)).toBe(true);
  });

  it('false for null/undefined/empty', () => {
    expect(hasShareBreakdown(null)).toBe(false);
    expect(hasShareBreakdown(undefined)).toBe(false);
    expect(hasShareBreakdown({ ...sample, entities: [] })).toBe(false);
  });
});

describe('shareVerbs', () => {
  it('expense: paid / owes, no note', () => {
    const v = shareVerbs('expense');
    expect(v.payerVerb).toBe('paid');
    expect(v.participantVerb).toBe('owes');
    expect(v.note).toBeNull();
  });

  it('income: received / share, with a "not split into balances" note', () => {
    const v = shareVerbs('income');
    expect(v.payerVerb).toBe('received');
    expect(v.participantVerb).toBe('share');
    expect(v.note).toMatch(/balances/i);
  });
});
