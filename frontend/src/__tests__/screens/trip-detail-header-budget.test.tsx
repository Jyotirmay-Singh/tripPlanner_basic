/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { COMPONENT_SIZE, RADIUS, SPACING } from '../../theme';

const mockRouterPush = jest.fn();

jest.mock('../../api', () => ({
  api: jest.fn(),
  getToken: jest.fn(),
  receiptUrl: jest.fn(() => 'receipt://x'),
  spendSummary: jest.fn(),
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({
    mode: 'dark',
    colors: {
      background: '#0a0d0c', surface: '#121715', surfaceMuted: '#1a221f',
      primary: '#87c0b2', primaryText: '#0a0d0c', overlayOnPrimary: 'rgba(0,0,0,0.12)',
      textMain: '#f7f5f0', textMuted: '#8ea39d', border: '#24302c',
      danger: '#ff8a66', success: '#8fc98f', warning: '#f5c28f',
    },
  }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => ({ id: 't1' }),
    useRouter: () => ({ push: mockRouterPush, back: jest.fn() }),
    useFocusEffect: (callback: any) => R.useEffect(() => { callback(); }, []),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  return { SafeAreaView: (props: any) => R.createElement('SafeAreaView', props, props.children) };
});
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../DonutChart', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => R.createElement('DonutChart', props),
    paletteForMode: () => ['#123456'],
  };
});
jest.mock('../../SpendBarChart', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ReceiptViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../../TripChat', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TripChat', props) };
});
jest.mock('../../useTripChat', () => ({
  useTripChat: () => ({
    messages: [], unreadCount: 0, loading: false, loadingOlder: false,
    hasMoreBefore: false, connected: true, refreshUnread: jest.fn(), loadLatest: jest.fn(),
    loadOlder: jest.fn(), send: jest.fn(), retry: jest.fn(), edit: jest.fn(), remove: jest.fn(),
    clear: jest.fn(), markThrough: jest.fn(),
  }),
}));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    Card: stub('Card'),
    Button: stub('Button'),
    IconButton: stub('IconButton'),
    Icon: stub('Icon'),
    SegmentedControl: stub('SegmentedControl'),
    StatCard: stub('StatCard'),
    ProgressBar: stub('ProgressBar'),
    EmptyState: stub('EmptyState'),
    ResponsiveAmountText: stub('ResponsiveAmountText'),
    SkeletonCard: stub('SkeletonCard'),
    useToast: () => ({ show: jest.fn() }),
  };
});
jest.mock('../../permissions', () => ({
  canModifyExpense: () => false,
  roleOf: () => null,
  canEditTripSettings: () => true,
  canManageMembers: () => false,
  canDeleteTrip: () => false,
}));
jest.mock('../../displayNames', () => ({
  memberDisplayNames: (members: any[]) => Object.fromEntries(members.map((member) => [member.id, member.name])),
  familyMemberDisplayNames: (member: any) => member.family_members || [],
}));
jest.mock('../../bill', () => ({ billLabel: () => 'Bill not attached' }));

import TripDetail from '../../../app/trip/[id]/index';
import { api, getToken, spendSummary } from '../../api';

const apiMock = api as unknown as jest.Mock;
const getTokenMock = getToken as unknown as jest.Mock;
const spendSummaryMock = spendSummary as unknown as jest.Mock;

const INDIVIDUAL = {
  id: 'm1', name: 'Aditi', kind: 'individual', family_members: [], user_id: 'u1',
};
const BASE_TRIP = {
  id: 't1',
  name: 'Lakshadweep',
  code: 'UCK3RZ',
  start_date: '2026-11-12',
  end_date: '2026-11-19',
  budget: 100_000,
  currency: 'INR',
  owner_id: 'u1',
  admin_ids: ['u1'],
  members: [INDIVIDUAL],
};

type Fixture = {
  trip?: Record<string, unknown>;
  budget?: number | null;
  expenses?: Record<string, unknown>[];
};

const expense = (amount: number, id = `e-${amount}`) => ({
  id,
  amount,
  category: 'Food',
  date: '12-11-26',
  paid_by_member_id: 'm1',
  split_member_ids: ['m1'],
});

async function mountTrip(fixture: Fixture = {}) {
  const { trip: tripOverrides, expenses = [expense(50_000)] } = fixture;
  const budget = Object.prototype.hasOwnProperty.call(fixture, 'budget')
    ? fixture.budget
    : 100_000;
  const trip = { ...BASE_TRIP, ...tripOverrides, budget };
  const balances = {
    net: { m1: 0 }, transfers: [], members: trip.members, currency: trip.currency, per_person: [],
  };
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips/t1') return Promise.resolve(trip);
    if (path === '/trips/t1/expenses') return Promise.resolve(expenses);
    if (path === '/trips/t1/balances') return Promise.resolve(balances);
    return Promise.resolve({});
  });
  spendSummaryMock.mockResolvedValue({ total: 0, count: 0, entities: [] });

  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<TripDetail />);
  });
  return renderer;
}

