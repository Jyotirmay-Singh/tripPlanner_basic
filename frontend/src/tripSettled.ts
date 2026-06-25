// Trip-level "settled" signal for the Expenses-tab "Settled" badge. DISPLAY-ONLY and
// dependency-free (mirrors src/bill.ts) so the conditional logic is unit-testable without a
// component render harness. It reuses the EXACT signal settle-up.tsx uses for "All square!" —
// an empty suggested-transfers list — so the badge can never disagree with the settle-up screen.

/** Minimal shape the flag needs from GET /trips/{id}/balances. */
export type WithTransfers = {
  transfers?: { from_member_id: string; to_member_id: string; amount: number }[];
} | null;

/**
 * True iff the whole trip is fully settled, i.e. there are no suggested settlements left (every
 * entity's net rounds to ~0 upstream). Mirrors settle-up.tsx's `transfers.length === 0` "All square!"
 * condition. Null/loading balances => false (don't flash the badge before data loads).
 */
export function isTripSettled(balances: WithTransfers): boolean {
  return !!balances && (balances.transfers?.length ?? 0) === 0;
}
