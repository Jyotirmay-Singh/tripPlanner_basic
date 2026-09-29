/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#1C3F39', surfaceMuted: '#EDEBE3', border: '#DCD9CE',
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
});
