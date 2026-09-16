/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockGetImpact = jest.fn();
const mockLeaveMembership = jest.fn();
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockToast = jest.fn();

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ replace: mockReplace, push: mockPush }),
    useFocusEffect: (callback: () => void) => R.useEffect(callback, [callback]),
  };
});
jest.mock('../api', () => ({
  getMembershipLeaveImpact: (...args: any[]) => mockGetImpact(...args),
  leaveTripMembership: (...args: any[]) => mockLeaveMembership(...args),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#176b55', danger: '#b42318', warning: '#b26a00', success: '#18794e',
      textMuted: '#66736e',
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
    Button: stub('Button'), Card: stub('Card'), Icon: stub('Icon'),
    SkeletonBox: stub('SkeletonBox'), useToast: () => ({ show: mockToast }),
  };
});

import MembershipCard from '../MembershipCard';


function impact(overrides: Record<string, unknown> = {}) {
  return {
    trip_id: 'trip-1', trip_name: 'Coast', currency: 'INR',
    identity: {
      type: 'individual', member_id: 'member-1', member_name: 'Ada',
      family_id: null, family_name: null, family_member_id: null,
    },
    position: '0.000000000000', family_position: null,
    unsettled_family_members: [], settled: true,
    leave_eligible: true, dissolve_family_eligible: false,
    requires_family_dissolution: false, available_actions: ['keep', 'leave'],
    default_action: 'keep', active_payment_blocker: false,
    ownership: {
      is_owner: false, transfer_required: false, successor: null,
      requires_trip_deletion: false,
    },
    blockers: [],
    ...overrides,
  };
}


async function mount(value = impact()) {
  mockGetImpact.mockResolvedValue(value);
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<MembershipCard tripId="trip-1" />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}


beforeEach(() => {
  jest.clearAllMocks();
  mockLeaveMembership.mockResolvedValue({ ok: true });
});


it('shows identity and exact position, confirms departure, then returns to Trips', async () => {
  const renderer = await mount();
  expect(renderer.root.findByProps({ testID: 'membership-position' }).props.children)
    .toBe('INR 0');

  act(() => renderer.root.findByProps({ testID: 'membership-leave' }).props.onPress());
  let modal = renderer.root.findByType('ConfirmModal' as any);
  expect(modal.props.visible).toBe(true);
  expect(modal.props.title).toBe('Leave this trip?');

  await act(async () => {
    modal.props.actions.find((action: any) => (
      action.testID === 'membership-leave-confirm-action'
    )).onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockLeaveMembership).toHaveBeenCalledWith('trip-1', false);
  expect(mockReplace).toHaveBeenCalledWith('/(tabs)/trips');
});


it('offers explicit family dissolution for the sole linked person', async () => {
  const renderer = await mount(impact({
    identity: {
      type: 'family_member', member_id: 'family-1', member_name: 'Ada',
      family_id: 'family-1', family_name: 'Shah family', family_member_id: 'person-1',
    },
    family_position: '0', leave_eligible: false, dissolve_family_eligible: true,
    requires_family_dissolution: true, available_actions: ['keep', 'dissolve_family'],
  }));

  act(() => renderer.root.findByProps({ testID: 'membership-dissolve-family' }).props.onPress());
  const modal = renderer.root.findByType('ConfirmModal' as any);
  expect(modal.props.title).toBe('Dissolve this family and leave?');
  await act(async () => {
    modal.props.actions[1].onPress();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(mockLeaveMembership).toHaveBeenCalledWith('trip-1', true);
});


it('routes an active-payment blocker to resolution instead of showing leave', async () => {
  const renderer = await mount(impact({
    settled: false, leave_eligible: false, available_actions: ['keep'],
    active_payment_blocker: true,
    blockers: [{
      code: 'active_payment_attempt', message: 'Resolve payment first.',
      resolution: 'resolve_payment', actions: ['leave', 'dissolve_family'],
    }],
  }));

  expect(renderer.root.findAllByProps({ testID: 'membership-leave' })).toHaveLength(0);
  act(() => renderer.root.findByProps({ testID: 'membership-resolve_payment' }).props.onPress());
  expect(mockPush).toHaveBeenCalledWith('/trip/trip-1/settle-up');
});
