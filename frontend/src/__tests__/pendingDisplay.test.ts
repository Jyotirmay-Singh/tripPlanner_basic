import { capturePendingDisplay, pendingDisplay, pendingMemberName } from '../pendingDisplay';
import type { StoredOutboxItem } from '../offlineStore.shared';

const trip = { name: 'Coastal trip', currency: 'INR', members: [
  { id: 'payer', name: 'Asha', kind: 'individual' },
  { id: 'family', name: 'Patels', kind: 'family', family_members: ['Meera', 'Dev'],
    family_member_ids: ['meera', 'dev'] },
  { id: 'other', name: 'Uninvolved' },
] };
const item = (payload: Record<string, unknown>, operation = 'expense_create'): StoredOutboxItem => ({
  accountId: 'A', tripId: 'deleted-trip', clientMutationId: 'saved-id', operation,
  payload, precondition: { display: capturePendingDisplay(trip, ['payer', 'family']) },
  queuedAt: 1, state: 'needs_review', attemptCount: 0, nextRetryAt: null,
  canonicalResourceId: null, acknowledgedResponse: null, lastSafeErrorCode: 'trip_unavailable',
} as StoredOutboxItem);

it('captures only relevant names and resolves entity and exact family allocations after deletion', () => {
  const row = item({});
  expect(row.precondition).toEqual({ display: { tripName: 'Coastal trip', memberNames: {
    payer: 'Asha', family: 'Patels', meera: 'Meera', dev: 'Dev',
  } } });
  expect(pendingMemberName(row, 'meera')).toBe('Meera');
  expect(pendingMemberName(row, 'payer', { members: [{ id: 'payer', name: 'Renamed' }] })).toBe('Asha');
});

it.each([
  [{ description: 'Dinner', amount: 100, currency: 'INR' }, 'Dinner', 'INR 100'],
  [{ category: 'Travel', original_amount: '20', original_currency: 'USD' }, 'Travel', 'USD 20'],
  [{ description: 'Refund', original_amount: '-9', original_currency: 'USD', amount: -750, currency: 'INR' }, 'Refund', 'USD -9'],
])('retains original transaction identity and amount', (payload, identity, amount) => {
  const row = item(payload);
  expect(pendingDisplay(row)).toMatchObject({ identity, amount, tripName: 'Coastal trip' });
  expect(pendingDisplay(row).actionLabel('Review')).toBe(`Review: ${identity}, ${amount}, Coastal trip`);
});

it('gives a rejected payment named parties and readable legacy fallbacks without UUIDs', () => {
  const row = item({ from_member_id: 'payer', to_member_id: 'family', amount: 50,
    expected_currency: 'INR' }, 'manual_payment_create');
  expect(pendingDisplay(row).identity).toBe('Asha → Patels');
  const legacy = { ...row, precondition: {} };
  expect(pendingMemberName(legacy, 'payer', trip)).toBe('Asha');
  expect(pendingMemberName(legacy, '550e8400-e29b-41d4-a716-446655440000')).toBe('Member unavailable');
  expect(pendingDisplay(legacy).tripName).toBe('Group unavailable');
});

it.each([null, [], { amount: null }])('keeps malformed local intent %p reviewable without inventing a zero amount', (payload) => {
  const row = { ...item({}), payload, lastSafeErrorCode: 'invalid_local_payload' };
  expect(pendingDisplay(row)).toMatchObject({ identity: 'Transaction', amount: 'Amount unavailable' });
});
