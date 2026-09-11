// Pure, dependency-free helpers for the Settle-Up screen's partial payments (Phase 20).
// Mirrors the backend db.payments overlay + services/payments.py::pair_blocks. A payment is a directed
// money movement already netted into backend suggestions by _compute_balances, so these helpers
// only group payment records by their (from -> to) direction for display.

import type { Transfer } from './settlements';
import {
  currencyDefinition,
  currencyIncrement,
  currencyPrecisionIssue,
  fromCurrencyUnits,
  toCurrencyUnits,
} from './currencies';

export type { Transfer };

export type Payment = {
  id: string;
  from_member_id: string;
  to_member_id: string;
  amount: number;
  currency?: string;
  created_at: string;
  recorded_by?: string;
  note?: string | null;
  settlement_policy_version?: string;
  settlement_increment?: string;
};

export type PaymentRecipientCandidate = {
  person_id: string;
  name: string;
  family_id: string | null;
  family_name: string | null;
  account_linked: boolean;
  upi_id: string | null;
  upi_updated_at: string | null;
};

export type PaymentRecipientDetails = {
  trip_id: string;
  from_member_id: string;
  to_member_id: string;
  recipients: PaymentRecipientCandidate[];
};

export type PaymentHandoffPreviewRequest = {
  from_member_id: string;
  to_member_id: string;
  amount: string;
  quote_id?: string;
};

export type PaymentHandoffQuote = {
  quote_id: string;
  rate: string;
  effective_rate_date: string | null;
  provider: string;
  stale: boolean;
  expires_at: string;
};

export type PaymentHandoffPreview = {
  trip_id: string;
  trip_name: string;
  from_member_id: string;
  from_name: string;
  to_member_id: string;
  to_name: string;
  source_amount: string;
  source_currency: string;
  current_payable: string;
  inr_amount: string;
  quote: PaymentHandoffQuote;
  recipients: PaymentRecipientCandidate[];
};

export type PaymentRecipientSnapshot = Readonly<{
  person_id: string;
  name: string;
  family_id: string | null;
  family_name: string | null;
  upi_id: string | null;
  upi_updated_at: string | null;
}>;

/** Copy the exact person and UPI revision that the payer reviewed. */
export function snapshotPaymentRecipient(
  candidate: PaymentRecipientCandidate,
): PaymentRecipientSnapshot {
  return Object.freeze({
    person_id: candidate.person_id,
    name: candidate.name,
    family_id: candidate.family_id,
    family_name: candidate.family_name,
    upi_id: candidate.upi_id,
    upi_updated_at: candidate.upi_updated_at,
  });
}

/** Whether freshly fetched details invalidate a previously reviewed recipient snapshot. */
export function paymentRecipientRequiresReview(
  snapshot: PaymentRecipientSnapshot | null | undefined,
  current: PaymentRecipientDetails | null | undefined,
): boolean {
  if (!snapshot || !current) return true;
  const candidate = current.recipients.find(
    (recipient) => recipient.person_id === snapshot.person_id,
  );
  if (!candidate?.account_linked || !candidate.upi_id) return true;
  return candidate.name !== snapshot.name
    || candidate.family_id !== snapshot.family_id
    || candidate.family_name !== snapshot.family_name
    || candidate.upi_id !== snapshot.upi_id
    || candidate.upi_updated_at !== snapshot.upi_updated_at;
}

/** Whether authoritative action-time data differs from anything the payer approved. */
export function paymentHandoffRequiresReview(
  reviewed: PaymentHandoffPreview | null | undefined,
  current: PaymentHandoffPreview | null | undefined,
  recipientSnapshot: PaymentRecipientSnapshot | null | undefined,
): boolean {
  if (!reviewed || !current || reviewed.trip_id !== current.trip_id) return true;
  const reviewedQuote = reviewed.quote;
  const currentQuote = current.quote;
  if (
    reviewed.from_member_id !== current.from_member_id
    || reviewed.to_member_id !== current.to_member_id
    || reviewed.source_amount !== current.source_amount
    || reviewed.source_currency !== current.source_currency
    || reviewed.current_payable !== current.current_payable
    || reviewed.inr_amount !== current.inr_amount
    || reviewedQuote.quote_id !== currentQuote.quote_id
    || reviewedQuote.rate !== currentQuote.rate
    || reviewedQuote.effective_rate_date !== currentQuote.effective_rate_date
    || reviewedQuote.provider !== currentQuote.provider
    || reviewedQuote.stale !== currentQuote.stale
    || reviewedQuote.expires_at !== currentQuote.expires_at
  ) return true;

  return paymentRecipientRequiresReview(recipientSnapshot, {
    trip_id: current.trip_id,
    from_member_id: current.from_member_id,
    to_member_id: current.to_member_id,
    recipients: current.recipients,
  });
}

export type PaymentStatus = 'open' | 'partial' | 'paid';

/** One debtor->creditor block for the settle-up UI: headline + paid + derived status + log. */
export type PairBlock = {
  from_member_id: string;
  to_member_id: string;
  current_payable: number;
  paid: number;
  original_payable: number;
  status: PaymentStatus;
  payments: Payment[];
};

const minorUnit = (currency: string) => Number(currencyIncrement(currency));