function hostByTestID(root: any, type: string, testID: string) {
  return root.findAllByType(type as any).find((node: any) => node.props.testID === testID);
}

function textContent(node: any): string {
  const children = node?.props?.children;
  if (children == null) return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map((child) => (
    typeof child === 'object' && child?.props ? textContent(child) : String(child ?? '')
  )).join('');
  return typeof children === 'object' && children?.props ? textContent(children) : String(children);
}

beforeEach(() => {
  apiMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue('token');
  spendSummaryMock.mockReset();
  mockRouterPush.mockReset();
});

describe('Trip identity header', () => {
  it('contains only identity information and reserves no financial row or fixed height', async () => {
    const longCode = 'UCK3RZ-LOCALIZED-SHARING-CODE-2026';
    const longName = 'Lakshadweep family reunion and island-hopping expedition';
    const family = {
      id: 'family', name: 'Extended Family', kind: 'family',
      family_members: Array.from({ length: 17 }, (_, index) => `Person ${index + 1}`),
    };
    const renderer = await mountTrip({
      trip: { name: longName, code: longCode, members: [family, INDIVIDUAL] },
    });
    const header = hostByTestID(renderer.root, 'Card', 'trip-identity-header');
    expect(header).toBeTruthy();
    expect(header.props).toEqual(expect.objectContaining({ padding: 'lg', radius: RADIUS.xl }));
    expect(header.props.style).toBeUndefined();
    expect(header.findAll((node: any) => (
      node.props.testID === 'trip-spent-amount' || node.props.testID === 'trip-budget-amount'
    ))).toHaveLength(0);

    const headerText = header.findAllByType('T' as any).map(textContent).join(' ');
    expect(headerText).toContain('12/11/2026');
    expect(headerText).toContain(longCode);
    expect(headerText).toContain(longName);
    expect(headerText).toContain('18 Individuals across 1 Family & 1 Single');
    expect(headerText).not.toMatch(/\bspent\b/i);
    expect(headerText).not.toMatch(/\bbudget\b/i);

    const share = hostByTestID(header, 'TouchableOpacity', 'trip-share')
      ?? header.findAll((node: any) => node.props.testID === 'trip-share').at(-1);
    expect(share.props.accessibilityLabel).toBe(`Share trip code ${longCode}`);
    expect(StyleSheet.flatten(share.props.style)).toEqual(expect.objectContaining({
      minHeight: COMPONENT_SIZE.minTouchTarget,
      maxWidth: '100%',
    }));

    for (const testID of ['trip-date-range', 'trip-name', 'trip-participant-summary']) {
      const text = hostByTestID(header, 'T', testID);
      expect(text).toBeTruthy();
      expect(text.props.numberOfLines).toBeUndefined();
    }
    const codeText = header.findAllByType('T' as any).find((node: any) => textContent(node) === longCode);
    expect(codeText?.props.numberOfLines).toBeUndefined();

    expect(hostByTestID(renderer.root, 'Card', 'trip-budget-used-card')).toBeTruthy();
  });

  it('keeps action behavior, adaptive tabs, and 48 dp icon actions intact', async () => {
    const renderer = await mountTrip();
    const add = hostByTestID(renderer.root, 'Button', 'trip-add-expense');
    const settle = hostByTestID(renderer.root, 'Button', 'trip-settle-up');
    const edit = hostByTestID(renderer.root, 'IconButton', 'trip-edit');
    const tabs = renderer.root.findByType('SegmentedControl' as any);

    expect(StyleSheet.flatten(add.props.style).minHeight).toBe(COMPONENT_SIZE.minTouchTarget);
    expect(StyleSheet.flatten(settle.props.style).minHeight).toBe(COMPONENT_SIZE.minTouchTarget);
    expect(edit.props).toEqual(expect.objectContaining({
      accessibilityLabel: 'Edit trip',
      touchSize: COMPONENT_SIZE.minTouchTarget,
    }));
    expect(tabs.props).toEqual(expect.objectContaining({ layout: 'adaptive', testIDPrefix: 'trip-tab' }));

    act(() => add.props.onPress());
    act(() => settle.props.onPress());
    act(() => edit.props.onPress());
    expect(mockRouterPush.mock.calls.map(([path]) => path)).toEqual([
      '/trip/t1/add-expense',
      '/trip/t1/settle-up',
      '/trip/t1/edit',
    ]);

    const safeArea = renderer.root.findByType('SafeAreaView' as any);
    expect(safeArea.props.edges).toEqual(['bottom', 'left', 'right']);
  });
});

