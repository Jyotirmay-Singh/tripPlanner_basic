/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockListOutbox = jest.fn();
const mockTripSnapshot = jest.fn();
const mockDiscard = jest.fn();
const mockRetry = jest.fn();
let mockUserId = 'receiver-user';

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => ({ id: 'trip-1', mutationId: 'uuid-1' }),
    useRouter: () => ({ push: mockRouterPush, back: mockRouterBack }),
    useFocusEffect: (callback: any) => R.useEffect(callback, [callback]),
  };
});
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: mockUserId } }) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: { warning: '#eea' } }) }));
jest.mock('../../offlineStore', () => ({ offlineStore: {
  listOutbox: (...args: any[]) => mockListOutbox(...args),
  getTripSnapshot: (...args: any[]) => mockTripSnapshot(...args),
  discardReviewPayment: (...args: any[]) => mockDiscard(...args),
} }));
jest.mock('../../offlinePayments', () => ({ paymentCaptureActive: () => true }));
jest.mock('../../offlineExpenses', () => ({
  pendingStatusLabel: () => 'Needs review · Pending sync',
  reviewReason: () => 'The suggested payment changed.',
}));
jest.mock('../../syncWorker', () => ({ syncCoordinator: {
  subscribe: () => () => {}, retry: (...args: any[]) => mockRetry(...args), wake: jest.fn(),
} }));
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
  return {
    Screen: stub('Screen'), Card: stub('Card'), Button: stub('Button'),
    EmptyState: stub('EmptyState'), useToast: () => ({ show: jest.fn() }),
  };
});

import PendingPaymentDetail from '../../../app/trip/[id]/pending-payment';

const item = {
  clientMutationId: 'uuid-1', accountId: 'receiver-user', tripId: 'trip-1',
  operation: 'manual_payment_create', state: 'needs_review', queuedAt: 1_700_000_000_000,
  lastSafeErrorCode: 'payment_recommendation_changed', canonicalResourceId: null,
  payload: { from_member_id: 'payer', to_member_id: 'receiver', amount: 20,
    note: 'Cash', expected_payable: 50, expected_currency: 'INR' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUserId = 'receiver-user';
  mockListOutbox.mockResolvedValue([item]);
  mockTripSnapshot.mockResolvedValue({ payload: { members: [
    { id: 'payer', name: 'Payer' }, { id: 'receiver', name: 'Receiver' },
  ] } });
  mockDiscard.mockResolvedValue(undefined);
  mockRetry.mockResolvedValue(true);
});

it('shows the unchanged payment facts and requires explicit action to edit or discard', async () => {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingPaymentDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-payment-status' })).toBeTruthy();
  const text = renderer.root.findAllByType('T').map((entry: any) => entry.props.children);
  expect(text).toContain('Saved on this device as a record of money already exchanged. The server must accept it before confirmed balances change.');
  await act(async () => { renderer.root.findByProps({ testID: 'pending-payment-edit' }).props.onPress(); });
  expect(mockRouterPush).toHaveBeenCalledWith('/trip/trip-1/settle-up?reviewId=uuid-1');
  await act(async () => { renderer.root.findByProps({ testID: 'pending-payment-retry' }).props.onPress(); });
  expect(mockRetry).toHaveBeenCalledWith('receiver-user', 'uuid-1');
  expect(mockDiscard).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findByProps({ testID: 'pending-payment-discard' }).props.onPress(); });
  const modal = renderer.root.findAllByType('ConfirmModal' as any)
    .find((entry: any) => entry.props.title === 'Discard pending payment?');
  await act(async () => { modal.props.actions[1].onPress(); });
  expect(mockDiscard).toHaveBeenCalledWith('receiver-user', 'uuid-1');
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
});

it('hides a loaded payment immediately when the active account changes', async () => {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingPaymentDetail />); });
  mockUserId = 'other-user';
  mockListOutbox.mockResolvedValue([]);
  await act(async () => { renderer.update(<PendingPaymentDetail />); });
  expect(renderer.root.findAllByProps({ testID: 'pending-payment-status' })).toHaveLength(0);
  expect(mockListOutbox).toHaveBeenCalledWith('other-user');
});

it('keeps an orphaned payment review reachable when the trip snapshot is missing', async () => {
  mockTripSnapshot.mockRejectedValueOnce(new Error('Trip was removed'));
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingPaymentDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-payment-status' })).toBeTruthy();
  expect(renderer.root.findByProps({ testID: 'pending-payment-discard' })).toBeTruthy();
});
