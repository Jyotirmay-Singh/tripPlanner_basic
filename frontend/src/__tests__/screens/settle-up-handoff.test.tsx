/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockApi = jest.fn();
const mockListPayments = jest.fn();
const mockListAttempts = jest.fn();
const mockUpdateAttemptRecipient = jest.fn();
const mockListPendingPayments = jest.fn();
const mockMakePaymentOutboxItem = jest.fn();
const mockCapturePayment = jest.fn();
let mockCaptureEnabled = false;
let mockSessionMode: 'online' | 'offline' = 'online';
let mockReviewId: string | undefined;
let mockUser = { id: 'payer-user', is_super_admin: false };

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'trip-1', reviewId: mockReviewId }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useFocusEffect: (callback: () => void) => {
    const R = require('react');
    R.useEffect(callback, [callback]);
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 30, left: 0 }),
}));

jest.mock('../../api', () => ({
  api: (...args: unknown[]) => mockApi(...args),
  listPayments: (...args: unknown[]) => mockListPayments(...args),
  listPaymentAttempts: (...args: unknown[]) => mockListAttempts(...args),
  updatePaymentAttemptRecipient: (...args: unknown[]) => mockUpdateAttemptRecipient(...args),
  recordPayment: jest.fn(),
  editPayment: jest.fn(),
  deletePayment: jest.fn(),
}));

jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: mockUser, sessionMode: mockSessionMode }) }));
jest.mock('../../offlineStore', () => ({ offlineStore: {
  getPaymentProtocolVersion: jest.fn(async () => 1),
} }));
jest.mock('../../offlinePayments', () => ({
  paymentCaptureActive: () => mockCaptureEnabled,
  listPendingPayments: (...args: unknown[]) => mockListPendingPayments(...args),
  makePaymentOutboxItem: (...args: unknown[]) => mockMakePaymentOutboxItem(...args),
  capturePayment: (...args: unknown[]) => mockCapturePayment(...args),
}));
jest.mock('../../syncWorker', () => ({ syncCoordinator: { subscribe: () => () => {} } }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ConfirmModal', () => ({
  __esModule: true,
  default: (props: any) => require('react').createElement('ConfirmModal', props),
}));
jest.mock('../../UpiPaymentSheet', () => ({
  __esModule: true,
  default: (props: any) => require('react').createElement('UpiPaymentSheet', props),
}));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    Screen: stub('Screen'),
    Card: stub('Card'),
    Button: stub('Button'),
    Icon: stub('Icon'),
    IconButton: stub('IconButton'),
    Input: stub('Input'),
    EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'),
    useToast: () => ({ show: jest.fn() }),
  };
});

import SettleUp from '../../../app/trip/[id]/settle-up';

const members = [
  { id: 'payer', name: 'Payer Person', kind: 'individual', user_id: 'payer-user' },
  { id: 'recipient', name: 'Recipient Person', kind: 'individual', user_id: 'recipient-user' },
  { id: 'admin-member', name: 'Admin Person', kind: 'individual', user_id: 'admin-user' },
];
const balance = {
  currency: 'INR',
  members,
  transfers: [{ from_member_id: 'payer', to_member_id: 'recipient', amount: 50 }],
};
const trip = {
  id: 'trip-1',
  name: 'Goa Weekend',
  currency: 'INR',
  owner_id: 'owner-user',
  admin_ids: ['owner-user', 'admin-user'],
  user_ids: ['owner-user', 'admin-user', 'payer-user', 'recipient-user'],
  members,
};

