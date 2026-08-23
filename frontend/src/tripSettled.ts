// Trip-level settled signal for the Expenses-tab badge. Display-only and dependency-free.

/** Minimal shape the flag needs from GET /trips/{id}/balances. */
export type WithTransfers = {
  transfers?: { from_member_id: string; to_member_id: string; amount: number }[];
} | null;

/** True when the whole trip has no suggested settlement transfers left. */
export function isTripSettled(balances: WithTransfers): boolean {
  return !!balances && (balances.transfers?.length ?? 0) === 0;
}
