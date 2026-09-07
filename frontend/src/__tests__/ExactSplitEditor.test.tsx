/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#146c94',
      textMain: '#111111',
      textMuted: '#666666',
      surface: '#ffffff',
      surfaceMuted: '#f2f4f5',
      border: '#dddddd',
      danger: '#b00020',
      warning: '#a05a00',
      success: '#087f5b',
    },
  }),
}));
jest.mock('../ui/Icon', () => {
  const R = require('react');
  const { Text: NativeText } = require('react-native');
  return {
    __esModule: true,
    default: ({ name }: { name: string }) => R.createElement(NativeText, null, name),
  };
});
jest.mock('../ui/ProgressBar', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: unknown) => R.createElement(View, props),
  };
});

import ExactSplitEditor from '../ExactSplitEditor';

function content(renderer: any): string {
  return renderer.root.findAllByType(Text)
    .flatMap((node: any) => node.props.children)
    .join(' ');
}

it('shows KWD precision inline and excludes invalid input from the save rows', () => {
  const onChange = jest.fn();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <ExactSplitEditor
        members={[{
          id: 'a', name: 'Alex', kind: 'individual', family_members: [],
        }]}
        currency="KWD"
        total={1.234}
        initialRows={[{
          memberId: 'a', entityId: 'a', included: true, amount: null,
        }]}
        onChange={onChange}
        displayNames={{ a: 'Alex' }}
      />,
    );
  });

  const input = renderer.root.findByType(TextInput);
  expect(input.props.placeholder).toBe('0.000');

  act(() => input.props.onChangeText('1.2345'));
  expect(renderer.root.findByProps({ testID: 'exact-precision-a' })).toBeTruthy();
  expect(content(renderer)).toContain(
    'Exact split amount in KWD allows at most 3 decimal places.',
  );
  expect(onChange).toHaveBeenLastCalledWith([
    { memberId: 'a', entityId: 'a', included: true, amount: null },
  ]);

  act(() => input.props.onChangeText('1.234'));
  expect(renderer.root.findAllByProps({ testID: 'exact-precision-a' })).toHaveLength(0);
  expect(onChange).toHaveBeenLastCalledWith([
    { memberId: 'a', entityId: 'a', included: true, amount: 1.234 },
  ]);
});
