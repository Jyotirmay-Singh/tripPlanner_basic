import { hasShareBreakdown, shareVerbs, type ExpenseShares } from '../expenseShares';

const sample: ExpenseShares = {
  mode: 'PER_CAPITA',
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
  it('unified paid / owes wording (negatives read as credits via the minus sign)', () => {
    const v = shareVerbs();
    expect(v.payerVerb).toBe('paid');
    expect(v.participantVerb).toBe('owes');
  });
});
