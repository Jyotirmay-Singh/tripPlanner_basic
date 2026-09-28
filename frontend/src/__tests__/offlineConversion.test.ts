import { approvedForeignExpense, foreignExpenseInput, quoteMatchesExpense } from '../offlineConversion';
import type { ExchangeRateQuote } from '../api';
import type { StoredOutboxItem } from '../offlineStore.shared';

const now = Date.UTC(2026, 8, 27);
const item: StoredOutboxItem = {
  accountId: 'a', tripId: 't', clientMutationId: 'old', operation: 'expense_create',
  payload: { client_mutation_id: 'old', original_amount: '-90', original_currency: 'USD',
    date: '25-09-26', split_member_ids: ['m'],
    expected_roster: { currency: 'INR', members: [{ id: 'm', kind: 'individual', family_member_ids: [] }] } },
  precondition: { currency: 'INR' }, queuedAt: 12, state: 'needs_review', attemptCount: 0,
  nextRetryAt: null, lastSafeErrorCode: 'conversion_review_needed',
  canonicalResourceId: null, acknowledgedResponse: null,
};
const quote: ExchangeRateQuote = {
  quote_id: 'quote-1', mode: 'automatic', source_amount: '-90', source_currency: 'USD',
  target_amount: '-7500', target_currency: 'INR', rate: '83.333333',
  requested_date: '2026-09-25', effective_rate_date: '2026-09-25',
  provider: 'frankfurter_v2_blended', provider_sources: [], cache_hit: false,
  stale: false, manual: false, requires_confirmation: true,
  expires_at: new Date(now + 60_000).toISOString(),
};

it('approves only a matching, unexpired server quote and retains the captured split', () => {
  expect(foreignExpenseInput(item)).toEqual({ amount: '-90', sourceCurrency: 'USD',
    tripCurrency: 'INR', date: '2026-09-25' });
  expect(quoteMatchesExpense(item, quote, now)).toBe(true);
  const approved = approvedForeignExpense(item, quote, now);
  expect(approved).toMatchObject({ clientMutationId: 'old', queuedAt: 12,
    state: 'queued', lastSafeErrorCode: null, payload: {
      client_mutation_id: 'old', original_amount: '-90', original_currency: 'USD',
      split_member_ids: ['m'], conversion: { mode: 'automatic', quote_id: 'quote-1',
        approved: true, allow_stale: false },
    } });
  expect(item.payload).not.toHaveProperty('conversion');
  expect(() => approvedForeignExpense(item, { ...quote, source_amount: '-91' }, now))
    .toThrow('new conversion quote');
  expect(() => approvedForeignExpense(item, quote, now + 51_000))
    .toThrow('new conversion quote');
});