async function mountAs(
  user: typeof mockUser,
  options: { attempts?: any[]; payments?: any[]; attemptsError?: boolean } = {},
) {
  mockUser = user;
  mockListPayments.mockResolvedValue(options.payments ?? []);
  mockListAttempts.mockImplementation(() => options.attemptsError
    ? Promise.reject(new Error('offline')) : Promise.resolve(options.attempts ?? []));
  mockApi.mockImplementation((path: string) => (
    path.endsWith('/balances') ? Promise.resolve(balance)
      : path.endsWith('/expenses') ? Promise.resolve([])
        : path.endsWith('/spend-summary') ? Promise.resolve({ total: 0, count: 0, entities: [] })
          : path.endsWith('/payments') ? Promise.resolve(options.payments ?? [])
            : Promise.resolve(trip)
  ));
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<SettleUp />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

const hosts = (renderer: any, testID: string) => (
  renderer.root.findAll(
    (item: any) => typeof item.type === 'string' && item.props?.testID === testID,
  )
);
const interactive = (renderer: any, testID: string) => (
  renderer.root.find((item: any) => item.props?.testID === testID && typeof item.props.onPress === 'function')
);

beforeEach(() => {
  jest.clearAllMocks();
  mockCaptureEnabled = false;
  mockSessionMode = 'online';
  mockReviewId = undefined;
  mockListPendingPayments.mockResolvedValue([]);
  mockCapturePayment.mockResolvedValue(undefined);
});

const attempt = (overrides: Record<string, unknown> = {}) => ({
  id: 'attempt-1',
  quote_id: 'quote-1',
  trip_id: 'trip-1',
  from_member_id: 'payer',
  to_member_id: 'recipient',
  initiating_payer_user_id: 'payer-user',
  selected_recipient_person_id: 'recipient',
  selected_recipient_user_id: 'recipient-user',
  from_name_snapshot: 'Payer Person',
  to_name_snapshot: 'Recipient Person',
  selected_recipient_name_snapshot: 'Recipient Person',
  source_amount: '50.00',
  source_currency: 'INR',
  amount_paise: 5000,
  inr_amount: '50.00',
  currency: 'INR',
  posted_amount: null,
  posted_currency: 'INR',
  transaction_reference: null,
  status: 'initiated',
  reason: null,
  initiated_at: '2026-09-11T10:00:00+00:00',
  updated_at: '2026-09-11T10:00:00+00:00',
  expires_at: '2026-09-12T10:00:00+00:00',
  ...overrides,
});

it('shows Pay via UPI only to the linked payer and opens the focused handoff sheet', async () => {
  const renderer = await mountAs({ id: 'payer-user', is_super_admin: false });

  expect(hosts(renderer, 'upi-pay-0')).toHaveLength(1);
  expect(hosts(renderer, 'record-payment-0')).toHaveLength(0);
  await act(async () => { interactive(renderer, 'upi-pay-0').props.onPress(); });
  expect(renderer.root.findAllByType('UpiPaymentSheet')).toHaveLength(1);
});

it('shows saved manual-payment history without UPI details or money actions offline', async () => {
  const reads = require('../../offlineReads');
  const payment = { id: 'payment-1', from_member_id: 'payer', to_member_id: 'recipient',
    amount: 50, created_at: '2026-09-11T10:00:00+00:00', note: 'Cash' };
  const loader = jest.spyOn(reads, 'loadTripReadBundle').mockResolvedValue({
    data: { trip, expenses: [], balances: balance,
      spend: { total: 0, count: 0, entities: [] }, payments: [payment] },
    source: 'cache', fetchedAt: 1_700_000_000_000,
  });
  try {
    const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false },
      { attemptsError: true });
    expect(hosts(renderer, 'payment-history-payment-1')).toHaveLength(1);
    expect(hosts(renderer, 'record-payment-0')).toHaveLength(0);
    expect(hosts(renderer, 'payment-edit-payment-1')).toHaveLength(0);
    expect(hosts(renderer, 'upi-pay-0')).toHaveLength(0);
    expect(hosts(renderer, 'upi-attempts-unavailable')).toHaveLength(1);
  } finally {
    loader.mockRestore();
  }
});

it('queues a partial manual record from a cached pair and keeps confirmed balances unchanged', async () => {
  mockCaptureEnabled = true;
  mockSessionMode = 'offline';
  const reads = require('../../offlineReads');
  const loader = jest.spyOn(reads, 'loadTripReadBundle').mockResolvedValue({
    data: { trip, expenses: [], balances: balance,
      spend: { total: 0, count: 0, entities: [] }, payments: [] },
    source: 'cache', fetchedAt: 1_700_000_000_000,
  });
  const queued = { clientMutationId: 'queued-id', accountId: 'recipient-user', tripId: 'trip-1',
    operation: 'manual_payment_create', state: 'queued', queuedAt: 1_700_000_000_001,
    payload: { from_member_id: 'payer', to_member_id: 'recipient', amount: 20,
      expected_payable: 50, expected_currency: 'INR' },
    lastSafeErrorCode: null, canonicalResourceId: null };
  mockMakePaymentOutboxItem.mockReturnValue(queued);
  mockListPendingPayments.mockResolvedValueOnce([]).mockResolvedValue([queued]);
  try {
    const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false });
    expect(hosts(renderer, 'record-payment-0')).toHaveLength(1);
    expect(hosts(renderer, 'upi-pay-0')).toHaveLength(0);
    await act(async () => { interactive(renderer, 'record-payment-0').props.onPress(); });
    const amountModal = renderer.root.find((item: any) =>
      typeof item.type === 'function' && item.type.name === 'AmountModal');
    await act(async () => { amountModal.props.onSubmit(20, 'Cash'); });
    const confirm = renderer.root.findByType('ConfirmModal');
    expect(confirm.props.message).toContain('already paid');
    await act(async () => {
      confirm.props.actions[1].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockMakePaymentOutboxItem).toHaveBeenCalledWith('recipient-user', trip, balance,
      balance.transfers[0], 20, 'Cash', 1_700_000_000_000,
      undefined, undefined, false);
    expect(mockCapturePayment).toHaveBeenCalledWith(queued, undefined);
    expect(hosts(renderer, 'payment-pending-queued-id')).toHaveLength(1);
    expect(hosts(renderer, 'payment-history-queued-id')).toHaveLength(0);
    expect(hosts(renderer, 'payable-0')).toHaveLength(1);
  } finally {
    loader.mockRestore();
  }
});

