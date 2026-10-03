/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockToast = jest.fn();
let mockParams = { id: 't1', name: 'Food' };
let mockAccount = 'u1';
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: mockAccount } }) }));

jest.mock('../../api', () => ({ api: jest.fn(), readExpenses: jest.fn(async (id: string) => ({ items: await require('../../api').api(`/trips/${id}/expenses`), complete: true })) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    Stack: { Screen: (p: any) => R.createElement('StackScreen', p) },
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (cb: any) => R.useEffect(cb, [cb]),
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
import { api, readExpenses } from '../../api';

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
  mockParams = { id: 't1', name: 'Food' }; mockAccount = 'u1';
  apiMock.mockReset();
  mockPush.mockReset();
  mockToast.mockReset();
});

describe('category detail screen', () => {
  it('shows gross/refund reconciliation and a display-only payer breakdown', async () => {
    const renderer = await mount();
    const chart = host(renderer, 'SpendBarChart');
    expect(chart.props.title).toBe('Paid by');
    expect(chart.props.summaryText).toBe('2 payers');
    expect(chart.props.summary).toMatchObject({ total: 120, count: 2 });
    expect(chart.props.onBarPress).toBeUndefined();

    const family = chart.props.summary.entities.find((row: any) => row.entity_id === 'fam');
    expect(chart.props.rowDetail(family, 120)).toBe('83% of payments · 1 transaction');

    expect(host(renderer, 'AmountText').props).toMatchObject({
      value: 90,
      style: { marginTop: 4, textAlign: 'left' },
    });
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

import { groupA, groupB, deferred } from '../fixtures/fixedCategoryGroups';
const detailRefresh = (r: any) => host(r, 'Screen').props.onRefresh();
function detailApi(url: string) {
  const id = url.split('/')[2];
  if (url.endsWith('/expenses')) return Promise.resolve(id === 't1' ? groupA : groupB);
  return Promise.resolve({ ...trip, id, members: [{ id: 'm1', name: `Payer ${id}` }] });
}
it('immediately hides A, resolves B first, and keeps B transaction IDs, totals and navigation', async () => {
  const pendingA = deferred(); const pendingB = deferred();
  const reader = readExpenses as jest.Mock;
  reader.mockResolvedValueOnce({ items: groupA, complete: true }).mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);
  const renderer = await mount(detailApi);
  expect(rows(renderer).map((r: any) => r.props.testID)).toEqual(['category-transaction-a-food']);
  expect(host(renderer, 'AmountText').props.value).toBe(1000);
  act(() => { void detailRefresh(renderer); });
  act(() => { mockParams = { id: 't2', name: 'Shipping & Delivery' }; renderer.update(<CategoryDetail />); });
  expect(rows(renderer)).toHaveLength(0); expect(renderer.root.findAllByType('AmountText' as any)).toHaveLength(0);
  await act(async () => pendingB.resolve({ items: groupB, complete: true }));
  expect(rows(renderer).map((r: any) => r.props.testID)).toEqual(['category-transaction-b-shipping']);
  expect(host(renderer, 'AmountText').props.value).toBe(30);
  await act(async () => pendingA.resolve({ items: groupA, complete: true }));
  expect(rows(renderer).map((r: any) => r.props.testID)).toEqual(['category-transaction-b-shipping']);
  act(() => rows(renderer)[0].props.onPress());
  expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/trip/[id]/edit-expense', params: { id: 't2', eid: 'b-shipping' } });
  act(() => renderer.unmount());
});
it.each(['success', 'error'])('ignores superseded detail refresh %s, toast and loading completion', async (outcome) => {
  const earlier = deferred(); const later = deferred();
  (readExpenses as jest.Mock).mockResolvedValueOnce({ items: groupA, complete: true }).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
  const renderer = await mount(detailApi);
  act(() => { void detailRefresh(renderer); void detailRefresh(renderer); });
  await act(async () => { if (outcome === 'error') earlier.reject(new Error('stale error')); else earlier.resolve({ items: [], complete: false }); });
  expect(host(renderer, 'Screen').props.refreshing).toBe(true);
  expect(rows(renderer).map((r: any) => r.props.testID)).toEqual(['category-transaction-a-food']);
  await act(async () => later.resolve({ items: groupA, complete: true }));
  expect(host(renderer, 'Screen').props.refreshing).toBe(false);
  expect(mockToast).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
it('isolates accounts, labels incomplete detail and ignores a rejected request after unmount', async () => {
  const next = deferred(); const closing = deferred();
  (readExpenses as jest.Mock).mockResolvedValueOnce({ items: groupA, complete: true }).mockReturnValueOnce(next.promise).mockReturnValueOnce(closing.promise);
  const renderer = await mount(detailApi);
  act(() => { mockAccount = 'u2'; renderer.update(<CategoryDetail />); });
  expect(rows(renderer)).toHaveLength(0);
  await act(async () => next.resolve({ items: groupA, complete: false }));
  expect(rows(renderer)).toHaveLength(1);
  expect(renderer.root.findAllByType('SpendBarChart' as any)).toHaveLength(0);
  expect(renderer.root.findAllByType(require('react-native').Text).some((n: any) => n.props.children === 'Category totals need a complete refresh')).toBe(true);
  act(() => { void detailRefresh(renderer); renderer.unmount(); });
  await act(async () => closing.reject(new Error('after unmount')));
  expect(mockToast).not.toHaveBeenCalled();
});

it.each(['trip', 'account'])('does not relabel prior data after a failed %s switch and pending retry', async (scope) => {
  const retry = deferred();
  (readExpenses as jest.Mock).mockResolvedValueOnce({ items: groupA, complete: true })
    .mockRejectedValueOnce(new Error('New scope unavailable')).mockReturnValueOnce(retry.promise);
  const renderer = await mount(detailApi);
  expect(rows(renderer).map((row: any) => row.props.testID)).toEqual(['category-transaction-a-food']);
  await act(async () => {
    if (scope === 'trip') mockParams = { id: 't2', name: 'Food' };
    else mockAccount = 'u2';
    renderer.update(<CategoryDetail />);
  });
  expect(host(renderer, 'EmptyState').props.testID).toBe('category-load-error');
  act(() => { void detailRefresh(renderer); });
  expect(host(renderer, 'Screen').props.refreshing).toBe(true);
  expect(rows(renderer)).toHaveLength(0);
  expect(renderer.root.findAllByType('AmountText' as any)).toHaveLength(0);
  expect(renderer.root.findAllByType('SpendBarChart' as any)).toHaveLength(0);
  await act(async () => retry.resolve({ items: [{ ...groupB[1], category: 'Food' }], complete: true }));
  expect(rows(renderer).map((row: any) => row.props.testID)).toEqual(['category-transaction-b-shipping']);
  expect(host(renderer, 'AmountText').props.value).toBe(30);
  act(() => rows(renderer)[0].props.onPress());
  expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/trip/[id]/edit-expense', params: { id: scope === 'trip' ? 't2' : 't1', eid: 'b-shipping' } });
  act(() => renderer.unmount());
});
