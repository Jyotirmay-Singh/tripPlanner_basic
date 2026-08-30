/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { ScrollView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  return { SafeAreaView: (props: any) => R.createElement('SafeAreaView', props, props.children) };
});
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: { background: '#fff', primary: '#123', primaryText: '#fff' } }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ui/Icon', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('Icon', props) };
});
jest.mock('@react-navigation/bottom-tabs', () => ({ useBottomTabBarHeight: () => 72 }));

import Screen from '../ui/Screen';
import TabScreen from '../ui/TabScreen';
import AuthShell from '../ui/AuthShell';

function safeAreaFor(element: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!.root.findByType('SafeAreaView' as any);
}

describe('safe-area ownership', () => {
  it('gives headerless Screen routes the top inset by default', () => {
    expect(safeAreaFor(<Screen>content</Screen>).props.edges).toEqual(['top', 'left', 'right']);
  });

  it('lets visible-header Screen routes opt into bottom-only insets', () => {
    expect(safeAreaFor(<Screen edges={['bottom']}>content</Screen>).props.edges).toEqual(['bottom']);
  });

  it('uses ordinary spacing for stack screens and measured clearance for tab screens', () => {
    let stack: any;
    let tab: any;
    act(() => {
      stack = TestRenderer.create(<Screen>content</Screen>);
      tab = TestRenderer.create(<TabScreen>content</TabScreen>);
    });
    expect(stack.root.findByType(ScrollView).props.contentContainerStyle.paddingBottom).toBe(24);
    expect(tab.root.findByType(ScrollView).props.contentContainerStyle.paddingBottom).toBe(96);
  });

  it('preserves AuthShell default safe-area behavior for headerless routes', () => {
    expect(safeAreaFor(<AuthShell title="Sign in">content</AuthShell>).props.edges)
      .toEqual(['top', 'left', 'right', 'bottom']);
  });

  it('keeps side and bottom edges for AuthShell routes beneath a native header', () => {
    expect(safeAreaFor(<AuthShell title="Register" nativeHeader>content</AuthShell>).props.edges)
      .toEqual(['left', 'right', 'bottom']);
  });
});
