import type { ExchangeRateQuote } from './api';
import { ddmmyyToDDMMYYYY, toISO } from './date';
import type { StoredOutboxItem } from './offlineStore.shared';

export type ForeignExpenseInput = {
  amount: string;
  sourceCurrency: string;
  tripCurrency: string;
  date: string;
};

export function foreignExpenseInput(item: StoredOutboxItem): ForeignExpenseInput | null {
  if (item.operation !== 'expense_create' || !item.payload
    || typeof item.payload !== 'object' || Array.isArray(item.payload)) return null;
  const body = item.payload as Record<string, unknown>;
  const roster = body.expected_roster as { currency?: unknown } | null;
  const sourceCurrency = body.original_currency;
  const tripCurrency = roster?.currency;
  const amount = body.original_amount;
  const date = toISO(ddmmyyToDDMMYYYY(String(body.date ?? '')));
  if (typeof sourceCurrency !== 'string' || typeof tripCurrency !== 'string'
    || sourceCurrency === tripCurrency || !date
    || (typeof amount !== 'string' && typeof amount !== 'number')
    || !Number.isSafeInteger(Number(amount)) || Number(amount) === 0) return null;
  return { amount: String(amount), sourceCurrency, tripCurrency, date };
}

export function conversionQuoteFromItem(item: StoredOutboxItem): ExchangeRateQuote | null {
  if (!item.reviewContext || typeof item.reviewContext !== 'object') return null;
  const quote = (item.reviewContext as { conversionQuote?: unknown }).conversionQuote;
  return quote && typeof quote === 'object' ? quote as ExchangeRateQuote : null;
}

export function quoteMatchesExpense(
  item: StoredOutboxItem, quote: ExchangeRateQuote | null, now = Date.now(),
): boolean {
  const input = foreignExpenseInput(item);
  return !!input && !!quote && quote.mode === 'automatic'
    && typeof quote.quote_id === 'string' && !!quote.quote_id
    && quote.source_currency === input.sourceCurrency
    && quote.target_currency === input.tripCurrency
    && Number(quote.source_amount) === Number(input.amount)
    && quote.requested_date === input.date
    && typeof quote.target_amount === 'string'
    && Number.isSafeInteger(Number(quote.target_amount))
    && Date.parse(quote.expires_at) > now + 10_000;
}

export function approvedForeignExpense(
  item: StoredOutboxItem, quote: ExchangeRateQuote, now = Date.now(),
): StoredOutboxItem {
  if (item.state !== 'needs_review' || !foreignExpenseInput(item)
    || !quoteMatchesExpense(item, quote, now)) {
    throw new Error('Request a new conversion quote before approving this expense.');
  }
  return {
    ...item,
    payload: {
      ...(item.payload as Record<string, unknown>),
      conversion: { mode: 'automatic', quote_id: quote.quote_id,
        approved: true, allow_stale: quote.stale },
    },
    state: 'queued', attemptCount: 0, nextRetryAt: null, lastSafeErrorCode: null,
    canonicalResourceId: null, acknowledgedResponse: null, reviewContext: null,
    budgetApproved: false,
  };
}
