/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
//
// Verifies the category drill-down affordances in src/DonutChart.tsx are reachable:
//  - every legend row (the reliable cross-platform TouchableOpacity) fires onSlicePress;
//  - a multi-slice arc <Path> fires onSlicePress;
//  - a SINGLE-slice donut ring (<Circle>) now exposes onPress (the bug: it previously had none,
//    so a lone category was never tappable on any platform).
// react-native-svg is stubbed to host elements so testIDs + onPress pass straight through.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';

jest.mock('react-native-svg', () => {
  const R = require('react');
  const h = (name: string) => (p: any) => R.createElement(name, p, p && p.children);
  return { __esModule: true, default: h('Svg'), G: h('G'), Path: h('Path'), Circle: h('Circle'), Text: h('SvgText') };
});
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});

import DonutChart, { type DonutSlice } from '../DonutChart';

// A node carrying this testID that ALSO owns a callable onPress (uniquely the pressable element,
// not the host output TouchableOpacity forwards testID to).
const pressable = (r: any, id: string) =>
  r.root.find((n: any) => n.props && n.props.testID === id && typeof n.props.onPress === 'function');
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id && typeof n.props.onPress === 'function').length > 0;

const MULTI: DonutSlice[] = [
  { key: 'Food', label: 'Food', value: 60, color: '#a' },
  { key: 'Fuel', label: 'Fuel', value: 40, color: '#b' },
];
const SINGLE: DonutSlice[] = [{ key: 'Food', label: 'Food', value: 100, color: '#a' }];

function mount(data: DonutSlice[], onSlicePress: (s: DonutSlice) => void) {
  let r: any;
  act(() => { r = TestRenderer.create(React.createElement(DonutChart, { data, onSlicePress })); });
  return r;
}

const setPlatform = (os: 'android' | 'web') => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
};

const originalOS = Platform.OS;
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
});

describe('DonutChart drill-down affordances', () => {
  it('web: fires onSlicePress from a multi-slice arc Path', () => {
    setPlatform('web');
    const onPress = jest.fn();
    const r = mount(MULTI, onPress);
    act(() => { pressable(r, 'donut-slice-Food').props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0][0].key).toBe('Food');
  });

  it('fires onSlicePress from a legend row', () => {
    setPlatform('android');
    const onPress = jest.fn();
    const r = mount(MULTI, onPress);
    act(() => { pressable(r, 'donut-legend-Fuel').props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0][0].key).toBe('Fuel');
  });

  it('native: hit-tests the tapped slice from the touch location', () => {
    setPlatform('android');
    // On native the SVG per-shape onPress doesn't fire, so a Pressable over the donut resolves the
    // slice by angle. Food spans 0–216°; a point mid-wedge (~108°) inside the ring band → Food.
    const onPress = jest.fn();
    const r = mount(MULTI, onPress);
    act(() => {
      pressable(r, 'donut-press').props.onPress({ nativeEvent: { locationX: 193.7, locationY: 137.2 } });
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0][0].key).toBe('Food');
  });

  it('native: a tap in the center hole (inside the ring) drills into nothing', () => {
    setPlatform('android');
    const onPress = jest.fn();
    const r = mount(MULTI, onPress);
    act(() => {
      pressable(r, 'donut-press').props.onPress({ nativeEvent: { locationX: 110, locationY: 110 } });
    });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('native: the overlay handles a single-slice ring and SVG shapes cannot intercept it', () => {
    setPlatform('android');
    const onPress = jest.fn();
    const r = mount(SINGLE, onPress);
    expect(has(r, 'donut-slice-Food')).toBe(false);
    act(() => {
      pressable(r, 'donut-press').props.onPress({ nativeEvent: { locationX: 110, locationY: 5 } });
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0][0].key).toBe('Food');
  });

  it('web: a single-slice Circle remains directly tappable', () => {
    setPlatform('web');
    const onPress = jest.fn();
    const r = mount(SINGLE, onPress);
    expect(has(r, 'donut-slice-Food')).toBe(true);
    act(() => { pressable(r, 'donut-slice-Food').props.onPress(); });
    expect(onPress).toHaveBeenCalledWith(expect.objectContaining(SINGLE[0]));
  });

  it('native: ignores malformed press coordinates instead of navigating', () => {
    setPlatform('android');
    const onPress = jest.fn();
    const r = mount(MULTI, onPress);
    act(() => {
      pressable(r, 'donut-press').props.onPress({ nativeEvent: { locationX: undefined, locationY: 5 } });
    });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('keeps the exact chart total and legend amount in accessibility labels', () => {
    setPlatform('android');
    let r: any;
    act(() => {
      r = TestRenderer.create(
        <DonutChart
          data={SINGLE}
          centerValue="123.46M"
          centerLabel="INR"
          centerAccessibilityLabel="Total spent, INR 123,456,789.00"
          onSlicePress={jest.fn()}
        />,
      );
    });

    expect(r.root.findByType('Svg' as any).props.accessibilityLabel)
      .toBe('Total spent, INR 123,456,789.00');
    expect(pressable(r, 'donut-legend-Food').props.accessibilityLabel)
      .toBe('Show Food transactions, 100.00');
  });
});
