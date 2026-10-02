/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import * as RN from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: {
  primary: '#123', primaryText: '#fff', textMain: '#111', textMuted: '#555', border: '#999',
} }) }));

import T from '../T';
import Button from '../ui/Button';
import Badge from '../Badge';
import ResponsiveAmountText from '../ui/ResponsiveAmountText';
import TripListCard from '../TripListCard';
import { tripBalanceState } from '../tripBalance';

afterEach(() => jest.restoreAllMocks());

it.each([1, 1.3])('keeps complete text, amounts, and a reachable growing action at scale %s', (fontScale) => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 320, height: 640, scale: 1, fontScale });
  const press = jest.fn();
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<RN.View>
    <T variant="caption" testID="scaled-caption" style={{ lineHeight: 20 }}>A long status message</T>
    <Badge label="Needs review · Pending sync" color="#123" size="status" />
    <ResponsiveAmountText value={-123456789} currency="USD" testID="scaled-amount" />
    <Button label="Review and approve budget overage" fullWidth haptic={false} onPress={press}
      testID="scaled-action" accessibilityLabel="Approve budget: Hotel, INR 100,000, Coast" />
    <TripListCard title="Coast and mountain trip with a long name" currency="INR"
      balance={tripBalanceState(100000)} onPress={press} testID="scaled-trip" />
  </RN.View>); });
  const caption = renderer.root.findAllByType(RN.Text).find((node: any) => node.props.testID === 'scaled-caption');
  const captionStyle = RN.StyleSheet.flatten(caption.props.style);
  expect(caption.props.allowFontScaling).not.toBe(false);
  expect(captionStyle.lineHeight * fontScale).toBeGreaterThanOrEqual(captionStyle.fontSize * fontScale * 1.35);
  const amount = renderer.root.findAllByType(T).find((node: any) => node.props.children === '-$123,456,789');
  expect(amount).toBeTruthy();
  expect(amount.props.numberOfLines).toBeUndefined();
  const label = renderer.root.findAllByType(T).find((node: any) => node.props.children === 'Review and approve budget overage');
  expect(label.props.numberOfLines).toBeUndefined();
  expect(RN.StyleSheet.flatten(label.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
  const action = renderer.root.findAll((node: any) => node.props.testID === 'scaled-action'
    && typeof node.props.onPress === 'function' && node.props.style).at(-1);
  const actionStyle = typeof action.props.style === 'function' ? action.props.style({}) : action.props.style;
  expect(RN.StyleSheet.flatten(actionStyle).minHeight).toBeGreaterThanOrEqual(48);
  act(() => action.props.onPress());
  expect(press).toHaveBeenCalledTimes(1);
  const title = renderer.root.findAllByType(T).find((node: any) => node.props.children === 'Coast and mountain trip with a long name');
  expect(title.props.numberOfLines).toBeUndefined();
  const tripAmount = renderer.root.findAllByType(T).find((node: any) => node.props.children === '₹100,000');
  expect(tripAmount.props.numberOfLines).toBeUndefined();
});

it('passes disabled and capped scaling to native Text without applying it a second time', () => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 320, height: 640, scale: 1, fontScale: 1.3 });
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<RN.View>
    <T allowFontScaling={false} testID="unscaled" style={{ lineHeight: 24 }}>Unscaled</T>
    <T maxFontSizeMultiplier={1.1} testID="capped" style={{ lineHeight: 24 }}>Capped</T>
  </RN.View>); });
  const text = renderer.root.findAllByType(RN.Text);
  expect(RN.StyleSheet.flatten(text.find((node: any) => node.props.testID === 'unscaled').props.style).lineHeight).toBe(24);
  const capped = text.find((node: any) => node.props.testID === 'capped');
  expect(capped.props.maxFontSizeMultiplier).toBe(1.1);
  expect(RN.StyleSheet.flatten(capped.props.style).lineHeight).toBe(24);
});
