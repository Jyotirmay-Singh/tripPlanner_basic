/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Platform } from 'react-native';
import * as RN from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { TYPESCALE } from '../theme';

let mockIsSuperAdmin = false;

jest.mock('expo-router', () => {
  const R = require('react');
  const Tabs = (props: any) => R.createElement('Tabs', props, props.children);
  Tabs.Screen = (props: any) => R.createElement('TabsScreen', props);
  return { Tabs };
});
jest.mock('expo-blur', () => {
  const R = require('react');
  return { BlurView: (props: any) => R.createElement('BlurView', props) };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 30, left: 0 }),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    mode: 'light',
    colors: { primary: '#123', textMuted: '#456', border: '#789' },
  }),
}));
jest.mock('../ui', () => {
  const R = require('react');
  return { Icon: (props: any) => R.createElement('Icon', props) };
});
jest.mock('../AuthContext', () => ({
  useAuth: () => ({ user: { is_super_admin: mockIsSuperAdmin } }),
}));

import TabsLayout from '../../app/(tabs)/_layout';

function renderTabs() {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<TabsLayout />); });
  return renderer!.root;
}

describe('tab navigator layout', () => {
  afterEach(() => {
    mockIsSuperAdmin = false;
    jest.restoreAllMocks();
  });

  it('does not reserve a native header above tab Screen safe areas', () => {
    const tabs = renderTabs().findByType('Tabs' as any);
    expect(tabs.props.screenOptions.headerShown).toBe(false);
    expect(tabs.props.screenOptions.headerRight).toBeUndefined();
  });

  it.each([1, 1.3])('renders complete navigation labels with growing space at scale %s', (fontScale) => {
    jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 320, height: 640, scale: 1, fontScale });
    const options = renderTabs().findByType('Tabs' as any).props.screenOptions;
    for (const title of ['Home', 'Groups', 'Reports']) {
      let label: any;
      act(() => { label = TestRenderer.create(options.tabBarLabel({ children: title, color: '#123', focused: true })); });
      const text = label.root.findByType(RN.Text);
      expect(text.props.children).toBe(title);
      expect(text.props.numberOfLines).toBeUndefined();
      expect(options.tabBarStyle.height - options.tabBarStyle.paddingTop - options.tabBarStyle.paddingBottom)
        .toBeGreaterThanOrEqual(25 + RN.StyleSheet.flatten(text.props.style).lineHeight * fontScale * 2);
    }
  });

  it('shows only Home, Trips, and Reports while keeping Profile routable', () => {
    const screens = renderTabs().findAllByType('TabsScreen' as any);
    const visibleScreens = screens.filter((screen: any) => screen.props.options.href !== null);
    const profile = screens.find((screen: any) => screen.props.name === 'profile');

    expect(visibleScreens.map((screen: any) => screen.props.name)).toEqual(['dashboard', 'trips', 'reports']);
    expect(profile.props.options).toEqual({ href: null, title: 'Profile' });
  });

  it('adds the dedicated Admin destination only for the application super-admin', () => {
    mockIsSuperAdmin = true;
    const screens = renderTabs().findAllByType('TabsScreen' as any);
    const visibleScreens = screens.filter((screen: any) => screen.props.options.href !== null);

    expect(visibleScreens.map((screen: any) => screen.props.name))
      .toEqual(['dashboard', 'trips', 'admin', 'reports']);
  });

  it.each([
    ['web', TYPESCALE.base],
    ['android', TYPESCALE.xs],
  ])('uses the %s tab-label size and preserves accessibility scaling', (platform, expectedSize) => {
    jest.spyOn(Platform, 'select').mockImplementation((specifics: any) => specifics[platform] ?? specifics.default);

    const options = renderTabs().findByType('Tabs' as any).props.screenOptions;

    expect(options.tabBarLabelStyle).toEqual({
      fontFamily: 'Figtree_600SemiBold',
      fontSize: expectedSize,
    });
    expect(options.tabBarAllowFontScaling).toBe(true);
    expect(options.tabBarItemStyle).toEqual({ flex: 1 });
  });
});
