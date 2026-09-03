/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform, StyleSheet } from 'react-native';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: { textMain: '#111', textMuted: '#666' } }),
}));

import ResponsiveAmountText, {
  firstFittingCandidate,
  responsiveMoneyCandidates,
  webTextFits,
} from '../ui/ResponsiveAmountText';
import T from '../T';

describe('responsive money presentation', () => {
  it('orders exact, compact, then detached-currency candidates', () => {
    const candidates = responsiveMoneyCandidates(123_456_789, {
      currency: 'INR',
      showCurrency: true,
    });
    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'INR 123,456,789.00',
      'INR 123.46M',
      'INR 123.5M',
      'INR 123M',
      '123.46M',
      '123.5M',
      '123M',
    ]);
    expect(candidates.at(-1)?.detachedCurrency).toBe(true);
  });

  it('uses a whole-number exact candidate for whole-unit settlement amounts', () => {
    const candidates = responsiveMoneyCandidates(1_250, {
      currency: 'LKR',
      showCurrency: true,
      whole: true,
    });
    expect(candidates[0]).toEqual({ text: 'LKR 1,250', detachedCurrency: false });
  });

  it('chooses the first measured fit and otherwise the shortest candidate', () => {
    expect(firstFittingCandidate([false, true, true], 3)).toBe(1);
    expect(firstFittingCandidate([false, false, false], 3)).toBe(2);
  });

  it('detects web text overflow from the rendered box', () => {
    expect(webTextFits({ scrollWidth: 140, clientWidth: 100 }, 100)).toBe(false);
    expect(webTextFits({ scrollWidth: 100, clientWidth: 100 }, 100)).toBe(true);
    expect(webTextFits(null, 100)).toBeNull();
  });

  it('exposes the full exact value to accessibility without an ellipsis', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <ResponsiveAmountText
          value={123_456_789}
          currency="INR"
          label="Spent"
          testID="responsive-money"
        />,
      );
    });
    const root = renderer.root.findAllByProps({ testID: 'responsive-money' })
      .find((node: any) => node.props.accessibilityLabel);
    expect(root).toBeTruthy();
    expect(root.props.accessibilityLabel).toBe('Spent, INR 123,456,789.00');
    const oneLineValues = renderer.root.findAll((node: any) => node.props.numberOfLines === 1);
    expect(oneLineValues.length).toBeGreaterThan(0);
    expect(oneLineValues.every((node: any) => node.props.ellipsizeMode === undefined)).toBe(true);
  });

  it('selects the first one-line native candidate and allows the wrapper to shrink', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <ResponsiveAmountText
          value={123_456_789}
          currency="INR"
          label="Spent"
          testID="native-money"
        />,
      );
    });

    const measurements = renderer.root.findAllByType(T)
      .filter((node: any) => typeof node.props.onTextLayout === 'function');
    expect(measurements).toHaveLength(7);
    act(() => {
      measurements.forEach((node: any, index: number) => node.props.onTextLayout({
        nativeEvent: { lines: index === 0 ? [{}, {}] : [{}] },
      }));
    });

    const visible = renderer.root.findAllByType(T)
      .find((node: any) => node.props.numberOfLines === 1);
    expect(visible?.props.children).toBe('INR 123.46M');
    const root = renderer.root.findAllByProps({ testID: 'native-money' })
      .find((node: any) => node.props.accessibilityLabel);
    expect(StyleSheet.flatten(root.props.style)).toEqual(expect.objectContaining({
      flexShrink: 1,
      minWidth: 0,
      maxWidth: '100%',
    }));
  });

  it('uses visible, progressively shorter candidates when web text overflows', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    let renderer: any;
    try {
      act(() => {
        renderer = TestRenderer.create(
          <ResponsiveAmountText
            value={123_456_789}
            currency="INR"
            label="Budget"
          />,
        );
      });

      const visibleText = () => renderer.root.find(
        (node: any) => node.props.numberOfLines === 1 && node.props.onLayout,
      );
      expect(visibleText().props.children).toBe('INR 123,456,789.00');
      expect(StyleSheet.flatten(visibleText().props.style)?.opacity).not.toBe(0);

      act(() => visibleText().props.onLayout({
        nativeEvent: {
          layout: { x: 0, y: 0, width: 100, height: 28 },
          target: { scrollWidth: 180, clientWidth: 100 },
        },
      }));
      expect(visibleText().props.children).toBe('INR 123.46M');

      act(() => visibleText().props.onLayout({
        nativeEvent: {
          layout: { x: 0, y: 0, width: 100, height: 28 },
          target: { scrollWidth: 86, clientWidth: 100 },
        },
      }));
      expect(StyleSheet.flatten(visibleText().props.style)?.opacity).not.toBe(0);
    } finally {
      if (renderer) act(() => renderer.unmount());
      Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
    }
  });
});
