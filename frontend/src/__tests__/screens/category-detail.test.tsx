/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockToast = jest.fn();

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    Stack: { Screen: (p: any) => R.createElement('StackScreen', p) },
    useLocalSearchParams: () => ({ id: 't1', name: 'Food' }),
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: any) => R.useEffect(() => { cb(); }, []),
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, p, p.children) };
});
jest.mock('../../SpendBarChart', () => {
  const R = require('react');
  return { __esModule: true, default: (p: any) => R.createElement('SpendBarChart', p) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p.children);
  return {
    __esModule: true,
    Screen: stub('Screen'),
    Card: stub('Card'),
    ListRow: (p: any) => R.createElement('ListRow', p),
    EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'),
    useToast: () => ({ show: mockToast }),
  };
});

import CategoryDetail from '../../../app/trip/[id]/category/[name]';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const trip = {
  id: 't1', name: 'Trip', currency: 'INR',
  members: [
    { id: 'a', name: 'Alex', kind: 'individual' },
    { id: 'fam', name: 'Patel', kind: 'family', family_members: ['Ria', 'Dev'] },
  ],
};
const expenses = [
  { id: 'small', amount: 20, category: 'Food', description: 'Tea', date: '01-01-25', paid_by_member_id: 'a' },
  { id: 'large', amount: 100, category: 'Food', description: 'Dinner', date: '02-01-25', paid_by_member_id: 'fam' },
  { id: 'refund', amount: -30, category: 'Food', description: 'Restaurant refund', date: '03-01-25', paid_by_member_id: 'fam' },
  { id: 'travel', amount: 999, category: 'Travel', description: 'Flight', date: '04-01-25', paid_by_member_id: 'a' },
];

const host = (renderer: any, type: string) => renderer.root.findByType(type as any);
const rows = (renderer: any) => renderer.root.findAllByType('ListRow' as any);

async function mount(apiImplementation?: (url: string) => Promise<any>) {
  apiMock.mockImplementation(apiImplementation ?? ((url: string) => {
    if (url === '/trips/t1') return Promise.resolve(trip);
    if (url === '/trips/t1/expenses') return Promise.resolve(expenses);
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  }));
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<CategoryDetail />); });
  return renderer;
}

beforeEach(() => {
  apiMock.mockReset();
  mockPush.mockReset();
  mockToast.mockReset();
});

describe('category detail screen', () => {
  it('shows gross/refund reconciliation and a display-only payer breakdown', async () => {
    const renderer = await mount();
    const chart = host(renderer, 'SpendBarChart');
    expect(chart.props.title).toBe('Who paid');
    expect(chart.props.summary).toMatchObject({ total: 120, count: 2 });
    expect(chart.props.onBarPress).toBeUndefined();

    const family = chart.props.summary.entities.find((row: any) => row.entity_id === 'fam');
    expect(chart.props.rowDetail(family, 120)).toBe('83% · 1 transaction');

    expect(host(renderer, 'AmountText').props.value).toBe(90);
    expect(rows(renderer).map((row: any) => row.props.right.props.value)).toEqual([100, 20, -30]);
    expect(host(renderer, 'StackScreen').props.options.title).toBe('Food');
  });

  it('orders spends by amount before refunds and keeps expense navigation', async () => {
    const renderer = await mount();
    expect(rows(renderer).map((row: any) => row.props.testID)).toEqual([
      'category-transaction-large',
      'category-transaction-small',
      'category-transaction-refund',
    ]);
    expect(rows(renderer)[2].props.meta).toBe('Refund');

    act(() => { rows(renderer)[0].props.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/trip/[id]/edit-expense',
      params: { id: 't1', eid: 'large' },
    });
  });

  it('renders a retryable error instead of misleading zero totals', async () => {
    const renderer = await mount(() => Promise.reject(new Error('Offline')));
    const error = host(renderer, 'EmptyState');
    expect(error.props.testID).toBe('category-load-error');
    expect(error.props.body).toBe('Offline');
    expect(mockToast).toHaveBeenCalledWith('Offline', 'error');
    expect(renderer.root.findAllByType('SpendBarChart' as any)).toHaveLength(0);
  });

  it('renders the category empty state when no matching transactions exist', async () => {
    const renderer = await mount((url: string) => (
      url === '/trips/t1' ? Promise.resolve(trip) : Promise.resolve([])
    ));
    expect(host(renderer, 'EmptyState').props.testID).toBe('category-empty');
  });
});
