/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Ada' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'dark' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: mockPush }),
    useFocusEffect: (callback: any) => { R.useEffect(() => { callback(); }, []); },
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});
jest.mock('../../composition', () => ({ compositionLabel: () => '2 individuals' }));
jest.mock('../../date', () => ({ formatTripDates: () => '01/01/2026 – 02/01/2026' }));
jest.mock('../../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../../TripListCard', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TripListCard', props) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props?.children);
  return {
    __esModule: true,
    Screen: stub('Screen'), Card: stub('Card'), Button: stub('Button'),
    EmptyState: stub('EmptyState'), SkeletonCard: stub('SkeletonCard'), Icon: stub('Icon'),
  };
});

import Trips from '../../../app/(tabs)/trips';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const trips = [
  { id: 'credit', name: 'Credit trip', code: 'AAAAAA', currency: 'INR', members: [] },
  { id: 'debit', name: 'Debit trip', code: 'BBBBBB', currency: 'INR', members: [] },
  { id: 'zero', name: 'New empty trip', code: 'CCCCCC', currency: 'USD', members: [] },
];
const initialValues: Record<string, number> = { credit: 1250, debit: -800, zero: 0 };
let values = { ...initialValues };

function balancePayload(id: string) {
  return {
    net: { [`member-${id}`]: values[id] },
    members: [{ id: `member-${id}`, name: 'Ada', kind: 'individual', user_id: 'u1' }],
    currency: trips.find((trip) => trip.id === id)?.currency,
    per_person: [],
  };
}

beforeEach(() => {
  apiMock.mockReset();
  mockPush.mockReset();
  values = { ...initialValues };
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips') return Promise.resolve(trips);
    const id = path.split('/')[2];
    return Promise.resolve(balancePayload(id));
  });
});

describe('Trips personal balance wiring', () => {
  it('renders positive, negative, and current-person zero states from /balances', async () => {
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Trips />); });

    const rows = renderer.root.findAll((node: any) => node.type === 'TripListCard');
    expect(rows.map((row: any) => row.props.balance.kind)).toEqual(['owed', 'owe', 'settled']);
    expect(rows[0].props.balance.amount).toBe(1250);
    expect(rows[1].props.balance.amount).toBe(800);
    expect(rows[2].props.settledTestID).toBe('trip-settled-zero');

    expect(apiMock.mock.calls.map(([path]) => path)).toEqual([
      '/trips',
      '/trips/credit/balances',
      '/trips/debit/balances',
      '/trips/zero/balances',
    ]);
  });

  it('preserves the whole-card navigation action for settled trips', async () => {
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Trips />); });
    const settled = renderer.root.findAll((node: any) => node.type === 'TripListCard')[2];
    act(() => settled.props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/trip/zero');
  });

  it.each([
    ['positive', 'credit'],
    ['negative', 'debit'],
  ])('refreshes a %s balance to Settled after payment', async (_direction, tripId) => {
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<Trips />); });

    values[tripId] = 0;
    const screen = renderer.root.find((node: any) => node.type === 'Screen');
    await act(async () => { await screen.props.onRefresh(); });

    const row = renderer.root.findAll((node: any) => node.type === 'TripListCard')
      .find((node: any) => node.props.testID === `trip-item-${tripId}`);
    expect(row.props.balance.kind).toBe('settled');
    expect(row.props.balance.amount).toBe(0);
  });
});
