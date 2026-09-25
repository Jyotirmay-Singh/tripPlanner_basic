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
  it('does not turn a missing offline copy into zero trips or a zero balance', async () => {
    apiMock.mockRejectedValue(new Error('offline'));
    const renderer = await renderDashboard();
    expect(visibleText(renderer)).toContain('Balance unavailable');
    expect(visibleText(renderer)).toContain('Trip count unavailable');
    expect(renderer.root.findAll((node: any) => node.props?.testID === 'dash-unavailable').length)
      .toBeGreaterThan(0);
  });

  it.each([
    [1250, true],
    [-800, false],
    [0, false],
  ])('shows only the trip count beneath balance %s', async (balance, signed) => {
    configure([{ id: 't1', currency: 'INR', balance: balance as number }]);
    const renderer = await renderDashboard();
    const amount = renderer.root.findAll((node: any) => node.type === 'AmountText')[0];
    expect(amount.props).toMatchObject({
      value: balance,
      currency: 'INR',
      currencyDisplay: 'code',
      signed,
    });
    const copy = visibleText(renderer);
    expect(copy).toContain('1 trip');
    expect(copy).not.toMatch(/You come out ahead|You owe overall|All settled up/);
    if (balance === 0) expect(amount.props.signed).toBe(false);
  });

  it('rounds a non-integral API balance before rendering the hero amount', async () => {
    configure([{ id: 't1', currency: 'INR', balance: 1250.5 }]);
    const renderer = await renderDashboard();
    const amount = renderer.root.findAll((node: any) => node.type === 'AmountText')[0];
    expect(amount.props.value).toBe(1251);
  });

  it('groups unlike currencies instead of adding them and uses mixed-position copy', async () => {
    configure([
      { id: 'inr', currency: 'INR', balance: 2000 },
      { id: 'usd', currency: 'USD', balance: -10 },
    ]);
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts.map((node: any) => node.props.value)).toEqual([2000, -10]);
    expect(amounts.every((node: any) => node.props.currencyDisplay === 'code')).toBe(true);
    const copy = visibleText(renderer);
    expect(copy).toContain('2 trips');
    expect(copy).not.toContain('Balances vary by currency');
  });

  it('contains no redundant You owe / You\'re owed metric cards', async () => {
    configure([{ id: 't1', currency: 'INR', balance: 0 }]);
    const renderer = await renderDashboard();
    expect(renderer.root.findAll((node: any) => (
      node.props.testID === 'dash-you-owe' || node.props.testID === 'dash-you-owed'
    ))).toHaveLength(0);
  });
});
