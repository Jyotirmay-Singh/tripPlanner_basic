/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

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

import TabsLayout from '../../app/(tabs)/_layout';

describe('tab navigator layout', () => {
  it('does not reserve a native header above tab Screen safe areas', () => {
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<TabsLayout />); });

    const tabs = renderer!.root.findByType('Tabs' as any);
    expect(tabs.props.screenOptions.headerShown).toBe(false);
    expect(tabs.props.screenOptions.headerRight).toBeUndefined();
  });
});
