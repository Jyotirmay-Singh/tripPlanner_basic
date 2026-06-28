// Pure, dependency-free helpers for the Settle-Up screen's settlement history (Phase 10).
// Mirrors the backend db.settlements lifecycle (pending -> paid). Kept side-effect-free so the
// partition/match logic is unit-testable without a component render (like src/bill.ts and
// src/tripSettled.ts).

export type SettlementStatus = 'pending' | 'paid';

export type Settlement = {
  id: string;
  from_member_id: string;
  to_member_id: string;
  amount: number;
  status: SettlementStatus;
  created_at: string;
  paid_at?: string | null;
  note?: string | null;
};

/** A live greedy suggestion from GET /balances (before any pending record exists). */
export type Transfer = {
  from_member_id: string;
  to_member_id: string;
  amount: number;
};

/**
 * Split a settlement list into pending and paid buckets, each sorted newest-first (pending by
 * created_at desc; paid by paid_at desc, falling back to created_at when paid_at is missing).
 * Tolerant of a null/undefined list; never mutates the input.
 */
export function partitionSettlements(
  list: Settlement[] | null | undefined,
): { pending: Settlement[]; paid: Settlement[] } {
  const pending: Settlement[] = [];
  const paid: Settlement[] = [];
  for (const s of list ?? []) {
    (s.status === 'paid' ? paid : pending).push(s);
  }
  pending.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  paid.sort((a, b) => {
    const ax = a.paid_at || a.created_at;
    const bx = b.paid_at || b.created_at;
    return ax < bx ? 1 : -1;
  });
  return { pending, paid };
}

/**
 * True iff a live suggested transfer already has a matching PENDING record (same from/to members
 * and amount within a cent). Used to swap the Suggested-section "Record" button for a muted
 * "Recorded" chip so the same transfer can't be recorded twice.
 */
export function isRecorded(transfer: Transfer, pending: Settlement[]): boolean {
  return pending.some(
    (s) =>
      s.from_member_id === transfer.from_member_id &&
      s.to_member_id === transfer.to_member_id &&
      Math.abs(s.amount - transfer.amount) < 0.01,
  );
}

/** Human-readable status label for a settlement row. */
export function statusLabel(s: { status: SettlementStatus }): 'Paid' | 'Pending' {
  return s.status === 'paid' ? 'Paid' : 'Pending';
}
