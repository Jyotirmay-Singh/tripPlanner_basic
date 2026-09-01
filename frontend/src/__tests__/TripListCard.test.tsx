/* eslint-disable import/first */
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockColors = {
  background: '#0A0D0C', surface: '#121715', surfaceMuted: '#1A221F',
  primary: '#87C0B2', primaryText: '#0A0D0C', textMain: '#F7F5F0',
  textMuted: '#8EA39D', border: '#24302C', success: '#8FC98F', danger: '#FF8A66',
};

jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: mockColors, mode: 'dark' }) }));

import Badge from '../Badge';
import T from '../T';
import TripListCard, {
  chooseTripAmountSize,
  chooseTripCardLayout,
  tripCardAccessibilityLabel,
} from '../TripListCard';
import { tripBalanceState } from '../tripBalance';
import { TYPESCALE } from '../theme';

const baseProps = {
  title: 'Lakshadweep',
  subtitle: '12/11/2026 – 19/11/2026 · INR · Budget 100000',
  meta: '17 individuals across 4 families · Code UCK3RZ',
  currency: 'INR',
  onPress: jest.fn(),
  testID: 'trip-item-t1',
  balanceTestID: 'trip-balance-t1',
};

describe('TripListCard responsive layout', () => {
  it('keeps fitting content inline and stacks narrow or accessibility-scaled content', () => {
    // Card widths below correspond to 320/360/393/412/480dp viewports with 24dp gutters.
    expect(chooseTripCardLayout(272, 110, 1)).toBe('bottom');
    expect(chooseTripCardLayout(312, 110, 1)).toBe('bottom');
    expect(chooseTripCardLayout(345, 110, 1)).toBe('trailing');
    expect(chooseTripCardLayout(364, 110, 1)).toBe('trailing');
    expect(chooseTripCardLayout(432, 110, 1)).toBe('trailing');
    expect(chooseTripCardLayout(432, 220, 1)).toBe('bottom');
    expect(chooseTripCardLayout(345, 143, 1.3)).toBe('bottom');
    expect(chooseTripCardLayout(432, 143, 1.3)).toBe('trailing');
    expect(chooseTripCardLayout(640, 110, 1.5)).toBe('bottom');
    expect(chooseTripCardLayout(640, 110, 2)).toBe('bottom');
  });

  it('builds a single clear TalkBack relationship label', () => {
    expect(tripCardAccessibilityLabel('Lakshadweep', tripBalanceState(1250), 'INR'))
      .toBe("Lakshadweep, you're owed INR 1,250.00");
    expect(tripCardAccessibilityLabel('Goa', tripBalanceState(0), 'INR'))
      .toBe('Goa, settled');
    expect(tripCardAccessibilityLabel('Offline trip', tripBalanceState(null), 'USD'))
      .toBe('Offline trip, balance unavailable');
  });

  it('keeps the exact amount and selects the largest existing type token that fits', () => {
    expect(chooseTripAmountSize(240, { lg: 220, base: 180, xs: 150 })).toBe('lg');
    expect(chooseTripAmountSize(200, { lg: 220, base: 180, xs: 150 })).toBe('base');
    expect(chooseTripAmountSize(140, { lg: 220, base: 180, xs: 150 })).toBe('xs');
    expect(chooseTripAmountSize(0, { lg: 220, base: 180, xs: 150 })).toBe('lg');
  });
});

describe('TripListCard balance states', () => {
  it('renders positive credit text in green and keeps the whole card tappable', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard {...baseProps} balance={tripBalanceState(1250)} />,
      );
    });

    const amount = renderer.root.findAllByType(T)
      .find((node: any) => node.props.children === 'INR 1,250.00');
    expect(amount?.props.color).toBe(mockColors.success);
    expect(amount?.props).toMatchObject({
      numberOfLines: 1,
      adjustsFontSizeToFit: true,
      minimumFontScale: 0.85,
    });
    const balanceLabel = renderer.root.findAllByType(T)
      .find((node: any) => node.props.children === "You're owed" && node.props.muted);
    expect(StyleSheet.flatten(balanceLabel?.props.style).fontSize).toBe(TYPESCALE.micro);
    expect(StyleSheet.flatten(amount?.props.style).fontSize).toBe(TYPESCALE.md);

    const card = renderer.root.findAll((node: any) => (
      node.props.testID === 'trip-item-t1' && typeof node.props.onPress === 'function'
    )).at(-1);
    act(() => card.props.onPress());
    expect(baseProps.onPress).toHaveBeenCalledTimes(1);
  });

  it('renders an absolute debit amount in coral without a minus sign', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard {...baseProps} balance={tripBalanceState(-800)} />,
      );
    });
    const amount = renderer.root.findAllByType(T)
      .find((node: any) => node.props.children === 'INR 800.00');
    expect(amount?.props.color).toBe(mockColors.danger);
    expect(renderer.root.findAllByType(T).some((node: any) => node.props.children === 'You owe'))
      .toBe(true);
  });

  it('renders only the accessible Settled chip for zero', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard {...baseProps} settledTestID="trip-settled-t1" balance={tripBalanceState(0)} />,
      );
    });
    const badge = renderer.root.findByType(Badge);
    expect(badge.props).toMatchObject({
      label: 'Settled', color: mockColors.success, textColor: mockColors.textMain, size: 'status',
    });
    expect(renderer.root.findAllByType(T).some((node: any) => node.props.children === '0.00'))
      .toBe(false);
  });

  it('keeps a very large exact amount visible without compact notation or ellipsis', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard {...baseProps} balance={tripBalanceState(12_345_678.9)} />,
      );
    });
    const texts = renderer.root.findAllByType(T).map((node: any) => node.props.children);
    expect(texts).toContain('INR 12,345,678.90');
    expect(texts).not.toContain('INR');
    expect(texts.some((value: unknown) => typeof value === 'string' && /[KMB]$/.test(value)))
      .toBe(false);
  });

  it('keeps optional metadata bounded and removes absent rows without placeholders', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard
          {...baseProps}
          subtitle="A deliberately long date, currency, and budget description"
          meta={undefined}
          balance={tripBalanceState(25)}
        />,
      );
    });

    const subtitle = renderer.root.findAllByType(T)
      .find((node: any) => node.props.children === 'A deliberately long date, currency, and budget description');
    expect(subtitle?.props.numberOfLines).toBe(2);
    expect(renderer.root.findAllByType(T).some((node: any) => node.props.children === baseProps.meta))
      .toBe(false);
  });

  it('bounds long names and participant summaries without changing the balance text', () => {
    const longTitle = 'An exceptionally long multi-region trip name that needs to reflow';
    const longMeta = '123 individuals across 20 families and 43 singles · Code LONGCODE';
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard
          {...baseProps}
          title={longTitle}
          meta={longMeta}
          balance={tripBalanceState(0.01)}
        />,
      );
    });

    const textNodes = renderer.root.findAllByType(T);
    expect(textNodes.find((node: any) => node.props.children === longTitle)?.props.numberOfLines)
      .toBe(2);
    expect(textNodes.find((node: any) => node.props.children === longMeta)?.props.numberOfLines)
      .toBe(2);
    expect(textNodes.some((node: any) => node.props.children === 'INR 0.01')).toBe(true);
  });

  it('keeps the grouped balance non-interactive and hidden from duplicate accessibility focus', () => {
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <TripListCard {...baseProps} balance={tripBalanceState(1250)} />,
      );
    });

    const balance = renderer.root.findAllByProps({ testID: 'trip-balance-t1' })
      .find((node: any) => node.props.pointerEvents === 'none');
    expect(balance?.props).toMatchObject({
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
  });
});