describe('Budget Used card', () => {
  it('uses one exact representation below budget', async () => {
    const renderer = await mountTrip({ expenses: [expense(60_000), expense(-10_000, 'refund')] });
    const spent = hostByTestID(renderer.root, 'T', 'trip-budget-used-spent');
    const total = hostByTestID(renderer.root, 'T', 'trip-budget-used-total');
    const progress = hostByTestID(renderer.root, 'ProgressBar', 'trip-budget-progress');

    expect(textContent(spent)).toBe('INR 50,000.00');
    expect(textContent(total)).toBe('INR 100,000.00');
    expect(`${textContent(spent)} ${textContent(total)}`).not.toMatch(/[KMBT]\b/);
    expect(progress.props.progress).toBe(0.5);
    expect(progress.props.accessibilityValueText).toBe('INR 50,000.00 of INR 100,000.00');
    expect(hostByTestID(renderer.root, 'T', 'trip-budget-overage')).toBeUndefined();
  });

  it('distinguishes exactly-at-budget from over-budget without relying on colour alone', async () => {
    const exactRenderer = await mountTrip({ expenses: [expense(100_000)] });
    const exactProgress = hostByTestID(exactRenderer.root, 'ProgressBar', 'trip-budget-progress');
    expect(exactProgress.props.progress).toBe(1);
    expect(hostByTestID(exactRenderer.root, 'View', 'trip-budget-overage')).toBeUndefined();

    const overRenderer = await mountTrip({
      expenses: [expense(202_899), expense(-50_000, 'refund')],
    });
    const overSpent = hostByTestID(overRenderer.root, 'T', 'trip-budget-used-spent');
    const overTotal = hostByTestID(overRenderer.root, 'T', 'trip-budget-used-total');
    const overProgress = hostByTestID(overRenderer.root, 'ProgressBar', 'trip-budget-progress');
    const overage = overRenderer.root.findAll((node: any) => node.props.testID === 'trip-budget-overage').at(-1);

    expect(textContent(overSpent)).toBe('INR 152,899.00');
    expect(textContent(overTotal)).toBe('INR 100,000.00');
    expect(overProgress.props.progress).toBeCloseTo(1.52899);
    expect(overProgress.props.accessibilityValueText).toBe(
      'INR 152,899.00 of INR 100,000.00; INR 52,899.00 over budget',
    );
    expect(overage.findAllByType('T' as any).map(textContent).join(' ')).toContain(
      'INR 52,899.00 over budget',
    );
    expect(overSpent.props.color).toBe('#ff8a66');
    expect(overTotal.props.color).toBe('#ff8a66');
  });

  it.each([
    [undefined, 'No budget set'],
    [null, 'No budget set'],
    [0, 'No budget set'],
    [-1, 'Budget usage unavailable'],
    [Number.NaN, 'Budget usage unavailable'],
  ])('handles budget %p without a misleading progress indicator', async (budget, state) => {
    const renderer = await mountTrip({ budget, expenses: [expense(50_000)] });
    const card = hostByTestID(renderer.root, 'Card', 'trip-budget-used-card');
    const spent = hostByTestID(card, 'T', 'trip-budget-used-spent');
    const stateText = hostByTestID(card, 'T', 'trip-budget-used-state');

    expect(textContent(spent)).toBe('INR 50,000.00 spent');
    expect(textContent(stateText)).toBe(state);
    expect(card.findAllByType('ProgressBar' as any)).toHaveLength(0);
  });

  it('keeps very large exact amounts wrap-capable instead of compacting or truncating', async () => {
    const renderer = await mountTrip({
      budget: 9_876_543_210.98,
      expenses: [expense(123_456_789.12)],
    });
    const spent = hostByTestID(renderer.root, 'T', 'trip-budget-used-spent');
    const total = hostByTestID(renderer.root, 'T', 'trip-budget-used-total');

    expect(textContent(spent)).toBe('INR 123,456,789.12');
    expect(textContent(total)).toBe('INR 9,876,543,210.98');
    expect(spent.props.numberOfLines).toBeUndefined();
    expect(total.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(spent.props.style)).toEqual(expect.objectContaining({
      maxWidth: '100%', flexShrink: 1, minWidth: 0,
    }));
  });

  it('supports negative net spend and rejects a non-finite aggregate presentation', async () => {
    const negativeRenderer = await mountTrip({ budget: 100, expenses: [expense(-50)] });
    expect(textContent(hostByTestID(negativeRenderer.root, 'T', 'trip-budget-used-spent')))
      .toBe('INR -50.00');
    expect(hostByTestID(negativeRenderer.root, 'ProgressBar', 'trip-budget-progress').props.progress)
      .toBe(-0.5);

    const invalidRenderer = await mountTrip({ budget: 100, expenses: [expense(Number.POSITIVE_INFINITY)] });
    const invalidCard = hostByTestID(invalidRenderer.root, 'Card', 'trip-budget-used-card');
    expect(textContent(hostByTestID(invalidCard, 'T', 'trip-budget-used-state')))
      .toBe('Budget usage unavailable');
    expect(invalidCard.findAllByType('ProgressBar' as any)).toHaveLength(0);
  });

  it('keeps the Summary rhythm on shared spacing tokens', async () => {
    const renderer = await mountTrip();
    const card = hostByTestID(renderer.root, 'Card', 'trip-budget-used-card');
    const content = card.findAll((node: any) => (
      StyleSheet.flatten(node.props.style)?.gap === SPACING.sm
    ));
    expect(content.length).toBeGreaterThan(0);
  });
});
