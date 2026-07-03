import { memberSpendHistory, MemberSpendExpense } from '../memberSpend';
import type { ExpenseShares } from '../expenseShares';

// A `shares` payload where `payer` fronts `amount` and each entry in `owes` owes that share.
const shares = (payer: string, amount: number, owes: Record<string, number>): ExpenseShares => ({
  mode: 'PER_CAPITA',
  payer_id: payer,
  amount,
  entities: Object.entries(owes).map(([id, share]) => ({
    id, name: id, share, is_payer: id === payer, members: [],
  })),
});

const mk = (over: Partial<MemberSpendExpense> & { id: string; amount: number; paid_by_member_id: string }): MemberSpendExpense => ({
  category: over.category ?? 'Food',
  date: over.date ?? '10-06-25',
  split_mode: over.split_mode ?? 'PER_CAPITA',
  ...over,
});

describe('memberSpendHistory', () => {
  it('selects only the positive expenses this member fronted; total = their bar value', () => {
    const expenses = [
      mk({ id: 'e1', amount: 130, paid_by_member_id: 'A' }),
      mk({ id: 'e2', amount: 90, paid_by_member_id: 'A' }),
      mk({ id: 'e3', amount: 50, paid_by_member_id: 'B' }), // different payer
    ];
    const { rows, total } = memberSpendHistory(expenses, 'A');
    expect(rows.map((r) => r.id)).toEqual(['e1', 'e2']);
    expect(total).toBe(220); // 130 + 90 — exactly the gross-spend bar for A
  });

  it('excludes refunds (negative) and zero-amount rows so it matches the gross bar', () => {
    const expenses = [
      mk({ id: 'e1', amount: 100, paid_by_member_id: 'A' }),
      mk({ id: 'e2', amount: -40, paid_by_member_id: 'A' }), // refund — not gross spend
      mk({ id: 'e3', amount: 0, paid_by_member_id: 'A' }),   // zero
    ];
    const { rows, total } = memberSpendHistory(expenses, 'A');
    expect(rows.map((r) => r.id)).toEqual(['e1']);
    expect(total).toBe(100);
  });

  it('pulls THIS entity\'s own share from the expense shares breakdown', () => {
    const expenses = [
      mk({ id: 'e1', amount: 130, paid_by_member_id: 'A', shares: shares('A', 130, { A: 40, B: 40, C: 50 }) }),
    ];
    const { rows } = memberSpendHistory(expenses, 'A');
    expect(rows[0].share).toBe(40);
    expect(rows[0].amount).toBe(130); // fronted amount is unchanged by the share
  });

  it('works the same for a family payer (payer id is the family entity id)', () => {
    const expenses = [
      mk({ id: 'e1', amount: 300, paid_by_member_id: 'FAM', split_mode: 'PER_FAMILY', shares: shares('FAM', 300, { FAM: 150, IND: 150 }) }),
    ];
    const { rows, total } = memberSpendHistory(expenses, 'FAM');
    expect(rows).toHaveLength(1);
    expect(rows[0].share).toBe(150);
    expect(rows[0].split_mode).toBe('PER_FAMILY');
    expect(total).toBe(300);
  });

  it('share is null when there is no shares payload', () => {
    const expenses = [mk({ id: 'e1', amount: 100, paid_by_member_id: 'A' })];
    expect(memberSpendHistory(expenses, 'A').rows[0].share).toBe(null);
  });

  it('share is null when this member is absent from the shares entities', () => {
    const expenses = [
      mk({ id: 'e1', amount: 100, paid_by_member_id: 'A', shares: shares('A', 100, { B: 50, C: 50 }) }),
    ];
    expect(memberSpendHistory(expenses, 'A').rows[0].share).toBe(null);
  });

  it('sums cleanly to 2dp (no float drift)', () => {
    const expenses = [
      mk({ id: 'e1', amount: 0.1, paid_by_member_id: 'A' }),
      mk({ id: 'e2', amount: 0.2, paid_by_member_id: 'A' }),
    ];
    expect(memberSpendHistory(expenses, 'A').total).toBe(0.3);
  });

  it('empty / no-match yields { rows: [], total: 0 }', () => {
    expect(memberSpendHistory([], 'A')).toEqual({ rows: [], total: 0 });
    expect(memberSpendHistory(null, 'A')).toEqual({ rows: [], total: 0 });
    expect(memberSpendHistory(undefined, 'A')).toEqual({ rows: [], total: 0 });
    expect(memberSpendHistory([mk({ id: 'e1', amount: 10, paid_by_member_id: 'B' })], 'A')).toEqual({ rows: [], total: 0 });
  });

  it('does not mutate the input array', () => {
    const input = [mk({ id: 'e1', amount: 10, paid_by_member_id: 'A' }), mk({ id: 'e2', amount: 20, paid_by_member_id: 'A' })];
    const snapshot = input.map((e) => e.id);
    memberSpendHistory(input, 'A');
    expect(input.map((e) => e.id)).toEqual(snapshot);
  });
});
