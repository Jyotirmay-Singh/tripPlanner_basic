/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockListAdminTrips = jest.fn();
const mockListAdminActivity = jest.fn();
const mockListAdminMoneyAudit = jest.fn();
let mockCurrentUser: any = {
  id: 'admin-1',
  email: 'admin@example.com',
  is_super_admin: true,
};

jest.mock('../../api', () => ({
  listAdminTrips: (...args: any[]) => mockListAdminTrips(...args),
  listAdminActivity: (...args: any[]) => mockListAdminActivity(...args),
  listAdminMoneyAudit: (...args: any[]) => mockListAdminMoneyAudit(...args),
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: mockCurrentUser }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (callback: any) => R.useEffect(callback, [callback]),
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: (props: any) => R.createElement(RN.Text, props, props.children),
  };
});
jest.mock('../../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../../date', () => ({ formatTripDates: () => 'dates' }));
jest.mock('../../ui', () => {
  const R = require('react');
  const component = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Button: component('Button'),
    Card: component('Card'),
    EmptyState: component('EmptyState'),
    Icon: component('Icon'),
    Input: component('Input'),
    SegmentedControl: component('SegmentedControl'),
    SkeletonCard: component('SkeletonCard'),
    TabScreen: component('TabScreen'),
  };
});

import AdminScreen from '../../../app/(tabs)/admin';

function renderedText(renderer: any): string {
  const value = (child: any): string => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return child?.children ? child.children.map(value).join('') : '';
  };
  return renderer.root.findAllByType(Text)
    .map((node: any) => node.children.map(value).join(''))
    .join(' ');
}

beforeEach(() => {
  mockListAdminTrips.mockReset().mockResolvedValue({ items: [], total: 0, next_cursor: null });
  mockListAdminActivity.mockReset().mockResolvedValue({ items: [], total: 0, next_cursor: null });
  mockListAdminMoneyAudit.mockReset().mockResolvedValue({
    items: [{
      id: 'migration-1',
      record_type: 'migration',
      trip_id: 'trip-1',
      trip_name: 'Mountain trip',
      currency: 'INR',
      policy_version: 'whole_unit_v1',
      created_at: '2026-09-13T10:00:00Z',
      changes: [{
        collection: 'expenses',
        document_id: 'expense-1',
        field: 'amount',
        before: '12.50',
        after: 13,
      }],
      adjustment_vector: { payer: 1, receiver: '-1' },
    }],
    total: 1,
    next_cursor: null,
  });
  mockCurrentUser = {
    id: 'admin-1',
    email: 'admin@example.com',
    is_super_admin: true,
  };
});

it('renders normalization evidence and the private whole-unit adjustment vector', async () => {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AdminScreen />);
  });
  const tabs = renderer.root.findByType('SegmentedControl' as any);
  await act(async () => {
    tabs.props.onChange('money');
  });

  expect(mockListAdminMoneyAudit).toHaveBeenCalledWith({ cursor: null });
  expect(renderer.root.findByProps({ testID: 'admin-money-audit-migration-1' })).toBeTruthy();
  const text = renderedText(renderer);
  expect(text).toContain('Money policy audit');
  expect(text).toContain('Mountain trip');
  expect(text).toContain('whole_unit_v1');
  expect(text).toContain('expenses');
  expect(text).toContain('expense-1');
  expect(text).toContain('12.50');
  expect(text).toContain('13');
  expect(text).toContain('Private adjustment vector');
  expect(text).toContain('payer');
  expect(text).toContain('receiver');
  await act(async () => renderer.unmount());
});

it('keeps the money audit unavailable to a non-super-admin user', async () => {
  mockCurrentUser = { id: 'member-1', email: 'member@example.com', is_super_admin: false };
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AdminScreen />);
  });

  expect(renderer.root.findByProps({ testID: 'admin-denied' })).toBeTruthy();
  expect(mockListAdminMoneyAudit).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
