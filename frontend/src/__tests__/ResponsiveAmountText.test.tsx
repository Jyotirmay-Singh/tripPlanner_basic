/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: { textMain: '#111', textMuted: '#666' } }),
}));

import ResponsiveAmountText, { responsiveMoneyCandidates } from '../ui/ResponsiveAmountText';
import T from '../T';

describe('responsive whole-money presentation', () => {
  it('offers only the complete value, including when visually hiding currency', () => {
    expect(responsiveMoneyCandidates(4_123, { currency: 'INR' })).toEqual([
      { text: '₹4,123', detachedCurrency: false },
    ]);
    expect(responsiveMoneyCandidates(4_987, {
      currency: 'INR', showCurrency: false,
    })).toEqual([{ text: '4,987', detachedCurrency: false }]);
  });

  it('keeps two formerly identical compact values visually distinct', () => {
    expect(responsiveMoneyCandidates(4_123, { showCurrency: false })[0].text).toBe('4,123');
    expect(responsiveMoneyCandidates(4_987, { showCurrency: false })[0].text).toBe('4,987');
  });

  it('wraps instead of truncating and exposes an ISO accessibility label', () => {
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
    const root = renderer!.root.findAllByProps({ testID: 'responsive-money' })
      .find((node: any) => node.props.accessibilityLabel);
    expect(root).toBeTruthy();
    expect(root!.props.accessibilityLabel).toBe('Spent, INR 123,456,789');
    const visible = renderer!.root.findByType(T);
    expect(visible.props.children).toBe('₹123,456,789');
    expect(visible.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(visible.props.style)).toEqual(expect.objectContaining({
      flexShrink: 1,
      textAlign: 'right',
    }));
    expect(StyleSheet.flatten(root!.props.style)).toEqual(expect.objectContaining({
      minWidth: 0,
      maxWidth: '100%',
    }));
  });

  it('preserves multi-character and Arabic symbols', () => {
    expect(responsiveMoneyCandidates(12_345, { currency: 'SGD' })[0].text).toBe('S$12,345');
    expect(responsiveMoneyCandidates(12_345, { currency: 'AED' })[0].text).toBe('د.إ12,345');
  });
});
