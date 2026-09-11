/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockApi = jest.fn();
const mockListPayments = jest.fn();
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

async function mountAs(user: typeof mockUser) {
  mockUser = user;
  mockListPayments.mockResolvedValue([]);
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
