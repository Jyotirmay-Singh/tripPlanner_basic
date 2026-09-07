import { compareExpensesDesc, type SortableExpense } from './expenseSort';
import type { SpendEntity, SpendSummary } from './spend';
import { fromCurrencyUnits, toCurrencyUnits } from './currencies';

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

function units(value: number, currency: string): number {
  return Number.isFinite(value) ? toCurrencyUnits(value, currency) : 0;
}

function compareCategoryTransactions(
  a: CategorySpendExpense,
  b: CategorySpendExpense,
  currency: string,
): number {
  const aUnits = units(a.amount, currency);
  const bUnits = units(b.amount, currency);
  const aGroup = aUnits > 0 ? 0 : aUnits < 0 ? 1 : 2;
  const bGroup = bUnits > 0 ? 0 : bUnits < 0 ? 1 : 2;
  if (aGroup !== bGroup) return aGroup - bGroup;

  if (aGroup === 0 && aUnits !== bUnits) return bUnits - aUnits;
  if (aGroup === 1 && Math.abs(aUnits) !== Math.abs(bUnits)) {
    return Math.abs(bUnits) - Math.abs(aUnits);
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
  currency = 'INR',
): CategorySpendBreakdown<T> {
  const matched = (expenses ?? []).filter((expense) => expense.category === category);
  const memberById = new Map((members ?? []).map((member) => [member.id, member]));
  const payerCents = new Map<string, { paid: number; expenseCount: number }>();
  let netCents = 0;
  let grossCents = 0;
  let refundCents = 0;

  for (const expense of matched) {
    const amountCents = units(expense.amount, currency);
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
      paid: fromCurrencyUnits(aggregate.paid, currency),
      expense_count: aggregate.expenseCount,
    };
  });

  return {
    net: fromCurrencyUnits(netCents, currency),
    grossPaid: fromCurrencyUnits(grossCents, currency),
    refunds: fromCurrencyUnits(refundCents, currency),
    transactionCount: matched.length,
    payerSummary: {
      total: fromCurrencyUnits(grossCents, currency),
      count: entities.length,
      entities,
    },
    transactions: [...matched].sort((a, b) => compareCategoryTransactions(a, b, currency)),
  };
}
