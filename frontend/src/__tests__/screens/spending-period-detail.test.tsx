/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

const mockPush = jest.fn();
const mockLoad = jest.fn();
let mockParams: { id: string; period: string; key: string; scope: string };
let mockSessionMode = 'online';

jest.mock('expo-router', () => {
  const R = require('react');
  return {
    Stack: { Screen: (props: any) => R.createElement('StackScreen', props) },
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (callback: any) => R.useEffect(() => { callback(); }, []),
  };
});
jest.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, sessionMode: mockSessionMode }),
}));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ mode: 'light', colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../../offlineReads', () => ({
  loadTripReadBundle: (...args: any[]) => mockLoad(...args),
}));
jest.mock('../../OfflineReadStatus', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('OfflineReadStatus', props) };
});
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Screen: host('Screen'), Card: host('Card'), ListRow: host('ListRow'),
    EmptyState: host('EmptyState'), AmountText: host('AmountText'), SkeletonCard: host('SkeletonCard'),
  };
});

import SpendingPeriodDetail from '../../../app/trip/[id]/spending/[period]/[key]';

const trip = {
  id: 't1', name: 'Trip', currency: 'INR',
  members: [
    { id: 'other', name: 'Alex', kind: 'individual', user_id: 'u2' },
    { id: 'family', name: 'Patel', kind: 'family', family_members: ['Ria', 'Dev'], family_member_user_ids: ['u1', null] },
  ],
};
const expenses = [
  { id: 'other-spend', date: '08-09-26', time: '09:00', amount: 8000, category: 'Travel', description: 'Train', paid_by_member_id: 'other' },
  { id: 'family-spend', date: '08-09-26', time: '12:00', amount: 2000, category: 'Food', description: 'Lunch', paid_by_member_id: 'family' },
  { id: 'family-refund', date: '08-09-26', time: '14:00', amount: -500, category: 'Food', description: 'Lunch refund', paid_by_member_id: 'family' },
  { id: 'older', date: '07-09-26', amount: 100, category: 'Food', paid_by_member_id: 'family' },
];

function byTestID(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.find((node) => node.props.testID === testID);
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<SpendingPeriodDetail />); });
  return renderer;
}

beforeEach(() => {
  mockPush.mockReset();
  mockLoad.mockReset();
  mockParams = { id: 't1', period: 'daily', key: '2026-09-08', scope: 'trip' };
  mockSessionMode = 'online';
  mockLoad.mockResolvedValue({
    data: { trip, expenses, expensesComplete: true, balances: {}, spend: {}, payments: [] },
    source: 'live', fetchedAt: Date.now(),
  });
});

describe('spending period detail', () => {
  it('shows every expense and refund behind the trip bar with the matching net total', async () => {
    const renderer = await mount();
    const rows = renderer.root.findAll((node) => node.type === 'ListRow');
    expect(rows.map((row) => row.props.testID)).toEqual([
      'spending-period-transaction-family-refund',
      'spending-period-transaction-family-spend',
      'spending-period-transaction-other-spend',
    ]);
    expect(rows[0].props.meta).toBe('Refund');
    const summary = byTestID(renderer.root, 'spending-period-summary');
    expect(summary.findAll((node) => node.type === 'AmountText')[0].props.value).toBe(9500);
    expect(summary.findAll((node) => node.props.children === 'Paid')).not.toHaveLength(0);
    expect(summary.findAll((node) => node.props.children === 'Refunded')).not.toHaveLength(0);
  });

  it('shows only transactions paid by the signed-in family and opens an expense', async () => {
    mockParams.scope = 'personal';
    const renderer = await mount();
    const rows = renderer.root.findAll((node) => node.type === 'ListRow');
    expect(rows.map((row) => row.props.testID)).toEqual([
      'spending-period-transaction-family-refund',
      'spending-period-transaction-family-spend',
    ]);
    const summary = byTestID(renderer.root, 'spending-period-summary');
    expect(summary.findAll((node) => node.type === 'AmountText')[0].props.value).toBe(1500);
    expect(summary.findAll((node) => node.props.children === 'Your family paid')).not.toHaveLength(0);
    act(() => { rows[0].props.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/trip/[id]/edit-expense', params: { id: 't1', eid: 'family-refund' },
    });
  });

  it('keeps saved transactions readable offline and disables the online expense screen', async () => {
    mockSessionMode = 'offline';
    mockLoad.mockResolvedValue({
      data: { trip, expenses, expensesComplete: true, balances: {}, spend: {}, payments: [] },
      source: 'cache', fetchedAt: Date.now(),
    });
    const renderer = await mount();
    expect(mockLoad).toHaveBeenCalledWith('u1', 't1', true);
    expect(renderer.root.findAll((node) => node.type === 'OfflineReadStatus')).toHaveLength(1);
    const row = byTestID(renderer.root, 'spending-period-transaction-family-spend');
    expect(row.props.onPress).toBeUndefined();
  });

  it('rejects an invalid bucket before loading trip data', async () => {
    mockParams.key = '2026-09-09';
    mockParams.period = 'weekly';
    const renderer = await mount();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(byTestID(renderer.root, 'spending-period-invalid')).toBeTruthy();
  });
});
