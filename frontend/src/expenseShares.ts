// Pure display helpers for the per-expense "Split details" breakdown.
//
// The numbers come from the backend (`shares`, derived via the SAME calculator the ledger uses — see
// backend/services/expense_shares.py); these helpers only gate rendering and supply the wording.
// Keeping the logic here makes it unit-testable without a component render (mirrors src/bill.ts /
// src/displayNames.ts). DISPLAY-only: nothing here computes or alters a balance. A negative `amount`
// (money back) carries its sign through to the numbers; the wording stays "paid / owes" since the
// minus sign itself conveys the credited direction.

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
  payer_id: string;
  amount: number;
  entities: ShareEntity[];
};

/** True when there's a derived breakdown worth showing (at least one entity). */
export function hasShareBreakdown(shares?: ExpenseShares | null): boolean {
  return !!shares && Array.isArray(shares.entities) && shares.entities.length > 0;
}

export type ShareVerbs = {
  /** what the payer did with the full amount. */
  payerVerb: string;
  /** how a participant relates to their share. */
  participantVerb: string;
};

/**
 * Wording for the breakdown: the payer "paid" the bill, each participant "owes" their computed share.
 * For a negative amount (money back) the figures are negative, which reads as a credit — no separate
 * wording or "doesn't affect balances" note is needed, because every transaction now moves balances.
 */
export function shareVerbs(): ShareVerbs {
  return { payerVerb: 'paid', participantVerb: 'owes' };
}
