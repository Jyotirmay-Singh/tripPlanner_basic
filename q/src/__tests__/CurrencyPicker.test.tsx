/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#146c94', textMain: '#111111', textMuted: '#666666',
      surface: '#ffffff', surfaceMuted: '#f2f4f5', border: '#dddddd',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});
jest.mock('../ui/Icon', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ name }: any) => R.createElement(Text, null, name) };
});
jest.mock('../ui/Input', () => {
  const R = require('react');
  const { TextInput } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(TextInput, props) };
});
jest.mock('../ui/Sheet', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ visible, children, testID }: any) => visible
      ? R.createElement(View, { testID }, children)
      : null,
  };
});

import CurrencyPicker from '../ui/CurrencyPicker';

describe('CurrencyPicker', () => {
  it('opens a scrollable catalog and selects a currency', () => {
    const onChange = jest.fn();
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <CurrencyPicker value="INR" onChange={onChange} testID="currency" />,
      );
    });

    const trigger = renderer.root.findByProps({ testID: 'currency-trigger' });
    expect(trigger.props.accessibilityLabel).toContain('INR, Indian Rupee');
    act(() => trigger.props.onPress());

    const inr = renderer.root.findByProps({ testID: 'currency-row-INR' });
    expect(inr.props.accessibilityState).toEqual({ selected: true });
    act(() => renderer.root.findByProps({ testID: 'currency-row-LKR' }).props.onPress());
    expect(onChange).toHaveBeenCalledWith('LKR');
    expect(renderer.root.findByProps({ testID: 'currency-sheet' }).props.visible).toBe(false);
  });

  it('filters by currency name and exposes Nepalese rupee', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <CurrencyPicker value="INR" onChange={jest.fn()} testID="currency" />,
      );
    });
    act(() => renderer.root.findByProps({ testID: 'currency-trigger' }).props.onPress());
    act(() => renderer.root.findByProps({ testID: 'currency-search' }).props.onChangeText('Nepal'));

    expect(renderer.root.findAllByProps({ testID: 'currency-row-NPR' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'currency-row-USD' })).toHaveLength(0);
  });

  it('marks a locked official currency as disabled', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <CurrencyPicker value="USD" disabled testID="locked-currency" />,
      );
    });
    const trigger = renderer.root.findByProps({ testID: 'locked-currency-trigger' });
    expect(trigger.props.accessibilityState).toEqual({ disabled: true });
    expect(trigger.props.accessibilityHint).toBe('The official currency is locked');
  });
});
