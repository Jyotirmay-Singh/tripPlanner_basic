// Step 22 (post-launch): tiny pure helpers for the per-trip bill gallery and the inline
// "Bill not attached" state. Kept dependency-free so the conditional logic is unit-testable
// without a component render harness (mirrors src/receipt.ts).

/** An expense the gallery/inline UI cares about: only the receipt presence flag is needed. */
export type WithReceipt = { has_receipt?: boolean };

/** Keep only the expenses that have an attached bill (GridFS receipt or legacy inline blob). */
export function receiptExpenses<T extends WithReceipt>(expenses: T[]): T[] {
  return (expenses || []).filter((e) => !!e.has_receipt);
}

/**
 * Caption to show inline next to an expense when it has no bill.
 * Returns the "Bill not attached" string when absent, or null when a bill is attached
 * (the caller renders a thumbnail instead).
 */
export function billLabel(e: WithReceipt): string | null {
  return e.has_receipt ? null : 'Bill not attached';
}
