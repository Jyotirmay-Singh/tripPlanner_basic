/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockToast = jest.fn();
const mockDiscardPayment = jest.fn();
const mockRetry = jest.fn();
let mockRows: any[] = [];

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (callback: any) => R.useEffect(() => callback(), [callback]),
  };
});
jest.mock('../../AuthContext', () => ({ useAuth: () => ({
  user: { id: 'account-a' }, sessionMode: 'online',
}) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({
  colors: new Proxy({}, { get: () => '#123456' }),
}) }));
jest.mock('../../offlineReads', () => ({ loadDashboardOverview: async () => ({
  source: 'live', fetchedAt: 100, data: { trips: [], balances: null },
}) }));
jest.mock('../../offlineStore', () => ({ offlineStore: {
  listOutbox: async () => mockRows,
  getSyncMeta: async () => ({ lastSuccessfulRefreshAt: 50 }),
  discardReviewPayment: (...args: any[]) => mockDiscardPayment(...args),
} }));
jest.mock('../../offlineActivation', () => ({ offlineWritesActive: () => true }));
jest.mock('../../offlineExpenses', () => ({
  pendingStatusLabel: (item: { state: string }) => item.state === 'needs_review'
    ? 'Needs review · Pending sync' : 'Pending sync',
  reviewReason: () => 'Your permission changed.',
}));
jest.mock('../../syncWorker', () => ({ syncCoordinator: {
  subscribe: () => () => {}, retry: (...args: any[]) => mockRetry(...args), wake: jest.fn(),
} }));
jest.mock('../../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../../TripListCard', () => ({ __esModule: true, default: () => null }));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ConfirmModal', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ConfirmModal', props) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { TabScreen: stub('TabScreen'), Card: stub('Card'), Button: stub('Button'),
    EmptyState: stub('EmptyState'), SkeletonCard: stub('SkeletonCard'),
    Icon: stub('Icon'), IconButton: stub('IconButton'),
    useToast: () => ({ show: mockToast }) };
});

import Trips from '../../../app/(tabs)/trips';

beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [{
    clientMutationId: 'expense-1', accountId: 'account-a', tripId: 'lost-trip',
    operation: 'expense_create', state: 'needs_review', queuedAt: Date.now(),
    lastSafeErrorCode: 'permission_lost', payload: { amount: 12 },
  }, {
    clientMutationId: 'payment-1', accountId: 'account-a', tripId: 'lost-trip',
    operation: 'manual_payment_create', state: 'needs_review', queuedAt: Date.now(),
    lastSafeErrorCode: 'permission_lost', payload: {
      from_member_id: 'm1', to_member_id: 'm2', amount: 5, expected_currency: 'INR',
    },
  }];
  mockDiscardPayment.mockImplementation(async () => {
    mockRows = mockRows.filter((row) => row.clientMutationId !== 'payment-1');
  });
  mockRetry.mockResolvedValue(true);
});

it('keeps orphaned expense and payment reviews accessible and discards payment only after confirmation', async () => {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<Trips />); });
  expect(renderer.root.findByProps({ testID: 'trips-sync-queue' })).toBeTruthy();
  await act(async () => {
    renderer.root.findByProps({ testID: 'trips-review-expense-1' }).props.onPress();
  });
  expect(mockPush).toHaveBeenCalledWith('/trip/lost-trip/pending-expense?mutationId=expense-1');
  await act(async () => {
    renderer.root.findByProps({ testID: 'trips-retry-payment-1' }).props.onPress();
  });
  expect(mockRetry).toHaveBeenCalledWith('account-a', 'payment-1');
  await act(async () => {
    renderer.root.findByProps({ testID: 'trips-discard-payment-1' }).props.onPress();
  });
  expect(mockDiscardPayment).not.toHaveBeenCalled();
  const modal = renderer.root.findByType('ConfirmModal' as any);
  expect(modal.props.visible).toBe(true);
  await act(async () => { modal.props.actions[1].onPress(); });
  expect(mockDiscardPayment).toHaveBeenCalledWith('account-a', 'payment-1');
  expect(renderer.root.findAllByProps({ testID: 'trips-pending-payment-1' })).toHaveLength(0);
});
