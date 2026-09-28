/* eslint-disable import/first */
import { Platform } from 'react-native';

jest.mock('../offlineStore', () => ({ offlineStore: {
  getPaymentProtocolVersion: jest.fn(), enqueueOutbox: jest.fn(), listOutbox: jest.fn(),
  replaceReviewPayment: jest.fn(),
} }));
jest.mock('../syncWorker', () => ({ syncCoordinator: { wake: jest.fn() } }));

import { offlineStore } from '../offlineStore';
import { syncCoordinator } from '../syncWorker';
import {
  capturePayment, listPendingPayments, makePaymentOutboxItem,
} from '../offlinePayments';

const store = offlineStore as jest.Mocked<typeof offlineStore>;
const uuid = '7fa30d5e-b4f6-4cb3-b45a-27b4119d0101';
const members = [
  { id: 'payer', kind: 'individual', user_id: 'payer-user' },
  { id: 'receiver', kind: 'individual', user_id: 'receiver-user' },
  { id: 'family', kind: 'family', family_member_user_ids: ['family-user', null] },
];
const trip = { id: 'trip-1', currency: 'INR', owner_id: 'owner-user',
  admin_ids: ['admin-user'], user_ids: ['payer-user', 'receiver-user', 'family-user', 'admin-user'],
  members };
const pair = { from_member_id: 'payer', to_member_id: 'receiver', amount: 50 };
const balances = { currency: 'INR', transfers: [pair] };

beforeEach(() => {
  jest.clearAllMocks();
  store.getPaymentProtocolVersion.mockResolvedValue(1);
  store.listOutbox.mockResolvedValue([]);
  store.enqueueOutbox.mockResolvedValue();
  store.replaceReviewPayment.mockResolvedValue();
});

it('captures a partial payment with the exact pair, cap, currency, and UUID', () => {
  const item = makePaymentOutboxItem('receiver-user', trip, balances, pair, 20, ' Cash ', 123, uuid, 456);
  expect(item).toMatchObject({
    clientMutationId: uuid, accountId: 'receiver-user', tripId: 'trip-1',
    operation: 'manual_payment_create', queuedAt: 456, state: 'queued',
    payload: { from_member_id: 'payer', to_member_id: 'receiver', amount: 20,
      note: 'Cash', client_mutation_id: uuid, expected_payable: 50, expected_currency: 'INR' },
    precondition: { expectedPayable: 50, currency: 'INR', fetchedAt: 123 },
  });
  expect(pair.amount).toBe(50);
});

it('allows the receiver, linked family receiver, and admin but not the payer or an unrelated user', () => {
  expect(() => makePaymentOutboxItem('receiver-user', trip, balances, pair, 10, '', 123, uuid))
    .not.toThrow();
  const familyPair = { ...pair, to_member_id: 'family' };
  expect(() => makePaymentOutboxItem('family-user', trip,
    { currency: 'INR', transfers: [familyPair] }, familyPair, 10, '', 123, uuid)).not.toThrow();
  expect(() => makePaymentOutboxItem('admin-user', trip, balances, pair, 10, '', 123, uuid))
    .not.toThrow();
  expect(() => makePaymentOutboxItem('payer-user', trip, balances, pair, 10, '', 123, uuid))
    .toThrow('cannot record');
  expect(() => makePaymentOutboxItem('other-user', trip, balances, pair, 10, '', 123, uuid))
    .toThrow('cannot record');
});

it('rejects an excessive, fractional, or stale suggested payment before saving', () => {
  expect(() => makePaymentOutboxItem('receiver-user', trip, balances, pair, 51, '', 123, uuid))
    .toThrow('exceeds');
  expect(() => makePaymentOutboxItem('receiver-user', trip, balances, pair, 1.5, '', 123, uuid))
    .toThrow('whole');
  expect(() => makePaymentOutboxItem('receiver-user', trip, { currency: 'INR', transfers: [] },
    pair, 20, '', 123, uuid)).toThrow('suggestion changed');
  expect(() => makePaymentOutboxItem('receiver-user', trip, balances,
    { ...pair, amount: 40 }, 20, '', 123, uuid)).toThrow('suggestion changed');
});

it('requires a previously verified payment protocol and never claims an unsuccessful local save', async () => {
  const item = makePaymentOutboxItem('receiver-user', trip, balances, pair, 20, '', 123, uuid);
  store.getPaymentProtocolVersion.mockResolvedValueOnce(0);
  await expect(capturePayment(item)).rejects.toThrow('Payment sync is unavailable');
  expect(store.enqueueOutbox).not.toHaveBeenCalled();
  store.enqueueOutbox.mockRejectedValueOnce(new Error('disk full'));
  await expect(capturePayment(item)).rejects.toThrow('disk full');
  expect(syncCoordinator.wake).not.toHaveBeenCalled();
  store.enqueueOutbox.mockRejectedValueOnce(new Error('uncertain commit'));
  store.listOutbox.mockResolvedValueOnce([item]);
  await expect(capturePayment(item)).resolves.toBeUndefined();
  expect(syncCoordinator.wake).toHaveBeenCalledWith('receiver-user');
});

it('requeues an explicitly edited review with a new UUID and leaves a failed replacement intact', async () => {
  const item = makePaymentOutboxItem('receiver-user', trip, balances, pair, 20, '', 123, uuid);
  const oldId = 'old-review-id';
  store.replaceReviewPayment.mockRejectedValueOnce(new Error('disk full'));
  await expect(capturePayment(item, oldId)).rejects.toThrow('disk full');
  expect(store.enqueueOutbox).not.toHaveBeenCalled();
  await capturePayment(item, oldId);
  expect(store.replaceReviewPayment).toHaveBeenCalledWith('receiver-user', oldId, item);
});

it('shows each unresolved payment once across a restarted read and never mixes accounts', async () => {
  const originalOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  try {
    const item = makePaymentOutboxItem('receiver-user', trip, balances, pair, 20, '', 123, uuid);
    store.listOutbox.mockResolvedValue([item, item,
      { ...item, clientMutationId: 'confirmed-id', canonicalResourceId: 'server-payment' },
      { ...item, clientMutationId: 'synced-id', state: 'synced' },
      { ...item, clientMutationId: 'other-id', accountId: 'other-user' },
    ]);
    const result = await listPendingPayments('receiver-user', 'trip-1', ['server-payment']);
    expect(result.map((row) => row.clientMutationId)).toEqual([uuid]);
    expect(store.listOutbox).toHaveBeenCalledWith('receiver-user');
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  }
});
