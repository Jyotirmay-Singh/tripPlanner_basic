/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockApi = jest.fn();
const mockListPayments = jest.fn();
const mockListAttempts = jest.fn();
const mockUpdateAttemptRecipient = jest.fn();
let mockUser = { id: 'payer-user', is_super_admin: false };

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'trip-1' }),
  useFocusEffect: (callback: () => void) => {
    const R = require('react');
    R.useEffect(callback, [callback]);
  },
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

jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
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
  options: { attempts?: any[]; payments?: any[] } = {},
) {
  mockUser = user;
  mockListPayments.mockResolvedValue(options.payments ?? []);
  mockListAttempts.mockResolvedValue(options.attempts ?? []);
  mockApi.mockImplementation((path: string) => (
    path.endsWith('/balances') ? Promise.resolve(balance) : Promise.resolve(trip)
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

it('labels confirmed ledger rows without removing edit and delete controls', async () => {
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
});
