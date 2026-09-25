/* eslint-disable import/first */
import { Platform } from 'react-native';

jest.mock('../offlineStore', () => ({
  offlineStore: {
    getExpenseProtocolVersion: jest.fn(), enqueueOutbox: jest.fn(), listOutbox: jest.fn(),
    replaceReviewExpense: jest.fn(),
  },
}));
jest.mock('../syncWorker', () => ({ syncCoordinator: { wake: jest.fn() } }));

import { offlineStore } from '../offlineStore';
import { captureExpense, listPendingExpenses, makeExpenseOutboxItem } from '../offlineExpenses';

const store = offlineStore as jest.Mocked<typeof offlineStore>;
const trip = {
  id: 'trip-1', currency: 'INR', members: [
    { id: 'family', kind: 'family', family_members: ['A', 'B'], family_member_ids: ['a', 'b'] },
    { id: 'solo', kind: 'individual', family_members: [] },
    { id: 'excluded', kind: 'individual', family_members: [] },
  ],
};
const uuid = '7fa30d5e-b4f6-4cb3-b45a-27b4119d0101';
const base = {
  amount: -90, currency: 'INR', category: 'Food', description: 'Refund', date: '25-09-26',
  time: null, paid_by_member_id: 'solo', split_member_ids: ['family', 'solo'],
  split_mode: 'PER_FAMILY' as const, weight_snapshots: null,
  family_participants: { family: ['a'] },
};

beforeEach(() => {
  jest.clearAllMocks();
  store.getExpenseProtocolVersion.mockResolvedValue(1);
  store.listOutbox.mockResolvedValue([]);
  store.enqueueOutbox.mockResolvedValue();
});

it('freezes the exact selected roster, family participation, and negative refund intent', () => {
  const item = makeExpenseOutboxItem('account-1', trip, base, uuid, 100);
  expect(item).toMatchObject({
    clientMutationId: uuid, accountId: 'account-1', tripId: 'trip-1', operation: 'expense_create',
    state: 'queued', queuedAt: 100,
    payload: {
      amount: -90, split_member_ids: ['family', 'solo'], split_mode: 'PER_FAMILY',
      family_participants: { family: ['a'] }, client_mutation_id: uuid,
      expected_roster: { currency: 'INR', members: [
        { id: 'family', kind: 'family', family_member_ids: ['a', 'b'] },
        { id: 'solo', kind: 'individual', family_member_ids: [] },
      ] },
    },
  });
  expect(item.payload.split_member_ids).not.toContain('excluded');
  expect(base.split_member_ids).toEqual(['family', 'solo']);
});

it('preserves exact person allocations and rejects an implicit everyone split', () => {
  const item = makeExpenseOutboxItem('account-1', trip, {
    ...base, amount: -100, split_mode: 'EXACT', family_participants: null,
    custom_amounts: { a: 70, solo: 30 },
  }, uuid);
  expect(item.payload.custom_amounts).toEqual({ a: 70, solo: 30 });
  expect(item.payload.amount).toBe(-100);
  expect(() => makeExpenseOutboxItem('account-1', trip,
    { ...base, split_member_ids: [] }, uuid)).toThrow('Choose at least one participant');
  expect(() => makeExpenseOutboxItem('account-1', trip,
    { ...base, currency: 'USD' }, uuid)).toThrow('needs internet');
});

it('does not claim a failed write, but recognizes a matching row after an uncertain commit', async () => {
  const item = makeExpenseOutboxItem('account-1', trip, base, uuid);
  store.enqueueOutbox.mockRejectedValue(new Error('disk full'));
  await expect(captureExpense(item)).rejects.toThrow('disk full');
  store.listOutbox.mockResolvedValue([item]);
  await expect(captureExpense(item)).resolves.toBeUndefined();
  expect(store.enqueueOutbox).toHaveBeenCalledWith(item);
});

it('holds capture when the server expense protocol was not verified', async () => {
  store.getExpenseProtocolVersion.mockResolvedValue(0);
  await expect(captureExpense(makeExpenseOutboxItem('account-1', trip, base, uuid)))
    .rejects.toThrow('Expense sync is unavailable');
  expect(store.enqueueOutbox).not.toHaveBeenCalled();
});

it('shows each unsynced UUID once and omits a known confirmed canonical ID', async () => {
  const originalOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  try {
    const item = makeExpenseOutboxItem('account-1', trip, base, uuid, 100);
    store.listOutbox.mockResolvedValue([
      item, item,
      { ...item, clientMutationId: 'uuid-2', canonicalResourceId: 'confirmed-1' },
      { ...item, clientMutationId: 'uuid-3', state: 'synced' },
      { ...item, clientMutationId: 'uuid-4', tripId: 'other-trip' },
    ]);
    const pending = await listPendingExpenses('account-1', 'trip-1', ['confirmed-1']);
    expect(pending.map((row) => row.clientMutationId)).toEqual([uuid]);
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  }
});
