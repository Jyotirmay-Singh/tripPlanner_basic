// Pure display helpers for the per-expense "Split details" breakdown.
//
// The numbers come from the backend (`shares`, derived via the SAME calculator the ledger uses — see
// backend/services/expense_shares.py); these helpers only gate rendering and pick the truthful
// wording for expense vs income. Keeping the logic here makes it unit-testable without a component
// render (mirrors src/bill.ts / src/displayNames.ts). DISPLAY-only: nothing here computes or alters a
// balance.

export type ShareMember = { id: string; name: string; share: number };
export type ShareEntity = {
  id: string;
  name: string;
  share: number;
  is_payer: boolean;
  members: ShareMember[];
};
export type ExpenseShares = {
  mode: 'PER_CAPITA' | 'PER_FAMILY';
  kind: 'expense' | 'income';
  payer_id: string;
  amount: number;
  entities: ShareEntity[];
};

/** True when there's a derived breakdown worth showing (at least one entity). */
export function hasShareBreakdown(shares?: ExpenseShares | null): boolean {
  return !!shares && Array.isArray(shares.entities) && shares.entities.length > 0;
}

export type ShareVerbs = {
  /** what the payer did with the full amount: "paid" (expense) / "received" (income). */
  payerVerb: string;
  /** how a participant relates to their share: "owes" (expense) / "share" (income). */
  participantVerb: string;
  /** optional display-only caveat — income is not split into balances. */
  note: string | null;
};

/**
 * Truthful wording for the breakdown. Expenses: the payer "paid" the bill, each participant "owes"
 * their computed share. Income: the payer "received" the money; participant "share" values are shown
 * for reference only and do NOT move balances (the ledger ignores income), hence the note.
 */
export function shareVerbs(kind: 'expense' | 'income'): ShareVerbs {
  if (kind === 'income') {
    return {
      payerVerb: 'received',
      participantVerb: 'share',
      note: "Income isn't split into balances — shares shown for reference.",
    };
  }
  return { payerVerb: 'paid', participantVerb: 'owes', note: null };
}
