/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import { AccessibilityInfo, ScrollView, Text, TextInput, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { KeyboardController } from 'react-native-keyboard-controller';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#fff', surfaceMuted: '#f4f4f4', primary: '#173f39',
      primaryText: '#fff', textMain: '#111', textMuted: '#666', border: '#ddd',
      danger: '#c00',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(RN.Text, props, props.children) };
});
jest.mock('../ui/Icon', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('Icon', props) };
});

import { AppKeyboardProvider } from '../KeyboardController';
import * as WebKeyboard from '../KeyboardController.web';
import Input, { focusAndAnnounceInputError } from '../ui/Input';

beforeEach(() => jest.clearAllMocks());

it('configures the native provider for translucent edge-to-edge system bars', () => {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <AppKeyboardProvider><View testID="content" /></AppKeyboardProvider>,
    );
  });

  const provider = renderer.root.findByType('KeyboardProvider' as any);
  expect(provider.props).toEqual(expect.objectContaining({
    statusBarTranslucent: true,
    navigationBarTranslucent: true,
    preserveEdgeToEdge: true,
  }));
});

it('uses host-only fallbacks on web and does not leak native-only scroll props', () => {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <WebKeyboard.AppKeyboardProvider>
        <WebKeyboard.KeyboardAwareScrollView
          mode="insets"
          bottomOffset={48}
          disableScrollOnKeyboardHide
          testID="web-scroll"
        >
          <Text>Web form</Text>
        </WebKeyboard.KeyboardAwareScrollView>
      </WebKeyboard.AppKeyboardProvider>,
    );
  });

  const scroll = renderer.root.findByType(ScrollView);
  expect(scroll.props.testID).toBe('web-scroll');
  expect(scroll.props.mode).toBeUndefined();
  expect(scroll.props.bottomOffset).toBeUndefined();
  expect(renderer.root.findAllByType('KeyboardProvider' as any)).toHaveLength(0);
});

it('uses Next to traverse standard single-line fields and Done to blur final fields', () => {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <View>
        <Input testID="first" label="First" />
        <Input testID="last" label="Last" returnKeyType="done" />
      </View>,
    );
  });

  const [first, last] = renderer.root.findAllByType(TextInput);
  expect(first.props.returnKeyType).toBe('next');
  expect(first.props.submitBehavior).toBe('submit');
  act(() => first.props.onSubmitEditing({ nativeEvent: { text: '' } }));
  expect(KeyboardController.setFocusTo).toHaveBeenCalledWith('next');
  expect(last.props.returnKeyType).toBe('done');
  expect(last.props.submitBehavior).toBe('blurAndSubmit');
});

it('focuses and announces a submit-time inline validation error', () => {
  const focus = jest.fn();
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});

  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <Input
        testID="invalid-field"
        label="Email"
        error="Enter your email"
      />,
    );
  });

  const input = renderer.root.findByType(TextInput);
  expect(input.props.accessibilityState.invalid).toBe(true);
  expect(input.props.cursorColor).toBe('#173f39');
  focusAndAnnounceInputError({ focus }, 'Email', 'Enter your email');
  expect(focus).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith('Email: Enter your email');

  announce.mockRestore();
});
