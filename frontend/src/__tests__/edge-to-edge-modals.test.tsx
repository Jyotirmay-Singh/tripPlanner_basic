/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 2, bottom: 30, left: 1 }),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      surface: '#fff', surfaceMuted: '#eee', border: '#ddd', primary: '#123',
      primaryText: '#fff', owing: '#c00', textMuted: '#666', textMain: '#111',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});

import ConfirmModal from '../ConfirmModal';

it('draws a confirmation scrim beneath both system bars while keeping the card safe', () => {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <ConfirmModal visible title="Confirm" actions={[]} onRequestClose={() => {}} />,
    );
  });

  const modal = renderer.root.findByType(Modal);
  expect(modal.props.statusBarTranslucent).toBe(true);
  expect(modal.props.navigationBarTranslucent).toBe(true);

  expect(modal.props.children.props.style[1]).toEqual({
    paddingTop: 48,
    paddingBottom: 54,
    paddingLeft: 25,
    paddingRight: 26,
  });
});
