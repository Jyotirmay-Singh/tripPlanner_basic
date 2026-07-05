// Pure, dependency-free helpers for the per-member spend drill-down (Phase 17). Given the trip's
// expense list (as returned by GET /trips/{id}/expenses, each row already carrying the
// calculator-derived `shares` breakdown), it selects the expenses ONE entity fronted and totals
// them — the breakdown of what makes up that entity's gross-spend bar. Kept side-effect-free so the
// filter/total logic is unit-testable without a component render, mirroring src/spend.ts and
// src/expenseShares.ts.
//
// RECONCILIATION (critical): "gross spend" for the bar (backend services/spend_summary.aggregate_spend)
// is what the entity PAID/FRONTED — Σ amount over expenses where amount > 0 AND
// paid_by_member_id == entity.id, rounded to 2dp. It is split-mode-INDEPENDENT and EXCLUDES refunds.
// So `total` here sums the SAME positive fronted amounts and rounds the same way, and therefore equals
// the entity's bar value exactly. The per-expense `share` (this entity's own split share) is carried
// for DISPLAY only and deliberately does NOT feed `total` — a share reconciles to Balances, not to
// this bar.

import type { ExpenseShares } from './expenseShares';

export type MemberSpendExpense = {
  id: string;
  description?: string;
  category: string;
  date: string;
  time?: string | null;
  created_at?: string | null;
  amount: number;
  split_mode?: 'PER_CAPITA' | 'PER_FAMILY' | 'EXACT';
  paid_by_member_id: string;
  shares?: ExpenseShares | null;
};

export type MemberSpendRow = {
  id: string;
  description?: string;
  category: string;
  date: string;
  time?: string | null;
  created_at?: string | null;
  amount: number;
  split_mode: 'PER_CAPITA' | 'PER_FAMILY' | 'EXACT';
  /** This entity's own share of the expense (from the backend `shares` breakdown), or null when no
   *  breakdown is available. DISPLAY-only — never summed into `total`. */
  share: number | null;
};

/**
 * The expenses `memberId` fronted, plus their reconciling total. Filters to positive-amount expenses
 * (refunds excluded) whose payer IS this entity — the exact summands of the entity's gross-spend bar,
 * so `total` equals that bar's value. Each row also carries this entity's own split `share` (pulled
 * from the expense's `shares.entities`, or null if absent) for display. Never mutates the input and
 * does not sort (the screen applies sortExpensesDesc for latest-first display).
 */
export function memberSpendHistory(
  expenses: MemberSpendExpense[] | null | undefined,
  memberId: string,
): { rows: MemberSpendRow[]; total: number } {
  const rows: MemberSpendRow[] = [];
  let cents = 0;
  for (const e of expenses ?? []) {
    if (!(e.amount > 0) || e.paid_by_member_id !== memberId) continue; // gross fronted only ⇒ matches the bar
    const self = e.shares?.entities?.find((x) => x.id === memberId);
    rows.push({
      id: e.id,
      description: e.description,
      category: e.category,
      date: e.date,
      time: e.time,
      created_at: e.created_at,
      amount: e.amount,
      split_mode: e.split_mode ?? 'PER_CAPITA',
      share: self ? self.share : null,
    });
    cents += Math.round(e.amount * 100);
  }
  return { rows, total: cents / 100 };
}
