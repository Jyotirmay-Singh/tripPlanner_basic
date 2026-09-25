/* eslint-disable import/first */
import { Platform } from 'react-native';

jest.mock('../api', () => ({
  api: jest.fn(),
  ApiError: class ApiError extends Error {},
}));
jest.mock('../offlineStore', () => ({
  offlineStore: {
    getAccountReadSnapshot: jest.fn(), putAccountReadSnapshot: jest.fn(),
    getTripReadBundle: jest.fn(), putTripReadBundle: jest.fn(),
    removeTripReadData: jest.fn(),
  },
}));

import { api } from '../api';
import { offlineStore } from '../offlineStore';
import { loadDashboardOverview, loadTripList, loadTripReadBundle } from '../offlineReads';
import type { Snapshot } from '../offlineStore.shared';

const apiMock = api as jest.Mock;
const store = offlineStore as jest.Mocked<typeof offlineStore>;
const snapshots = new Map<string, Snapshot>();
const key = (accountId: string, kind: string) => `${accountId}:${kind}`;
const networkError = () => Object.assign(new Error('airplane mode'), { code: 'network' });
let originalPlatform: string;

const trip = {
  id: 'trip-1', name: 'Coast', code: 'SECRET', currency: 'INR', budget: 1000,
  owner_id: 'user-1', admin_ids: ['user-1'], user_ids: ['user-1'],
  members: [{ id: 'member-1', name: 'Ada', kind: 'individual', family_members: [],
    user_id: 'user-1', email: 'private@example.com', mobile_number: '+919999999999' }],
};
const expenses = [{ id: 'expense-1', amount: 250, currency: 'INR', category: 'Food',
  description: 'Lunch', date: '25-09-26', paid_by_member_id: 'member-1',
  split_member_ids: ['member-1'] }];
const balances = { net: { 'member-1': 250 }, transfers: [], currency: 'INR',
  members: trip.members, per_person: [] };
const spend = { total: 250, count: 1, currency: 'INR', entities: [] };
const payments = [{ id: 'payment-1', from_member_id: 'member-1', to_member_id: 'member-2',
  amount: 100, currency: 'INR', created_at: '2026-09-25T10:00:00Z', note: 'Cash',
  transaction_reference: 'do-not-cache', upi_id: 'private@upi' }];