it('does not offer cached recording to the payer when payment capture is enabled', async () => {
  mockCaptureEnabled = true;
  mockSessionMode = 'offline';
  const reads = require('../../offlineReads');
  const loader = jest.spyOn(reads, 'loadTripReadBundle').mockResolvedValue({
    data: { trip, expenses: [], balances: balance,
      spend: { total: 0, count: 0, entities: [] }, payments: [] },
    source: 'cache', fetchedAt: 1_700_000_000_000,
  });
  try {
    const renderer = await mountAs({ id: 'payer-user', is_super_admin: false });
    expect(hosts(renderer, 'record-payment-0')).toHaveLength(0);
    expect(hosts(renderer, 'upi-pay-0')).toHaveLength(0);
  } finally { loader.mockRestore(); }
});

it('does not fall back to an immediate record if the queued payment protocol is unavailable', async () => {
  mockCaptureEnabled = true;
  const store = require('../../offlineStore').offlineStore;
  store.getPaymentProtocolVersion.mockResolvedValueOnce(0);
  const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false });
  expect(hosts(renderer, 'record-payment-0')).toHaveLength(0);
});

it('restores the payment form after a failed local save and preserves the selected facts', async () => {
  mockCaptureEnabled = true;
  const queued = { clientMutationId: 'queued-id', accountId: 'recipient-user', tripId: 'trip-1',
    operation: 'manual_payment_create', state: 'queued', payload: { amount: 20 } };
  mockMakePaymentOutboxItem.mockReturnValue(queued);
  mockCapturePayment.mockRejectedValueOnce(new Error('disk full'));
  const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false });
  await act(async () => { interactive(renderer, 'record-payment-0').props.onPress(); });
  const amountModal = renderer.root.find((entry: any) =>
    typeof entry.type === 'function' && entry.type.name === 'AmountModal');
  await act(async () => { amountModal.props.onSubmit(20, 'Cash'); });
  const confirm = renderer.root.findByType('ConfirmModal');
  await act(async () => { confirm.props.actions[1].onPress(); await Promise.resolve(); });
  const restored = renderer.root.find((entry: any) =>
    typeof entry.type === 'function' && entry.type.name === 'AmountModal');
  expect(restored.props.initial).toBe(20);
  expect(restored.props.max).toBe(50);
  expect(restored.props.initialNote).toBe('Cash');
  expect(mockMakePaymentOutboxItem).toHaveBeenCalledTimes(1);
  await act(async () => { restored.props.onSubmit(20, 'Cash'); });
  expect(mockMakePaymentOutboxItem.mock.calls[1][7]).toBe('queued-id');
});

it('uses an explicit new record when replacing a rejected pending payment', async () => {
  mockCaptureEnabled = true;
  mockReviewId = 'old-id';
  const old = { clientMutationId: 'old-id', accountId: 'recipient-user', tripId: 'trip-1',
    operation: 'manual_payment_create', state: 'needs_review',
    lastSafeErrorCode: 'payment_recommendation_changed', queuedAt: 1_700_000_000_000,
    payload: { from_member_id: 'payer', to_member_id: 'recipient', amount: 20,
      note: 'Cash', expected_payable: 50, expected_currency: 'INR' } };
  const next = { ...old, clientMutationId: 'new-id', state: 'queued' };
  mockListPendingPayments.mockResolvedValue([old]);
  mockMakePaymentOutboxItem.mockReturnValue(next);
  const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false });
  await act(async () => { interactive(renderer, 'record-payment-0').props.onPress(); });
  const amountModal = renderer.root.find((entry: any) =>
    typeof entry.type === 'function' && entry.type.name === 'AmountModal');
  expect(amountModal.props.initial).toBe(20);
  expect(amountModal.props.initialNote).toBe('Cash');
  await act(async () => { amountModal.props.onSubmit(20, 'Cash'); });
  const confirm = renderer.root.findByType('ConfirmModal');
  expect(confirm.props.message).toContain('to Recipient Person');
  await act(async () => { confirm.props.actions[1].onPress(); await Promise.resolve(); });
  expect(mockCapturePayment).toHaveBeenCalledWith(next, 'old-id');
});

it('renames the receiver action to Record payment and hides payer handoff', async () => {
  const renderer = await mountAs({ id: 'recipient-user', is_super_admin: false });

  expect(hosts(renderer, 'upi-pay-0')).toHaveLength(0);
  expect(hosts(renderer, 'record-payment-0')).toHaveLength(1);
  const labels = renderer.root.findAllByType('Button').map((item: any) => item.props.label);
  expect(labels).toContain('Record payment');
  expect(labels).not.toContain('Settle up');
});

