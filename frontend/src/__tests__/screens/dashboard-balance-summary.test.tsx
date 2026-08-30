/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Ada Traveller' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'dark' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    useFocusEffect: (callback: any) => { R.useEffect(() => { callback(); }, []); },
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const { Text: RNText } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(RNText, props, props.children) };
});
jest.mock('../../composition', () => ({ compositionLabel: () => '2 individuals' }));
jest.mock('../../date', () => ({ formatTripDates: () => 'dates' }));
jest.mock('../../UnverifiedBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('../../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props?.children);
  return {
    __esModule: true,
    Screen: stub('Screen'), TabScreen: stub('Screen'), Card: stub('Card'), Button: stub('Button'),
    ListRow: stub('ListRow'), EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'), SkeletonCard: stub('SkeletonCard'),
  };
});

import Dashboard from '../../../app/(tabs)/dashboard';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;

function configure(rows: { id: string; currency: string; balance: number }[]) {
  const trips = rows.map((row) => ({
    id: row.id, name: row.id, code: row.id.toUpperCase(), currency: row.currency, members: [],
  }));
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips') return Promise.resolve(trips);
    const id = path.split('/')[2];
    const row = rows.find((candidate) => candidate.id === id)!;
    return Promise.resolve({
      net: { [`member-${id}`]: row.balance },
      members: [{ id: `member-${id}`, name: 'Ada', kind: 'individual', user_id: 'u1' }],
      currency: row.currency,
      per_person: [],
    });
  });
}

async function renderDashboard() {
  let renderer: any;
  await act(async () => { renderer = TestRenderer.create(<Dashboard />); });
  return renderer;
}

function visibleText(renderer: any): string {
  return renderer.root.findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat(Infinity)
    .filter((value: unknown) => typeof value === 'string')
    .join(' ');
}

beforeEach(() => { apiMock.mockReset(); });

describe('Home Net Position', () => {
  it.each([
    [1250, 'You come out ahead · 1 trip', true],
    [-800, 'You owe overall · 1 trip', false],
    [0, 'All settled up · 1 trip', false],
  ])('matches copy and sign for balance %s', async (balance, copy, signed) => {
    configure([{ id: 't1', currency: 'INR', balance: balance as number }]);
    const renderer = await renderDashboard();
    const amount = renderer.root.findAll((node: any) => node.type === 'AmountText')[0];
    expect(amount.props).toMatchObject({ value: balance, currency: 'INR', signed });
    expect(visibleText(renderer)).toContain(copy);
    if (balance === 0) expect(amount.props.signed).toBe(false);
  });

  it('groups unlike currencies instead of adding them and uses mixed-position copy', async () => {
    configure([
      { id: 'inr', currency: 'INR', balance: 2000 },
      { id: 'usd', currency: 'USD', balance: -10 },
    ]);
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts.map((node: any) => node.props.value)).toEqual([2000, -10]);
    expect(visibleText(renderer)).toContain('Balances vary by currency · 2 trips');
  });

  it('contains no redundant You owe / You\'re owed metric cards', async () => {
    configure([{ id: 't1', currency: 'INR', balance: 0 }]);
    const renderer = await renderDashboard();
    expect(renderer.root.findAll((node: any) => (
      node.props.testID === 'dash-you-owe' || node.props.testID === 'dash-you-owed'
    ))).toHaveLength(0);
  });
});
