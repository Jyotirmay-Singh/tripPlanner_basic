/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here (mirrors unverified-banner.test.tsx).
//
// Render test for the trip-level "Settled" badge on the Expenses tab
// (frontend/app/trip/[id]/index.tsx). The badge is shown on EVERY transaction row (positive expenses
// and negative money-back rows alike) when the WHOLE trip is settled (balances.transfers === []).
// `Badge` and the real `isTripSettled` helper are intentionally NOT mocked so the wiring is exercised;
// the badge is located by its `label === 'Settled'` prop. Everything peripheral (display/permission
// helpers, theme, heavy UI components) is stubbed so the test stays focused and deterministic.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// --- contexts / router / native shells ---
jest.mock('../../api', () => ({ api: jest.fn(), getToken: jest.fn(), receiptUrl: jest.fn(() => 'receipt://x') }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useLocalSearchParams: () => ({ id: 't1' }),
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    // Run the focus callback once on mount so the screen's load() fires.
    useFocusEffect: (cb: any) => R.useEffect(() => { cb(); }, []),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  const { View } = require('react-native');
  return { SafeAreaView: (p: any) => R.createElement(View, p, p.children) };
});

// --- text + heavy / irrelevant components ---
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../DonutChart', () => ({ __esModule: true, default: () => null, paletteForMode: () => ['#000'] }));
jest.mock('../../ReceiptViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p && p.children);
  return {
    __esModule: true,
    Card: (p: any) => R.createElement('Card', p, p.children),
    Button: stub('Button'),
    IconButton: stub('IconButton'),
    Icon: stub('Icon'),
    StatCard: stub('StatCard'),
    ProgressBar: stub('ProgressBar'),
    EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'),
    // Render each tab segment as a pressable host node so the test can switch tabs.
    SegmentedControl: (p: any) =>
      R.createElement(
        R.Fragment,
        null,
        (p.segments || []).map((s: any) =>
          R.createElement('segment', {
            key: s.value,
            testID: `${p.testIDPrefix}-${s.value}`,
            onPress: () => p.onChange(s.value),
          }),
        ),
      ),
    useToast: () => ({ show: jest.fn() }),
  };
});

// --- pure display / permission helpers (orthogonal to the badge; stubbed for a minimal fixture) ---
jest.mock('../../permissions', () => ({
  canModifyExpense: () => false,
  roleOf: () => null,
  canEditTripSettings: () => false,
  canManageMembers: () => false,
  canDeleteTrip: () => false,
}));
jest.mock('../../composition', () => ({ compositionLabel: () => '' }));
jest.mock('../../displayNames', () => ({ memberDisplayNames: () => ({}), familyMemberDisplayNames: () => [] }));
jest.mock('../../format', () => ({ formatMoney: () => '0' }));
jest.mock('../../date', () => ({ formatTripDates: () => '' }));
jest.mock('../../time', () => ({ formatTime12h: () => '' }));
jest.mock('../../bill', () => ({ billLabel: () => 'Bill not attached' }));
// NOTE: ../../Badge and ../../tripSettled are deliberately left REAL.

import TripDetail from '../../../app/trip/[id]/index';
import { api, getToken } from '../../api';

const apiMock = api as unknown as jest.Mock;
const getTokenMock = getToken as unknown as jest.Mock;

const TRIP = {
  id: 't1', name: 'Trip', code: 'ABC', currency: 'INR',
  owner_id: 'u1', admin_ids: ['u1'],
  members: [{ id: 'm1', name: 'A', kind: 'individual', family_members: [] }],
};
const EXPENSES = [
  { id: 'e1', amount: 100, category: 'Food', date: '01-01-25', paid_by_member_id: 'm1', split_member_ids: ['m1'] },
  { id: 'i1', amount: -50, category: 'Refund', date: '01-01-25', paid_by_member_id: 'm1', split_member_ids: ['m1'] },
];
const balances = (transfers: any[]) => ({
  net: { m1: transfers.length ? -10 : 0 }, transfers, members: TRIP.members, currency: 'INR', per_person: [],
});

const settledBadges = (r: any) => r.root.findAll((n: any) => n.props && n.props.label === 'Settled');
const tabBtn = (r: any, value: string) => r.root.find((n: any) => n.props && n.props.testID === `trip-tab-${value}`);

async function openExpenses(transfersValue: any[]) {
  apiMock.mockImplementation((url: string) => {
    if (url === '/trips/t1') return Promise.resolve(TRIP);
    if (url === '/trips/t1/expenses') return Promise.resolve(EXPENSES);
    if (url === '/trips/t1/balances') return Promise.resolve(balances(transfersValue));
    return Promise.resolve({});
  });
  let r: any;
  await act(async () => { r = TestRenderer.create(React.createElement(TripDetail)); });
  await act(async () => { tabBtn(r, 'expenses').props.onPress(); });
  return r;
}

beforeEach(() => {
  apiMock.mockReset();
  getTokenMock.mockReset();
  getTokenMock.mockResolvedValue('tok');
});

describe('Expenses tab — trip-level "Settled" badge', () => {
  it('shows the badge on every transaction row (incl. money-back) when the trip is fully settled', async () => {
    const r = await openExpenses([]); // no suggested transfers => trip settled
    expect(settledBadges(r).length).toBe(2); // both rows (positive + negative) show the badge
  });

  it('shows no badge when any balance is outstanding', async () => {
    const r = await openExpenses([{ from_member_id: 'm1', to_member_id: 'm2', amount: 10 }]);
    expect(settledBadges(r).length).toBe(0);
  });
});
