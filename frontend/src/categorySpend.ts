import { compareExpensesDesc, type SortableExpense } from './expenseSort';
import type { SpendEntity, SpendSummary } from './spend';

export type CategorySpendMember = {
  id: string;
  name: string;
  kind?: 'individual' | 'family';
};

export type CategorySpendExpense = SortableExpense & {
  amount: number;
  category: string;
  description?: string;
  paid_by_member_id: string;
};

export type CategorySpendBreakdown<T extends CategorySpendExpense = CategorySpendExpense> = {
  /** Signed category total: gross paid minus refunds. */
  net: number;
  /** Positive money fronted in this category; this is the payer-bar denominator. */
  grossPaid: number;
  /** Absolute value of all negative transactions in this category. */
  refunds: number;
  transactionCount: number;
  payerSummary: SpendSummary;
  /** Positive spends largest-first, then refunds largest-by-absolute-value. */
  transactions: T[];
};

function cents(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function compareCategoryTransactions(a: CategorySpendExpense, b: CategorySpendExpense): number {
  const aCents = cents(a.amount);
  const bCents = cents(b.amount);
  const aGroup = aCents > 0 ? 0 : aCents < 0 ? 1 : 2;
  const bGroup = bCents > 0 ? 0 : bCents < 0 ? 1 : 2;
  if (aGroup !== bGroup) return aGroup - bGroup;

  if (aGroup === 0 && aCents !== bCents) return bCents - aCents;
  if (aGroup === 1 && Math.abs(aCents) !== Math.abs(bCents)) {
    return Math.abs(bCents) - Math.abs(aCents);
  }
  return compareExpensesDesc(a, b);
}

/**
 * Derive the category detail entirely from the already-authorized trip + expense payloads.
 * Paid/fronted bars intentionally include positive transactions only, matching Top spenders.
 */
export function buildCategorySpendBreakdown<T extends CategorySpendExpense>(
  expenses: T[] | null | undefined,
  members: CategorySpendMember[] | null | undefined,
  category: string,
): CategorySpendBreakdown<T> {
  const matched = (expenses ?? []).filter((expense) => expense.category === category);
  const memberById = new Map((members ?? []).map((member) => [member.id, member]));
  const payerCents = new Map<string, { paid: number; expenseCount: number }>();
  let netCents = 0;
  let grossCents = 0;
  let refundCents = 0;

  for (const expense of matched) {
    const amountCents = cents(expense.amount);
    netCents += amountCents;
    if (amountCents > 0) {
      grossCents += amountCents;
      const current = payerCents.get(expense.paid_by_member_id) ?? { paid: 0, expenseCount: 0 };
      current.paid += amountCents;
      current.expenseCount += 1;
      payerCents.set(expense.paid_by_member_id, current);
    } else if (amountCents < 0) {
      refundCents += Math.abs(amountCents);
    }
  }

  const entities: SpendEntity[] = Array.from(payerCents, ([entityId, aggregate]) => {
    const member = memberById.get(entityId);
    return {
      entity_id: entityId,
      entity_type: member?.kind === 'family' ? 'family' : 'individual',
      name: member?.name || 'Unknown payer',
      paid: aggregate.paid / 100,
      expense_count: aggregate.expenseCount,
    };
  });

  return {
    net: netCents / 100,
    grossPaid: grossCents / 100,
    refunds: refundCents / 100,
    transactionCount: matched.length,
    payerSummary: {
      total: grossCents / 100,
      count: entities.length,
      entities,
    },
    transactions: [...matched].sort(compareCategoryTransactions),
  };
}
