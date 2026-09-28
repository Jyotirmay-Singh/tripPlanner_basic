/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetImpact = jest.fn();
const mockDeleteAccount = jest.fn();
const mockFinalize = jest.fn();
const mockPush = jest.fn();
const mockReset = jest.fn();
const mockToast = jest.fn();

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (callback: () => void) => R.useEffect(callback, [callback]),
  };
});
jest.mock('../api', () => ({
  getAccountDeletionImpact: (...args: any[]) => mockGetImpact(...args),
  deleteAccount: (...args: any[]) => mockDeleteAccount(...args),
}));
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ finalizeAccountDeletion: mockFinalize }),
}));
jest.mock('../authNav', () => ({
  AUTH_LOGIN_HREF: '/(auth)/login',
  navResetTo: (...args: any[]) => mockReset(...args),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      surface: '#fff', surfaceMuted: '#f4f5f4', border: '#d5dad7', primary: '#176b55',
      danger: '#b42318', warning: '#b26a00', success: '#18794e', textMuted: '#66736e',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../Badge', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('Badge', props) };
});
jest.mock('../ConfirmModal', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ConfirmModal', props) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Button: stub('Button'), Card: stub('Card'), Icon: stub('Icon'), Input: stub('Input'),
    Screen: stub('Screen'), SegmentedControl: stub('SegmentedControl'),
    SkeletonCard: stub('SkeletonCard'), useToast: () => ({ show: mockToast }),
  };
});

import DeleteAccountScreen from '../../app/delete-account';


const IMPACT = {
  account_deletion_allowed: true,
  blockers: [],
  defaults: { trip_action: 'keep' },
  privacy: {
    deleted: ['Login credentials and private account details'],
    retained: ['Trip names and financial history'],
  },
  trips: [
    {
      trip_id: 'unsettled', trip_name: 'Goa', currency: 'INR',
      identity: {
        type: 'individual', member_id: 'm1', member_name: 'Ada', family_id: null,
        family_name: null, family_member_id: null,
      },
      position: '-13', family_position: null, unsettled_family_members: [],
      settled: false, leave_eligible: false, dissolve_family_eligible: false,
      requires_family_dissolution: false, available_actions: ['keep'], default_action: 'keep',
      active_payment_blocker: false,
      ownership: {
        is_owner: false, transfer_required: false, successor: null,
        requires_trip_deletion: false,
      },
      blockers: [{
        code: 'membership_unsettled', message: 'Settle first.',
        resolution: 'settle_up', actions: ['leave', 'dissolve_family'],
      }],
    },
    {
      trip_id: 'family', trip_name: 'Colombo', currency: 'LKR',
      identity: {
        type: 'family_member', member_id: 'f1', member_name: 'Ada', family_id: 'f1',
        family_name: 'Shah family', family_member_id: 'p1',
      },
      position: '0', family_position: '0', unsettled_family_members: [], settled: true,
      leave_eligible: true, dissolve_family_eligible: true, requires_family_dissolution: false,
      available_actions: ['keep', 'leave', 'dissolve_family'], default_action: 'keep',
      active_payment_blocker: false,
      ownership: {
        is_owner: true, transfer_required: true,
        successor: { user_id: 'u2', name: 'Bea' }, requires_trip_deletion: false,
      },
      blockers: [],
    },
  ],
};


async function mount(impact: any = IMPACT) {
  mockGetImpact.mockResolvedValue(impact);
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<DeleteAccountScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}


beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteAccount.mockResolvedValue({ ok: true });
  mockFinalize.mockResolvedValue(undefined);
});


it('keeps every trip by default and requires acknowledgement plus uppercase DELETE', async () => {
  const renderer = await mount();
  const review = () => renderer.root.findByProps({ testID: 'delete-account-review-final' });
  expect(review().props.disabled).toBe(true);
  expect(renderer.root.findByProps({ testID: 'deletion-trip-unsettled-position' }).props.children)
    .toBe('INR -13');
  expect(renderer.root.findByProps({ testID: 'deletion-trip-family-ownership' }))
    .toBeDefined();

  act(() => renderer.root.findByProps({ testID: 'delete-account-confirmation' })
    .props.onChangeText('delete'));
  expect(review().props.disabled).toBe(true);
  act(() => renderer.root.findByProps({ testID: 'delete-account-confirmation' })
    .props.onChangeText('DELETE'));
  expect(review().props.disabled).toBe(true);

  const acknowledgement = renderer.root.findByProps({ testID: 'delete-account-unsettled-ack' });
  expect(acknowledgement.props.accessibilityRole).toBe('checkbox');
  act(() => acknowledgement.props.onPress());
  expect(review().props.disabled).toBe(false);

  act(() => renderer.root.findByProps({ testIDPrefix: 'deletion-trip-family-action' })
    .props.onChange('dissolve_family'));
  act(() => review().props.onPress());
  const modal = renderer.root.findByType('ConfirmModal' as any);
  expect(modal.props.visible).toBe(true);

  await act(async () => {
    modal.props.actions[1].onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockDeleteAccount).toHaveBeenCalledWith({
    confirmation: 'DELETE',
    acknowledge_unsettled: true,
    trip_actions: [
      { trip_id: 'unsettled', action: 'keep' },
      { trip_id: 'family', action: 'dissolve_family' },
    ],
  });
  expect(mockFinalize).toHaveBeenCalledTimes(1);
  expect(mockReset).toHaveBeenCalledWith(expect.anything(), '/(auth)/login');
});


it('keeps the destructive action disabled while the server reports a blocker', async () => {
  const renderer = await mount({
    ...IMPACT,
    account_deletion_allowed: false,
    blockers: [{
      code: 'active_payment_attempt', message: 'Resolve payment first.',
      resolution: 'resolve_payment', actions: ['delete_account'],
    }],
  });
  act(() => renderer.root.findByProps({ testID: 'delete-account-confirmation' })
    .props.onChangeText('DELETE'));
  act(() => renderer.root.findByProps({ testID: 'delete-account-unsettled-ack' }).props.onPress());

  expect(renderer.root.findByProps({ testID: 'delete-account-blockers' })).toBeDefined();
  expect(renderer.root.findByProps({ testID: 'delete-account-review-final' }).props.disabled)
    .toBe(true);
});


it('explains an unpayable residual on the trip review card without a settle action', async () => {
  const value = {
    ...IMPACT,
    trips: [{
      ...IMPACT.trips[0], position: '0',
      blockers: [{
        code: 'ledger_reconciliation_required',
        message: 'Ask a trip admin to reconcile the ledger before leaving.',
        resolution: 'none', actions: ['leave', 'dissolve_family'],
      }],
    }],
  };
  const renderer = await mount(value);

  expect(renderer.root.findByProps({ testID: 'deletion-trip-unsettled-position' }).props.children)
    .toBe('INR 0');
  expect(renderer.root.findAllByType('T' as any).some((row: any) =>
    row.props.children === 'Ask a trip admin to reconcile the ledger before leaving.')).toBe(true);
  expect(renderer.root.findAllByProps({ testID: 'deletion-trip-unsettled-settle_up' }))
    .toHaveLength(0);
});
