/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockListAdminTrips = jest.fn();
const mockListAdminActivity = jest.fn();
const mockPush = jest.fn();
let mockUser: any = {
  id: 'application-admin',
  email: 'jyotirmaysingh03@gmail.com',
  is_super_admin: true,
};

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (effect: any) => R.useEffect(effect, [effect]),
    useRouter: () => ({ push: mockPush }),
  };
});
jest.mock('../api', () => ({
  listAdminTrips: (...args: any[]) => mockListAdminTrips(...args),
  listAdminActivity: (...args: any[]) => mockListAdminActivity(...args),
}));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#123', primaryText: '#fff', overlayOnPrimary: '#ffffff22',
      surface: '#fff', surfaceMuted: '#eee', border: '#ddd', textMuted: '#666', danger: '#c00',
    },
  }),
}));
jest.mock('../date', () => ({ formatTripDates: () => 'Sep 9–10, 2026' }));
jest.mock('../format', () => ({ formatMoney: (value: number) => String(value) }));
jest.mock('../T', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(RN.Text, props, props.children) };
});
jest.mock('../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props, props.action) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Button: host('Button'),
    Card: host('Card'),
    EmptyState: host('EmptyState'),
    Icon: host('Icon'),
    Input: host('Input'),
    SegmentedControl: host('SegmentedControl'),
    SkeletonCard: host('SkeletonCard'),
    TabScreen: host('TabScreen'),
  };
});

import AdminScreen from '../../app/(tabs)/admin';

const trip = (id: string, name: string) => ({
  id,
  name,
  currency: 'INR',
  created_at: '2026-09-09T10:00:00Z',
  owner: { id: `owner-${id}`, name: 'Owner', email: 'owner@gmail.com' },
  member_count: 2,
  expense_count: 3,
  net_spend: 450,
});

beforeEach(() => {
  mockUser = {
    id: 'application-admin',
    email: 'jyotirmaysingh03@gmail.com',
    is_super_admin: true,
  };
  mockListAdminTrips.mockReset();
  mockListAdminActivity.mockReset();
  mockPush.mockReset();
});

it('loads once, keeps its cursor stable, and appends the next trip page', async () => {
  mockListAdminTrips
    .mockResolvedValueOnce({ items: [trip('t2', 'Second')], total: 2, next_cursor: 'cursor-1' })
    .mockResolvedValueOnce({ items: [trip('t1', 'First')], total: 2, next_cursor: null });
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AdminScreen />);
  });

  expect(mockListAdminTrips).toHaveBeenCalledTimes(1);
  expect(mockListAdminTrips).toHaveBeenLastCalledWith({ query: '', cursor: null });
  await act(async () => {
    await renderer.root.findByProps({ testID: 'admin-load-more' }).props.onPress();
  });

  expect(mockListAdminTrips).toHaveBeenCalledTimes(2);
  expect(mockListAdminTrips).toHaveBeenLastCalledWith({ query: '', cursor: 'cursor-1' });
  expect(renderer.root.findByProps({ testID: 'admin-trip-t2' })).toBeTruthy();
  expect(renderer.root.findByProps({ testID: 'admin-trip-t1' })).toBeTruthy();
  act(() => renderer.unmount());
});

it('switches to the immutable activity view and hides trip search', async () => {
  mockListAdminTrips.mockResolvedValue({ items: [], total: 0, next_cursor: null });
  mockListAdminActivity.mockResolvedValue({
    items: [{
      id: 'audit-1', actor_user_id: 'application-admin',
      actor_email: 'jyotirmaysingh03@gmail.com', action: 'expense.updated',
      trip_id: 't1', trip_name: 'Client trip', resource_type: 'expense',
      resource_id: 'e1', changed_fields: ['amount'], created_at: '2026-09-09T10:00:00Z',
    }],
    total: 1,
    next_cursor: null,
  });
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AdminScreen />);
  });
  await act(async () => {
    renderer.root.findByProps({ testIDPrefix: 'admin-view' }).props.onChange('activity');
  });

  expect(mockListAdminActivity).toHaveBeenCalledTimes(1);
  expect(renderer.root.findAllByProps({ testID: 'admin-trip-search' })).toHaveLength(0);
  expect(renderer.root.findByProps({ testID: 'admin-activity-audit-1' })).toBeTruthy();
  act(() => renderer.unmount());
});

it('denies the route when a non-admin reaches it directly', async () => {
  mockUser = { id: 'member', email: 'member@gmail.com', is_super_admin: false };
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AdminScreen />);
  });

  expect(renderer.root.findByProps({ testID: 'admin-denied' })).toBeTruthy();
  expect(mockListAdminTrips).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