function online(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    '/trips': [trip],
    '/trips/trip-1': trip,
    '/trips/trip-1/expenses': expenses,
    '/trips/trip-1/balances': balances,
    '/trips/trip-1/spend-summary': spend,
    '/trips/trip-1/payments': payments,
    ...overrides,
  };
  apiMock.mockImplementation((path: string) => {
    const response = responses[path];
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
}

beforeEach(() => {
  originalPlatform = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  snapshots.clear();
  jest.clearAllMocks();
  store.putAccountReadSnapshot.mockImplementation(async (accountId, kind, snapshot) => {
    snapshots.set(key(accountId, kind), JSON.parse(JSON.stringify(snapshot)));
  });
  store.getAccountReadSnapshot.mockImplementation(async (accountId, kind) =>
    snapshots.get(key(accountId, kind)) ?? null);
  store.putTripReadBundle.mockImplementation(async (accountId, tripId, snapshot) => {
    snapshots.set(key(accountId, tripId), JSON.parse(JSON.stringify(snapshot)));
  });
  store.getTripReadBundle.mockImplementation(async (accountId, tripId) =>
    snapshots.get(key(accountId, tripId)) ?? null);
  store.removeTripReadData.mockImplementation(async (accountId, tripId) => {
    snapshots.delete(key(accountId, tripId));
  });
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

it('restores a complete trip after a simulated cold restart and keeps private fields out of the cache', async () => {
  online();
  expect((await loadTripList('user-1')).source).toBe('live');
  const live = await loadTripReadBundle('user-1', 'trip-1');
  expect(live.data?.trip).toEqual(trip); // Online presentation retains live contacts.
  const persisted = snapshots.get(key('user-1', 'trip-1'))!;
  expect(persisted.payload).toMatchObject({
    trip: { name: 'Coast', members: [{ name: 'Ada' }] },
    expenses: [{ amount: 250 }], balances: { net: { 'member-1': 250 } },
    spend: { total: 250 }, payments: [{ amount: 100, note: 'Cash' }],
  });
  expect(JSON.stringify(persisted.payload)).not.toMatch(/private@example|9999999999|private@upi|do-not-cache/);

  // No component state is reused: the second loader call can only read persisted snapshots.
  apiMock.mockRejectedValue(networkError());
  const restored = await loadTripReadBundle('user-1', 'trip-1');
  expect(restored.source).toBe('cache');
  expect(restored.fetchedAt).toBe(persisted.fetchedAt);
  expect(restored.data?.balances).toEqual(persisted.payload && (persisted.payload as any).balances);
  expect((await loadTripList('user-1')).data).toHaveLength(1);
});

it('hydrates an airplane-mode cold launch without waiting for API timeouts', async () => {
  online();
  await loadTripList('user-1');
  await loadTripReadBundle('user-1', 'trip-1');
  apiMock.mockClear();
  const [list, detail] = await Promise.all([
    loadTripList('user-1', true),
    loadTripReadBundle('user-1', 'trip-1', true),
  ]);
  expect(list.source).toBe('cache');
  expect(detail.source).toBe('cache');
  expect(apiMock).not.toHaveBeenCalled();
});

it('keeps the old complete financial snapshot after an incomplete refresh', async () => {
  online();
  await loadTripReadBundle('user-1', 'trip-1');
  const old = snapshots.get(key('user-1', 'trip-1'))!;
  online({
    '/trips/trip-1/expenses': [{ ...expenses[0], amount: 800 }],
    '/trips/trip-1/payments': networkError(),
  });
  const result = await loadTripReadBundle('user-1', 'trip-1');
  expect(result.source).toBe('cache');
  expect((result.data?.expenses as typeof expenses)[0].amount).toBe(250);
  expect(result.fetchedAt).toBe(old.fetchedAt);
  expect(store.putTripReadBundle).toHaveBeenCalledTimes(1);
});

it('shows unavailable rather than zero when a trip has no complete saved snapshot', async () => {
  apiMock.mockRejectedValue(networkError());
  const result = await loadTripReadBundle('user-1', 'trip-1');
  expect(result).toMatchObject({ data: null, source: 'unavailable', fetchedAt: null });
});

it('does not reopen a cached trip after a confirmed access denial', async () => {
  online();
  await loadTripReadBundle('user-1', 'trip-1');
  online({ '/trips/trip-1': Object.assign(new Error('Forbidden'), { code: 'http', status: 403 }) });
  const result = await loadTripReadBundle('user-1', 'trip-1');
  expect(result).toMatchObject({ data: null, source: 'unavailable', authoritativeError: true });
  expect(store.removeTripReadData).toHaveBeenCalledWith('user-1', 'trip-1');
});

it('never falls back to a saved dashboard after an authoritative 401', async () => {
  online();
  await loadDashboardOverview('user-1');
  apiMock.mockRejectedValue(Object.assign(new Error('expired'), { code: 'http', status: 401 }));
  const result = await loadDashboardOverview('user-1');
  expect(result).toMatchObject({ data: null, source: 'unavailable', authoritativeError: true });
});

it('drops cached read data for a trip removed from the authoritative list', async () => {
  online();
  await loadTripList('user-1');
  await loadTripReadBundle('user-1', 'trip-1');
  online({ '/trips': [] });
  await loadTripList('user-1');
  expect(store.removeTripReadData).toHaveBeenCalledWith('user-1', 'trip-1');
  expect((await loadTripList('user-1', true)).data).toEqual([]);
  expect((await loadTripReadBundle('user-1', 'trip-1', true)).data).toBeNull();
});

it('keeps the dashboard overview together when one balance refresh fails', async () => {
  online();
  const first = await loadDashboardOverview('user-1');
  expect(first.data?.balances?.['trip-1'].balance).toBe(250);
  const old = first.fetchedAt;
  online({ '/trips/trip-1/balances': networkError() });
  const stale = await loadDashboardOverview('user-1');
  expect(stale.source).toBe('cache');
  expect(stale.fetchedAt).toBe(old);
  expect(stale.data?.balances?.['trip-1'].balance).toBe(250);
});

it('keeps web online-only even if an Android snapshot exists', async () => {
  snapshots.set(key('user-1', 'trip-1'), { payload: { trip }, fetchedAt: 1 });
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  apiMock.mockRejectedValue(networkError());
  const result = await loadTripReadBundle('user-1', 'trip-1');
  expect(result.data).toBeNull();
  expect(store.getTripReadBundle).not.toHaveBeenCalled();
});
