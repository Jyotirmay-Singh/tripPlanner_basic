// Pure helpers for the signed-amount transaction model (positive = expense, negative = money coming
// back to the group). Unit-tested in src/__tests__/signedAmount.test.ts. DISPLAY/validation only —
// the authoritative split + balances are computed server-side (services/calculator.py + balances.py).

/** Parse the amount field. Accepts a leading minus and decimals; '' / '-' / junk -> NaN. */
export function parseAmount(raw: string): number {
  return parseFloat(raw);
}

/** A valid amount is any finite, non-zero real (mirror of backend models/expense.py `_validate_amount`). */
export function isValidAmount(a: number): boolean {
  return Number.isFinite(a) && a !== 0;
}

/**
 * Soft, non-blocking guardrail (display only): true when a refund's magnitude exceeds the trip's
 * current net spend so far. The user can still save — this only drives a muted warning line.
 * `netSpendExcludingThis` is the sum of every other transaction's signed amount.
 */
export function refundExceedsSpend(amount: number, netSpendExcludingThis: number): boolean {
  return amount < 0 && Math.abs(amount) > Math.max(0, netSpendExcludingThis);
}

export const REFUND_WARNING =
  "This money-back is larger than the trip's total spend so far — you can still save.";