it('lets an unrelated admin record but not initiate the payer handoff', async () => {
  const renderer = await mountAs({ id: 'admin-user', is_super_admin: false });

  expect(hosts(renderer, 'upi-pay-0')).toHaveLength(0);
  expect(hosts(renderer, 'record-payment-0')).toHaveLength(1);
});

it('disables duplicate UPI handoff and resurfaces the initiating payer decision', async () => {
  const renderer = await mountAs(
    { id: 'payer-user', is_super_admin: false },
    { attempts: [attempt()] },
  );

  expect(hosts(renderer, 'upi-pay-0')[0].props.disabled).toBe(true);
  expect(hosts(renderer, 'payment-attempt-resume-attempt-1')).toHaveLength(1);
  await act(async () => {
    interactive(renderer, 'payment-attempt-resume-attempt-1').props.onPress();
  });
  const sheet = renderer.root.findByType('UpiPaymentSheet');
  expect(sheet.props.initialAttempt.id).toBe('attempt-1');
});

it('shows recipient confirmation and non-receipt actions', async () => {
  const awaiting = attempt({ status: 'awaiting_confirmation' });
  mockUpdateAttemptRecipient.mockResolvedValue({
    ...awaiting, status: 'needs_review', reason: 'recipient_reported_not_received',
  });
  const renderer = await mountAs(
    { id: 'recipient-user', is_super_admin: false },
    { attempts: [awaiting] },
  );

  expect(hosts(renderer, 'payment-attempt-confirm-attempt-1')).toHaveLength(1);
  expect(hosts(renderer, 'payment-attempt-not-received-attempt-1')).toHaveLength(1);
  await act(async () => {
    interactive(renderer, 'payment-attempt-not-received-attempt-1').props.onPress();
    await Promise.resolve();
  });
  expect(mockUpdateAttemptRecipient).toHaveBeenCalledWith(
    'trip-1', 'attempt-1', 'report_not_received',
  );
});

it('shows retry and close actions when a recipient-confirmed payment needs review', async () => {
  const needsReview = attempt({
    status: 'needs_review', reason: 'recipient_reported_not_received',
  });
  mockUpdateAttemptRecipient.mockResolvedValue({ ...needsReview, status: 'closed' });
  const renderer = await mountAs(
    { id: 'recipient-user', is_super_admin: false },
    { attempts: [needsReview] },
  );

  expect(hosts(renderer, 'payment-attempt-retry-attempt-1')).toHaveLength(1);
  expect(hosts(renderer, 'payment-attempt-close-attempt-1')).toHaveLength(1);
  await act(async () => {
    interactive(renderer, 'payment-attempt-close-attempt-1').props.onPress();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(mockUpdateAttemptRecipient).toHaveBeenCalledWith(
    'trip-1', 'attempt-1', 'close_review',
  );
});

it('keeps the original capped posting visible as the amount at confirmation', async () => {
  const renderer = await mountAs(
    { id: 'payer-user', is_super_admin: false },
    {
      attempts: [attempt({
        status: 'settled_recipient_confirmed',
        posted_amount: 25,
        reason: 'recipient_confirmed',
      })],
    },
  );

  const labels = renderer.root.findAllByType('T').map((item: any) => item.props.children);
  expect(labels).toContain('Posted at confirmation');
  expect(hosts(renderer, 'payment-attempt-capped-attempt-1')).toHaveLength(1);
});

it('labels confirmed ledger rows and opens a remark-only editor while retaining delete', async () => {
  const renderer = await mountAs(
    { id: 'recipient-user', is_super_admin: false },
    {
      payments: [{
        id: 'payment-1', from_member_id: 'payer', to_member_id: 'recipient', amount: 50,
        currency: 'INR', created_at: '2026-09-11T10:00:00+00:00',
        source: 'upi_recipient_confirmed', payment_attempt_id: 'attempt-1',
      }],
    },
  );
  const labels = renderer.root.findAllByType('T').map((item: any) => item.props.children);
  expect(labels).toContain('UPI — recipient confirmed');
  expect(hosts(renderer, 'payment-edit-payment-1')).toHaveLength(1);
  expect(hosts(renderer, 'payment-delete-btn-payment-1')).toHaveLength(1);
  act(() => { interactive(renderer, 'payment-edit-payment-1').props.onPress(); });
  expect(hosts(renderer, 'payment-locked-amount')).toHaveLength(1);
  expect(hosts(renderer, 'payment-amount-input')).toHaveLength(0);
  expect(hosts(renderer, 'payment-remark-continue')).toHaveLength(1);
});
