/* eslint-disable import/first */
import React from 'react';
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
  chooseTripCardLayout,
  shouldUseFullBalanceRow,
  tripCardAccessibilityLabel,
} from '../TripListCard';
import { tripBalanceState } from '../tripBalance';

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
    expect(chooseTripCardLayout(272, 110, 1)).toBe('stacked');
    expect(chooseTripCardLayout(312, 110, 1)).toBe('stacked');
    expect(chooseTripCardLayout(345, 110, 1)).toBe('stacked');
    expect(chooseTripCardLayout(364, 110, 1)).toBe('stacked');
    expect(chooseTripCardLayout(432, 110, 1)).toBe('inline');
    expect(chooseTripCardLayout(432, 220, 1)).toBe('stacked');
    expect(chooseTripCardLayout(432, 143, 1.3)).toBe('stacked');
    expect(chooseTripCardLayout(640, 110, 1.5)).toBe('stacked');
    expect(chooseTripCardLayout(640, 110, 2)).toBe('stacked');
  });

  it('builds a single clear TalkBack relationship label', () => {
    expect(tripCardAccessibilityLabel('Lakshadweep', tripBalanceState(1250), 'INR'))
      .toBe("Lakshadweep, you're owed, INR 1,250.00");
    expect(tripCardAccessibilityLabel('Goa', tripBalanceState(0), 'INR'))
      .toBe('Goa, settled');
  });

  it('reclaims the icon indentation only when the exact amount needs the space', () => {
    expect(shouldUseFullBalanceRow(272, 150, 1)).toBe(false);
    expect(shouldUseFullBalanceRow(272, 180, 1)).toBe(true);
    expect(shouldUseFullBalanceRow(432, 143, 1.3)).toBe(false);
    expect(shouldUseFullBalanceRow(640, 110, 1.5)).toBe(true);
    expect(shouldUseFullBalanceRow(640, 110, 2)).toBe(true);
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
      .find((node: any) => node.props.children === '1,250.00');
    expect(amount?.props.color).toBe(mockColors.success);
    expect(renderer.root.findAllByType(T).some((node: any) => node.props.children === "You're owed"))
      .toBe(true);

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
      .find((node: any) => node.props.children === '800.00');
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
      label: 'Settled', color: mockColors.success, textColor: mockColors.textMain,
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
    expect(texts).toContain('12,345,678.90');
    expect(texts.some((value: unknown) => typeof value === 'string' && /[KMB]$/.test(value)))
      .toBe(false);
  });
});
