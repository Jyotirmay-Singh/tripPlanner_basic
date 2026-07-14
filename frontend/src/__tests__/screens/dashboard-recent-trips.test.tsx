/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here (mirrors unverified-banner.test.tsx).
//
// Render test for the dashboard "Recent trips" cap: the screen shows at most the LATEST 2 trips
// (frontend/app/(tabs)/dashboard.tsx). The backend already returns /trips newest-first, so the
// screen just slices the first two. Peripheral UI/theme/helpers are stubbed so the test stays
// focused on how many `dash-trip-*` rows render.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Ada Traveller' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }),
}));
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useRouter: () => ({ push: jest.fn() }),
    // Run the focus callback once on mount so the screen's load() fires (and only once).
    useFocusEffect: (cb: any) => { R.useEffect(() => { cb(); }, []); },
  };
});
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../composition', () => ({ compositionLabel: () => 'comp' }));
jest.mock('../../date', () => ({ formatTripDates: () => 'dates' }));
jest.mock('../../UnverifiedBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (p: any) => R.createElement(name, p, p && p.children);
  return {
    __esModule: true,
    Screen: (p: any) => R.createElement('Screen', p, p.children),
    Card: (p: any) => R.createElement('Card', p, p.children),
    Button: stub('Button'),
    StatCard: stub('StatCard'),
    ListRow: (p: any) => R.createElement('ListRow', p),
    EmptyState: stub('EmptyState'),
    AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'),
  };
});

import Dashboard from '../../../app/(tabs)/dashboard';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;

const tripRows = (r: any) =>
  r.root.findAll((n: any) =>
    typeof n.type === 'string' && n.props && typeof n.props.testID === 'string' && n.props.testID.startsWith('dash-trip-'));

async function mountWith(tripCount: number) {
  const trips = Array.from({ length: tripCount }, (_, i) => ({
    id: `t${i + 1}`, name: `Trip ${i + 1}`, code: `C${i + 1}`, currency: 'INR', members: [],
  }));
  apiMock.mockImplementation((url: string) => {
    if (url === '/trips') return Promise.resolve(trips);
    return Promise.resolve({ net: {}, members: [] }); // per-trip balances (no myMember → skipped)
  });
  let r: any;
  await act(async () => { r = TestRenderer.create(React.createElement(Dashboard)); });
  return r;
}

beforeEach(() => { apiMock.mockReset(); });

describe('dashboard recent trips cap', () => {
  it('renders the empty state (no rows) when there are 0 trips', async () => {
    const r = await mountWith(0);
    expect(tripRows(r).length).toBe(0);
  });

  it('renders 1 row when there is 1 trip', async () => {
    const r = await mountWith(1);
    expect(tripRows(r).length).toBe(1);
  });

  it('renders exactly 2 rows when there are 2 trips', async () => {
    const r = await mountWith(2);
    expect(tripRows(r).length).toBe(2);
  });

  it('caps at the first 2 (newest) rows when there are more than 2', async () => {
    const r = await mountWith(4);
    const rows = tripRows(r);
    expect(rows.length).toBe(2);
    expect(rows.map((n: any) => n.props.testID)).toEqual(['dash-trip-t1', 'dash-trip-t2']);
  });
});
