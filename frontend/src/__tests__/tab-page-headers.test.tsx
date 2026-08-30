/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock('../api', () => ({
  api: jest.fn(),
  spendSummary: jest.fn(),
  getToken: jest.fn(),
  xlsxUrl: jest.fn(),
  pdfUrl: jest.fn(),
}));
jest.mock('../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Ada Traveller', email: 'ada@example.com' } }) }));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    mode: 'light', toggle: jest.fn(),
    colors: new Proxy({}, { get: () => '#123456' }),
  }),
}));
jest.mock('../useLogout', () => ({ useLogout: () => ({ confirmAndSignOut: jest.fn() }) }));
jest.mock('../UnverifiedBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('../Badge', () => ({ __esModule: true, default: () => null }));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../TabPageHeader', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('TabPageHeader', props) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Screen: stub('Screen'), TabScreen: stub('Screen'), Card: stub('Card'), Button: stub('Button'), StatCard: stub('StatCard'),
    IconButton: stub('IconButton'),
    ListRow: stub('ListRow'), EmptyState: stub('EmptyState'), AmountText: stub('AmountText'),
    SkeletonCard: stub('SkeletonCard'), Icon: stub('Icon'), useToast: () => ({ show: jest.fn() }),
  };
});

import Dashboard from '../../app/(tabs)/dashboard';
import Trips from '../../app/(tabs)/trips';
import Reports from '../../app/(tabs)/reports';
import Profile from '../../app/(tabs)/profile';

function renderHeader(Component: React.ComponentType) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<Component />); });
  return renderer!.root.findByType('TabPageHeader' as any);
}

describe('tab page headers', () => {
  it('renders the dashboard with the shared title-only header', () => {
    const header = renderHeader(Dashboard);
    expect(header.props.title).toBe('Dashboard');
    expect(header.props.eyebrow).toBeUndefined();
  });

  it('keeps the Trips new-trip action in the shared header', () => {
    const header = renderHeader(Trips);
    expect(header.props.title).toBe('Trips');
    expect(header.props.action.props.testID).toBe('trips-new-btn');
    expect(header.props.action.props.accessibilityLabel).toBe('Create new trip');
    expect(header.props.compactAction.props.testID).toBe('trips-new-btn-compact');
    expect(header.props.compactAction.props.accessibilityLabel).toBe('Create new trip');
    expect(header.props.compactAction.props.touchSize).toBe(48);
  });

  it.each([
    ['Reports', Reports],
    ['Profile', Profile],
  ])('uses the shared header on %s', (title, Component) => {
    expect(renderHeader(Component).props.title).toBe(title);
  });
});
