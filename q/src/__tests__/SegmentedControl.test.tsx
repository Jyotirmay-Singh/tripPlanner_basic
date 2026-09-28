/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#123456', primaryText: '#ffffff', textMuted: '#666666',
      surfaceMuted: '#eeeeee', border: '#dddddd',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (props: any) => R.createElement(Text, props, props.children) };
});

import SegmentedControl, {
  equalTrackRequiredWidth,
  selectedTabScrollOffset,
} from '../ui/SegmentedControl';

const FOUR = [
  { value: 'summary', label: 'Summary' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'balances', label: 'Balances' },
  { value: 'members', label: 'Members' },
] as const;

function layoutEvent(x: number, width: number) {
  return { nativeEvent: { layout: { x, y: 0, width, height: 48 } } } as any;
}

it('renders a tab badge and preserves tab selection semantics', () => {
  const onChange = jest.fn();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <SegmentedControl
        segments={[{ value: 'summary', label: 'Summary' }, { value: 'chat', label: 'Chat', badge: '99+' }]}
        value="summary"
        onChange={onChange}
        layout="scrollable"
        testIDPrefix="trip-tab"
      />,
    );
  });

  expect(renderer.root.findByProps({ testID: 'trip-tab-chat-badge' })).toBeTruthy();
  const chat = renderer.root.findByProps({ testID: 'trip-tab-chat' });
  expect(chat.props.accessibilityState).toEqual({ selected: false });
  act(() => chat.props.onPress());
  expect(onChange).toHaveBeenCalledWith('chat');
});

it('uses a full-width equal track when every measured adaptive tab fits', () => {
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <SegmentedControl
        segments={[...FOUR]}
        value="summary"
        onChange={jest.fn()}
        layout="adaptive"
        testIDPrefix="fit-tab"
      />,
    );
  });

  act(() => {
    renderer.root.findByProps({ testID: 'fit-tab-scrollable' }).props.onLayout(layoutEvent(0, 400));
    FOUR.forEach((segment, index) => {
      renderer.root.findByProps({ testID: `fit-tab-${segment.value}` }).props.onLayout(layoutEvent(index * 80, 80));
    });
  });

  expect(renderer.root.findByProps({ testID: 'fit-tab-equal' })).toBeTruthy();
  const members = renderer.root.findByProps({ testID: 'fit-tab-members' });
  const resolvedStyle = members.props.style({ focused: false });
  expect(resolvedStyle).toEqual(expect.arrayContaining([
    expect.objectContaining({ minHeight: 48 }),
    expect.objectContaining({ flex: 1, minWidth: 0 }),
  ]));
});

it('keeps an overflowing adaptive track scrollable and every tab selectable', () => {
  const onChange = jest.fn();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <SegmentedControl
        segments={[...FOUR]}
        value="summary"
        onChange={onChange}
        layout="adaptive"
        testIDPrefix="overflow-tab"
      />,
    );
  });

  act(() => {
    renderer.root.findByProps({ testID: 'overflow-tab-scrollable' }).props.onLayout(layoutEvent(0, 280));
    FOUR.forEach((segment, index) => {
      renderer.root.findByProps({ testID: `overflow-tab-${segment.value}` }).props.onLayout(layoutEvent(index * 120, 120));
    });
  });

  expect(renderer.root.findByProps({ testID: 'overflow-tab-scrollable' })).toBeTruthy();
  FOUR.forEach((segment) => {
    act(() => renderer.root.findByProps({ testID: `overflow-tab-${segment.value}` }).props.onPress());
  });
  expect(onChange.mock.calls.map(([selected]) => selected)).toEqual(FOUR.map((segment) => segment.value));
});

it('calculates equal-fit requirements and clamped LTR/RTL selected offsets', () => {
  expect(equalTrackRequiredWidth([80, 80, 80, 80])).toBe(294);
  const args = { item: { x: 300, width: 80 }, viewportWidth: 200, contentWidth: 500 };
  expect(selectedTabScrollOffset(args)).toBe(240);
  expect(selectedTabScrollOffset({ ...args, isRTL: true })).toBe(60);
  expect(selectedTabScrollOffset({
    item: { x: 0, width: 80 },
    viewportWidth: 200,
    contentWidth: 500,
  })).toBe(0);
});
