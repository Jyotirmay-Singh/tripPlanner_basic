jest.mock('../../ui/CategoryBadge', () => ({ __esModule: true, default: () => null }));
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
const mockCaptureExpense = jest.fn();
const mockWake = jest.fn();
let mockSessionMode = 'online';
let mockAccount = 'account-1';

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => ({ id: 'trip-1', mutationId: 'uuid-1' }),
    useRouter: () => ({ push: mockRouterPush, back: mockRouterBack }),
    useFocusEffect: (callback: any) => R.useEffect(callback, [callback]),
  };
});
jest.mock('../../AuthContext', () => ({ useAuth: () => ({
  user: { id: mockAccount }, sessionMode: mockSessionMode,
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
  captureExpense: (...args: any[]) => mockCaptureExpense(...args),
  pendingStatusLabel: () => 'Needs review · Pending sync',
  reviewReason: () => 'Group participants changed. Review the split.',
}));
jest.mock('../../syncWorker', () => ({ syncCoordinator: {
  subscribe: () => () => {}, retry: (...args: any[]) => mockRetry(...args),
  approveBudget: (...args: any[]) => mockApproveBudget(...args),
  wake: (...args: any[]) => mockWake(...args),
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
  mockAccount = 'account-1';
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
  mockCaptureExpense.mockResolvedValue(undefined);
  mockSessionMode = 'online';
});

it.each(['invalid_write', 'trip_unavailable'])('keeps %s intent names and actions after snapshot deletion', async (code) => {
  mockTripSnapshot.mockRejectedValue(new Error('Snapshot removed'));
  mockListOutbox.mockResolvedValue([{
    clientMutationId: 'uuid-1', accountId: 'account-1', tripId: 'trip-1',
    operation: 'expense_create', state: 'needs_review', lastSafeErrorCode: code,
    precondition: { display: { tripName: 'Coast', memberNames: {
      payer: 'Asha', family: 'Patels', child: 'Meera',
    } } },
    payload: { original_amount: '-20', original_currency: 'USD', description: 'Taxi refund',
      paid_by_member_id: 'payer', split_member_ids: ['family'], split_mode: 'EXACT',
      original_custom_amounts: { child: 20 } },
  }]);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  const text = renderer.root.findAllByType('T').map((node: any) => node.props.children).flat().join(' ');
  expect(text).toContain('Asha');
  expect(text).toContain('Patels');
  expect(text).toContain('Meera USD 20');
  expect(text).toContain('USD -20');
  expect(renderer.root.findByProps({ testID: 'pending-discard' }).props.accessibilityLabel)
    .toBe('Discard pending expense: Taxi refund, USD -20, Coast');
  expect(mockCaptureExpense).not.toHaveBeenCalled();
});

it('does not reveal a previous account intent while a new account load is pending', async () => {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  mockAccount = 'account-b';
  mockListOutbox.mockImplementation(() => new Promise(() => {}));
  await act(async () => { renderer.update(<PendingExpenseDetail />); });
  expect(renderer.root.findAllByProps({ testID: 'pending-detail-status' })).toHaveLength(0);
  expect(mockListOutbox).toHaveBeenCalledWith('account-b');
  act(() => renderer.unmount());
});

it('shows a readable unavailable-member fallback for legacy orphaned rows', async () => {
  mockTripSnapshot.mockResolvedValue(null);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  const text = renderer.root.findAllByType('T').map((node: any) => node.props.children).flat().join(' ');
  expect(text).toContain('Member unavailable');
  expect(text).not.toContain('member-1');
});

it('keeps a malformed rejected local payload open for review and explicit discard', async () => {
  mockListOutbox.mockResolvedValue([{
    clientMutationId: 'uuid-1', accountId: 'account-1', tripId: 'trip-1',
    operation: 'expense_create', state: 'needs_review', lastSafeErrorCode: 'invalid_local_payload',
    payload: null,
  }]);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-discard' })).toBeTruthy();
  expect(renderer.root.findAllByProps({ testID: 'pending-retry' })).toHaveLength(0);
  expect(renderer.root.findAllByType('T').map((node: any) => node.props.children)).toContain('Amount unavailable');
});

it('shows the server quote and requires an explicit tap before queuing a foreign expense', async () => {
  const quote = {
    quote_id: 'quote-1', mode: 'automatic', source_amount: '-50', source_currency: 'USD',
    target_amount: '-4200', target_currency: 'INR', rate: '84',
    requested_date: '2026-09-25', effective_rate_date: '2026-09-25',
    provider: 'frankfurter_v2_blended', provider_sources: [], cache_hit: false,
    stale: false, manual: false, requires_confirmation: true,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  };
  mockListOutbox.mockResolvedValue([{ clientMutationId: 'uuid-1', accountId: 'account-1',
    tripId: 'trip-1', operation: 'expense_create', state: 'needs_review',
    lastSafeErrorCode: 'conversion_review_needed', reviewContext: { conversionQuote: quote },
    payload: { client_mutation_id: 'uuid-1', original_amount: '-50', original_currency: 'USD',
      category: 'Food', date: '25-09-26', paid_by_member_id: 'member-1',
      split_member_ids: ['member-1'], split_mode: 'PER_CAPITA',
      expected_roster: { currency: 'INR', members: [] } },
    precondition: {}, queuedAt: 1, attemptCount: 0, nextRetryAt: null,
    canonicalResourceId: null, acknowledgedResponse: null,
  }]);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-conversion-review' })).toBeTruthy();
  expect(renderer.root.findByProps({ testID: 'pending-conversion-refresh' }).props.variant)
    .toBe('secondary');
  expect(mockCaptureExpense).not.toHaveBeenCalled();
  await act(async () => {
    renderer.root.findByProps({ testID: 'pending-conversion-approve' }).props.onPress();
  });
  expect(mockToastShow.mock.calls).toEqual([]);
  expect(mockCaptureExpense).toHaveBeenCalledTimes(1);
  expect(mockCaptureExpense.mock.calls[0][0]).toMatchObject({
    clientMutationId: 'uuid-1', state: 'queued', payload: { client_mutation_id: 'uuid-1', original_amount: '-50',
      conversion: { quote_id: 'quote-1', approved: true } },
  });
  expect(mockCaptureExpense.mock.calls[0][1]).toBe('uuid-1');
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
});

it('explains an unavailable conversion rate while retaining the pending expense', async () => {
  mockListOutbox.mockResolvedValue([{
    clientMutationId: 'uuid-1', accountId: 'account-1', tripId: 'trip-1',
    operation: 'expense_create', state: 'needs_review',
    lastSafeErrorCode: 'conversion_review_needed',
    reviewContext: { quoteError: 'quote_unavailable' },
    payload: { original_amount: '1', original_currency: 'USD', category: 'Travel',
      date: '27-09-26', paid_by_member_id: 'member-1', split_member_ids: ['member-1'],
      split_mode: 'PER_CAPITA', expected_roster: { currency: 'INR', members: [] } },
  }]);
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<PendingExpenseDetail />); });
  expect(renderer.root.findByProps({ testID: 'pending-conversion-wait' }).props.children)
    .toContain('Conversion rate unavailable');
  expect(renderer.root.findByProps({ testID: 'pending-conversion-refresh' }).props.variant)
    .toBe('primary');
  expect(mockCaptureExpense).not.toHaveBeenCalled();
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
