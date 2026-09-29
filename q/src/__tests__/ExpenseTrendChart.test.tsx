/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1C3F39', chartPersonal: '#A56B2A', surfaceMuted: '#EDEBE3', border: '#DCD9CE',
      textMain: '#121A18', textMuted: '#5C6B67', danger: '#E05D3D',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ui/SegmentedControl', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('SegmentedControl', {
    ...props, testID: `${props.testIDPrefix}-adaptive`,
  }) };
});
jest.mock('../ui/IconButton', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('IconButton', props) };
});

import ExpenseTrendChart from '../ExpenseTrendChart';

function byTestID(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.find((node) => node.props.testID === testID);
}

describe('ExpenseTrendChart', () => {
  it('switches one plot between daily, weekly and monthly amounts and pages to older spending', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ExpenseTrendChart
          expenses={[
            { date: '01-09-26', amount: 10 },
            { date: '07-09-26', amount: 20 },
            { date: '08-09-26', amount: 50 },
          ]}
          currency="INR"
        />,
      );
    });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹50');

    act(() => { byTestID(renderer.root, 'expense-trend-bar-2026-09-07').props.onPress(); });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹20');

    act(() => { byTestID(renderer.root, 'expense-trend-previous').props.onPress(); });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹10');

    act(() => { byTestID(renderer.root, 'expense-trend-period-adaptive').props.onChange('weekly'); });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹70');
    const weekBars = byTestID(renderer.root, 'expense-trend-chart').findAll(
      (node) => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('expense-trend-bar-'),
    );
    expect(new Set(weekBars.map((node) => node.props.testID)).size).toBe(6);

    act(() => { byTestID(renderer.root, 'expense-trend-period-adaptive').props.onChange('monthly'); });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹80');
  });

  it('shows a helpful empty state when a trip has no transactions', () => {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<ExpenseTrendChart expenses={[]} currency="INR" />); });
    expect(byTestID(renderer.root, 'expense-trend-empty')).toBeTruthy();
  });

  it('keeps the latest selected bar visible at narrow phone widths', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ExpenseTrendChart expenses={[
        { date: '01-09-26', amount: 10 }, { date: '08-09-26', amount: 50 },
      ]} currency="INR" />);
    });
    act(() => {
      byTestID(renderer.root, 'expense-trend-chart').props.onLayout({ nativeEvent: { layout: { width: 220 } } });
    });
    const bars = renderer.root.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith('expense-trend-bar-'));
    expect(new Set(bars.map((node) => node.props.testID)).size).toBe(5);
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹50');
  });

  it('shows the family-paid amount as an inset of the same trip bar', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ExpenseTrendChart
          expenses={[
            { date: '08-09-26', amount: 8000, paid_by_member_id: 'other' },
            { date: '08-09-26', amount: 2000, paid_by_member_id: 'family' },
          ]}
          currency="INR"
          personalMemberId="family"
          personalKind="family"
        />,
      );
    });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹10,000');
    expect(byTestID(renderer.root, 'expense-trend-personal-amount').props.children).toBe('₹2,000');
    expect(renderer.root.findAll((node) => node.props.children === 'Your family paid')).not.toHaveLength(0);
    const tripBar = StyleSheet.flatten(byTestID(renderer.root, 'expense-trend-total-bar-2026-09-08').props.style);
    const familyBar = StyleSheet.flatten(byTestID(renderer.root, 'expense-trend-personal-bar-2026-09-08').props.style);
    expect(familyBar.height).toBeCloseTo(tripBar.height / 5);
    expect(familyBar.backgroundColor).toBe('#A56B2A');
    expect(byTestID(renderer.root, 'expense-trend-bar-2026-09-08').props.accessibilityLabel)
      .toContain('your family paid net');
  });

  it('keeps personal refunds visible below the baseline when trip net spending is positive', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ExpenseTrendChart
          expenses={[
            { date: '08-09-26', amount: 100, paid_by_member_id: 'other' },
            { date: '08-09-26', amount: -20, paid_by_member_id: 'me' },
          ]}
          currency="INR"
          personalMemberId="me"
        />,
      );
    });
    expect(byTestID(renderer.root, 'expense-trend-selected-amount').props.children).toBe('₹80');
    expect(byTestID(renderer.root, 'expense-trend-personal-amount').props.children).toBe('-₹20');
    const familyBar = StyleSheet.flatten(byTestID(renderer.root, 'expense-trend-personal-bar-2026-09-08').props.style);
    expect(familyBar.top).toBeGreaterThan(0);
    expect(familyBar.bottom).toBeUndefined();
  });
});