/** Ignore only sub-minor-unit transport noise, never a legal non-zero payment. */
const zeroTolerance = (currency: string) => minorUnit(currency) / 2;

const roundMoney = (value: number, currency: string) =>
  fromCurrencyUnits(toCurrencyUnits(value, currency), currency);

/** Payments recorded along the exact from->to direction, newest-first. Never mutates the input. */
export function paymentsForPair(
  payments: Payment[] | null | undefined,
  fromId: string,
  toId: string,
): Payment[] {
  return (payments ?? [])
    .filter((payment) =>
      payment.from_member_id === fromId && payment.to_member_id === toId)
    .sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : -1));
}

/** Total paid along a direction, summed in integer minor units. */
export function pairPaid(
  payments: Payment[] | null | undefined,
  fromId: string,
  toId: string,
  currency = 'INR',
): number {
  const units = paymentsForPair(payments, fromId, toId)
    .reduce((sum, payment) => sum + toCurrencyUnits(payment.amount, currency), 0);
  return fromCurrencyUnits(units, currency);
}

/**
 * Derived pair state: 'paid' (residual cleared with payments), 'partial' (some paid, some left),
 * or 'open' (nothing recorded). Mirrors payment_status in backend services/payments.py.
 */
export function paymentStatus(
  currentPayable: number,
  paid: number,
  currency = 'INR',
): PaymentStatus {
  const tolerance = zeroTolerance(currency);
  if (paid <= tolerance) return 'open';
  return currentPayable <= tolerance ? 'paid' : 'partial';
}

/** The pair's original debt = current residual + what's already been paid along it. */
export function originalPayable(
  currentPayable: number,
  paid: number,
  currency = 'INR',
): number {
  return roundMoney(currentPayable + paid, currency);
}

/**
 * Roll payments up per direction: one block per current suggested pair (in suggestion order),
 * then a block for every payment direction that no longer appears as a suggestion (fully settled).
 */
export function buildPairBlocks(
  transfers: Transfer[] | null | undefined,
  payments: Payment[] | null | undefined,
  currency = 'INR',
): PairBlock[] {
  const list = payments ?? [];
  const key = (from: string, to: string) => JSON.stringify([from, to]);
  const seen = new Set<string>();
  const blocks: PairBlock[] = [];

  for (const transfer of transfers ?? []) {
    seen.add(key(transfer.from_member_id, transfer.to_member_id));
    const paid = pairPaid(
      list, transfer.from_member_id, transfer.to_member_id, currency,
    );
    const current = roundMoney(transfer.amount, currency);
    blocks.push({
      from_member_id: transfer.from_member_id,
      to_member_id: transfer.to_member_id,
      current_payable: current,
      paid,
      original_payable: originalPayable(current, paid, currency),
      status: paymentStatus(current, paid, currency),
      payments: paymentsForPair(
        list, transfer.from_member_id, transfer.to_member_id,
      ),
    });
  }

  // Settled-only directions: payments exist but the pair is no longer suggested (residual 0).
  const leftovers: { from: string; to: string; recent: string }[] = [];
  const directions = new Set(
    list.map((payment) => key(payment.from_member_id, payment.to_member_id)),
  );
  for (const direction of directions) {
    if (seen.has(direction)) continue;
    const [from, to] = JSON.parse(direction) as [string, string];
    const records = paymentsForPair(list, from, to);
    leftovers.push({ from, to, recent: records[0]?.created_at || '' });
  }
  leftovers.sort((a, b) => (a.recent < b.recent ? 1 : -1));
  for (const { from, to } of leftovers) {
    const paid = pairPaid(list, from, to, currency);
    blocks.push({
      from_member_id: from,
      to_member_id: to,
      current_payable: 0,
      paid,
      original_payable: paid,
      status: paymentStatus(0, paid, currency),
      payments: paymentsForPair(list, from, to),
    });
  }
  return blocks;
}

/**
 * Validate a settle-up amount before recording: it must be positive, use the trip currency's legal
 * precision, and not exceed the pair's payable. rawAmount preserves what the user typed so number
 * conversion cannot hide excess fractional digits.
 */
export function validatePaymentAmount(
  amount: number,
  maxPayable: number,
  options: {
    wholeUnit?: boolean;
    currency?: string;
    rawAmount?: string;
    allowLegacyPrecision?: boolean;
  } = {},
): { ok: boolean; error: string | null } {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Enter an amount greater than 0' };
  }

  const currency = options.currency || 'INR';
  if (options.wholeUnit && !Number.isInteger(amount)) {
    return {
      ok: false,
      error: `Enter a whole ${currencyDefinition(currency).code} amount`,
    };
  }

  const precisionIssue = options.allowLegacyPrecision
    ? null
    : currencyPrecisionIssue(options.rawAmount ?? String(amount), currency);
  if (precisionIssue) {
    return {
      ok: false,
      error: `Enter a valid ${currencyDefinition(currency).code} amount: ${precisionIssue}`,
    };
  }

  const tolerance = options.wholeUnit ? 0 : zeroTolerance(currency);
  if (amount > maxPayable + tolerance) {
    return { ok: false, error: 'Amount exceeds the payable for this pair' };
  }
  return { ok: true, error: null };
}
