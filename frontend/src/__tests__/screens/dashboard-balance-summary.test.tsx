/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
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
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
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
import * as dashboardReads from '../../offlineReads';

const apiMock = api as unknown as jest.Mock;
const renderers: any[] = [];

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
  renderers.push(renderer);
  return renderer;
}

function visibleText(renderer: any): string {
  return renderer.root.findAllByType(Text)
    .map((node: any) => node.props.children)
    .flat(Infinity)
    .filter((value: unknown) => typeof value === 'string')
    .join(' ');
}

function setViewport(width = 390, fontScale = 1) {
  const dimensions = { width, height: 844, scale: 1, fontScale };
  Dimensions.set({ window: dimensions, screen: dimensions });
}

beforeEach(() => {
  apiMock.mockReset();
  setViewport();
});

afterEach(() => {
  act(() => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
  jest.restoreAllMocks();
});

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
      variant: 'moneyLg',
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

  it.each([
    ['GBP', 0],
    ['GBP', 500],
    ['USD', -10],
    ['EUR', 250],
    ['LKR', 10000],
  ])('shows only INR when a %s trip has balance %s', async (currency, balance) => {
    configure([
      { id: 'inr', currency: 'INR', balance: 2000 },
      { id: 'foreign', currency, balance },
    ]);
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts).toHaveLength(1);
    expect(amounts[0].props).toMatchObject({
      value: 2000, currency: 'INR', currencyDisplay: 'code', variant: 'moneyLg',
    });
    const copy = visibleText(renderer);
    expect(copy).toContain('2 trips');
    expect(copy).not.toContain('Balances vary by currency');
  });

  it('totals only INR trips without adding or relabelling foreign balances', async () => {
    configure([
      { id: 'inr-owed', currency: 'INR', balance: 1250 },
      { id: 'inr-owing', currency: 'INR', balance: -800 },
      { id: 'gbp', currency: 'GBP', balance: 999 },
    ]);
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts).toHaveLength(1);
    expect(amounts[0].props).toMatchObject({ value: 450, currency: 'INR', signed: true });
    expect(visibleText(renderer)).toContain('3 trips');
  });

  it('shows INR zero when there are no trips', async () => {
    configure([]);
    const renderer = await renderDashboard();
    const amount = renderer.root.findAll((node: any) => node.type === 'AmountText')[0];
    expect(amount.props).toMatchObject({ value: 0, currency: 'INR', signed: false });
    expect(visibleText(renderer)).toContain('0 trips');
  });

  it('shows INR zero when the user has only foreign-currency trips', async () => {
    configure([{ id: 'gbp', currency: 'GBP', balance: 500 }]);
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts).toHaveLength(1);
    expect(amounts[0].props).toMatchObject({ value: 0, currency: 'INR', signed: false });
    expect(visibleText(renderer)).toContain('1 trip');
  });

  it('uses the same INR-only summary for a saved offline overview', async () => {
    jest.spyOn(dashboardReads, 'loadDashboardOverview').mockResolvedValueOnce({
      data: {
        trips: [
          { id: 'inr', name: 'INR trip', currency: 'INR', members: [] },
          { id: 'gbp', name: 'GBP trip', currency: 'GBP', members: [] },
        ],
        balances: {
          inr: { currency: 'INR', balance: 12241 },
          gbp: { currency: 'GBP', balance: 0 },
        },
      },
      source: 'cache', fetchedAt: 1,
    });
    const renderer = await renderDashboard();
    const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
    expect(amounts).toHaveLength(1);
    expect(amounts[0].props).toMatchObject({ value: 12241, currency: 'INR' });
    expect(renderer.root.findAll((node: any) => node.type === 'Button')
      .every((node: any) => node.props.disabled)).toBe(true);
  });

  it.each([
    [320, 1, 'column'],
    [360, 1, 'column'],
    [390, 1, 'row'],
    [768, 1, 'row'],
    [1440, 1, 'row'],
    [390, 1.5, 'column'],
  ])('keeps the INR card and actions consistent at width %s and font scale %s',
    async (width, fontScale, direction) => {
      setViewport(width as number, fontScale as number);
      configure([
        { id: 'inr', currency: 'INR', balance: 12241 },
        { id: 'gbp', currency: 'GBP', balance: 0 },
      ]);
      const renderer = await renderDashboard();
      const actions = renderer.root.findByProps({ testID: 'dash-actions' });
      expect(StyleSheet.flatten(actions.props.style).flexDirection).toBe(direction);
      const amounts = renderer.root.findAll((node: any) => node.type === 'AmountText');
      expect(amounts).toHaveLength(1);
      expect(amounts[0].props).toMatchObject({
        value: 12241, currency: 'INR', variant: 'moneyLg',
      });
      expect(StyleSheet.flatten(amounts[0].props.style).textAlign).toBe('left');
      expect(renderer.root.findAll((node: any) => node.type === 'Button')
        .map((node: any) => node.props.label)).toEqual(['New Trip', 'Join Trip']);
    });

  it('contains no redundant You owe / You\'re owed metric cards', async () => {
    configure([{ id: 't1', currency: 'INR', balance: 0 }]);
    const renderer = await renderDashboard();
    expect(renderer.root.findAll((node: any) => (
      node.props.testID === 'dash-you-owe' || node.props.testID === 'dash-you-owed'
    ))).toHaveLength(0);
  });
});
