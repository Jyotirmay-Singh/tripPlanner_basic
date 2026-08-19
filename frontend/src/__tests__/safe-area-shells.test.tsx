/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
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

import Screen from '../ui/Screen';
import AuthShell from '../ui/AuthShell';

function safeAreaFor(element: React.ReactElement) {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(element); });
  return renderer!.root.findByType('SafeAreaView' as any);
}

describe('safe-area ownership', () => {
  it('gives headerless Screen routes the top inset by default', () => {
    expect(safeAreaFor(<Screen>content</Screen>).props.edges).toEqual(['top']);
  });

  it('lets visible-header Screen routes opt into bottom-only insets', () => {
    expect(safeAreaFor(<Screen edges={['bottom']}>content</Screen>).props.edges).toEqual(['bottom']);
  });

  it('preserves AuthShell default safe-area behavior for headerless routes', () => {
    expect(safeAreaFor(<AuthShell title="Sign in">content</AuthShell>).props.edges).toBeUndefined();
  });

  it('forwards bottom-only edges for AuthShell routes beneath a native header', () => {
    expect(safeAreaFor(<AuthShell title="Register" edges={['bottom']}>content</AuthShell>).props.edges).toEqual(['bottom']);
  });
});
