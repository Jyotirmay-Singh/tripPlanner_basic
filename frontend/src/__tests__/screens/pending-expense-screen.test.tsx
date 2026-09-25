/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRouterPush = jest.fn();
const mockRouterBack = jest.fn();
const mockToastShow = jest.fn();
const mockListOutbox = jest.fn();
const mockTripSnapshot = jest.fn();
const mockDiscard = jest.fn();
const mockRetry = jest.fn();
const mockApproveBudget = jest.fn();
let mockSessionMode = 'online';

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => ({ id: 'trip-1', mutationId: 'uuid-1' }),
    useRouter: () => ({ push: mockRouterPush, back: mockRouterBack }),
    useFocusEffect: (callback: any) => R.useEffect(() => { callback(); }, []),
  };
});
jest.mock('../../AuthContext', () => ({ useAuth: () => ({
  user: { id: 'account-1' }, sessionMode: mockSessionMode,
}) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: {
  warning: '#eea', textMain: '#fff', textMuted: '#999', primary: '#8cc',
} }) }));
jest.mock('../../offlineStore', () => ({ offlineStore: {
  listOutbox: (...args: any[]) => mockListOutbox(...args),
  getTripSnapshot: (...args: any[]) => mockTripSnapshot(...args),
  discardReviewExpense: (...args: any[]) => mockDiscard(...args),
} }));
jest.mock('../../offlineExpenses', () => ({
  expenseCaptureActive: () => true,
  pendingStatusLabel: () => 'Needs review · Pending sync',
  reviewReason: () => 'Trip participants changed. Review the split.',
}));
jest.mock('../../syncWorker', () => ({ syncCoordinator: {
  subscribe: () => () => {}, retry: (...args: any[]) => mockRetry(...args),
  approveBudget: (...args: any[]) => mockApproveBudget(...args), wake: jest.fn(),
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
    EmptyState: stub('EmptyState'), useToast: () => ({ show: mockToastShow }),
  };
});

import PendingExpenseDetail from '../../../app/trip/[id]/pending-expense';

beforeEach(() => {
  jest.clearAllMocks();
  mockListOutbox.mockResolvedValue([{
    clientMutationId: 'uuid-1', accountId: 'account-1', tripId: 'trip-1',
    operation: 'expense_create', state: 'needs_review', lastSafeErrorCode: 'expense_roster_changed',
    payload: { amount: -50, currency: 'INR', description: 'Refund', category: 'Food',
      date: '25-09-26', paid_by_member_id: 'member-1', split_member_ids: ['member-1'],
      split_mode: 'PER_CAPITA' },
  }]);
  mockTripSnapshot.mockResolvedValue({ payload: { members: [{ id: 'member-1', name: 'Asha' }] } });
  mockDiscard.mockResolvedValue(undefined);
  mockRetry.mockResolvedValue(true);
  mockApproveBudget.mockResolvedValue(true);
  mockSessionMode = 'online';
});

it('requires explicit confirmation before sending a budget overage with the saved ID', async () => {
  mockListOutbox.mockResolvedValueOnce([{
    clientMutationId: 'uuid-1', accountId: 'account-1', tripId: 'trip-1',
    operation: 'expense_create', state: 'needs_review',
    lastSafeErrorCode: 'budget_confirmation_required',
    reviewContext: { warning: '12 INR over budget' },
    payload: { amount: 12, currency: 'INR', category: 'Food', date: '25-09-26',
      paid_by_member_id: 'member-1', split_member_ids: ['member-1'], split_mode: 'PER_CAPITA' },
  }]);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  expect(mockApproveBudget).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ testID: 'pending-budget-approve' }).props.onPress();
  });
  const modal = renderer.root.findAllByType('ConfirmModal' as any)
    .find((entry: any) => entry.props.title === 'Approve budget overage?');
  expect(modal.props.message).toBe('12 INR over budget');
  await act(async () => { modal.props.actions[1].onPress(); });
  expect(mockApproveBudget).toHaveBeenCalledWith('account-1', 'uuid-1');
});

it('shows the captured review intent and discards only after confirmation', async () => {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-detail-status' })).toBeTruthy();
  await act(async () => { renderer.root.findByProps({ testID: 'pending-edit' }).props.onPress(); });
  expect(mockRouterPush).toHaveBeenCalledWith({ pathname: '/trip/[id]/add-expense',
    params: { id: 'trip-1', reviewId: 'uuid-1' } });
  expect(mockDiscard).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findByProps({ testID: 'pending-discard' }).props.onPress(); });
  const modal = renderer.root.findAllByType('ConfirmModal' as any)
    .find((entry: any) => entry.props.title === 'Discard pending expense?');
  expect(modal.props.visible).toBe(true);
  await act(async () => { modal.props.actions[1].onPress(); });
  expect(mockDiscard).toHaveBeenCalledWith('account-1', 'uuid-1');
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
});
