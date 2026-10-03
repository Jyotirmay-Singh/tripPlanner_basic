
/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Platform } from 'react-native';
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ mode: 'light', colors: { surface: '#ffffff', textMain: '#222222', textMuted: '#666666', primary: '#1C3F39', border: '#cccccc' } }) }));
jest.mock('react-native-svg', () => {
  const R = require('react'); const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { __esModule: true, default: stub('Svg'), G: stub('G'), Path: stub('Path'), Circle: stub('Circle'), Text: stub('SvgText') };
});
jest.mock('../ui/CategoryBadge', () => ({ __esModule: true, default: () => null }));
jest.mock('../ui/Icon', () => ({ __esModule: true, default: () => null }));
import CategorySpendingChart from '../CategorySpendingChart';
import DonutChart from '../DonutChart';
import { CATEGORIES } from '../categories';
import { groupA } from './fixtures/fixedCategoryGroups';
const mounted: any[] = [];
const originalOS = Platform.OS;
beforeEach(() => Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' }));
afterEach(() => { act(() => mounted.splice(0).forEach((r) => r.unmount())); Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS }); });
function mount(items: { category: string; amount: number }[] = groupA, complete = true, onCategoryPress = jest.fn()) {
  let renderer: any; act(() => { renderer = TestRenderer.create(<CategorySpendingChart expenses={items} complete={complete} currency="INR" onCategoryPress={onCategoryPress} />); });
  mounted.push(renderer); return renderer;
}
const actionable = (r: any, id: string) => r.root.findAll((n: any) => n.props.testID === id && typeof n.props.onPress === 'function')[0];
it.each([1, 2, 5, 30])('renders exactly %i used categories with matching real slices, legend values and actions', (count) => {
  const items = CATEGORIES.slice(0, count).map((category, i) => ({ category, amount: (i + 1) * 10 }));
  const onPress = jest.fn(); const renderer = mount(items, true, onPress);
  const chart = renderer.root.findByType(DonutChart);
  const shapes = renderer.root.findAll((n: any) => typeof n.type === 'string' && String(n.props.testID).startsWith('donut-slice-'));
  expect(shapes).toHaveLength(count); expect(shapes.every((n: any) => n.type === (count === 1 ? 'Circle' : 'Path'))).toBe(true);
  expect(chart.props.centerValue).toBe(`₹${(count * (count + 1) * 5).toLocaleString('en-US')}`);
  expect(chart.props.data.map((s: any) => s.key).sort()).toEqual(items.map((e) => e.category).sort());
  for (const slice of chart.props.data) {
    const shape = shapes.find((n: any) => n.props.testID === `donut-slice-${slice.key}`);
    const legend = actionable(renderer, `donut-legend-${slice.key}`);
    expect(shape.props.fill).toBe(slice.color);
    expect(slice.value).toBe(items.find((e) => e.category === slice.key)!.amount);
    expect(legend.props.accessibilityLabel).toContain(slice.label);
    expect(legend.props.accessibilityLabel).toContain(`INR ${slice.value}`);
    act(() => shape.props.onPress()); expect(onPress).toHaveBeenLastCalledWith(slice.key);
    act(() => legend.props.onPress()); expect(onPress).toHaveBeenLastCalledWith(slice.key);
  }
  for (const unused of CATEGORIES.slice(count)) expect(actionable(renderer, `donut-legend-${unused}`)).toBeUndefined();
});
it('keeps fully refunded positive slices, excludes zero/refund-only slices, and routes their net rows', () => {
  const onPress = jest.fn(); const r = mount([...groupA, { category: 'Pets', amount: 0 }], true, onPress);
  expect(r.root.findByType(DonutChart).props.data.map((s: any) => [s.key, s.value])).toEqual([['Food', 1000], ['Travel', 500]]);
  expect(r.root.findByType(DonutChart).props.centerLabel).toBe('Gross spending');
  expect(r.root.findByType(DonutChart).props.centerValue).toBe('₹1,500');
  expect(JSON.stringify(r.toJSON())).toContain('₹800');
  const refund = actionable(r, 'category-net-Bank Fees & Interest');
  expect(refund.props.accessibilityLabel).toBe('Bank Fees & Interest, refunds INR 200, net INR -200');
  act(() => refund.props.onPress()); expect(onPress).toHaveBeenLastCalledWith('Bank Fees & Interest');
  expect(actionable(r, 'donut-legend-Pets')).toBeUndefined();
});
it('preserves a historical label in both real slice and legend navigation', () => {
  const onPress = jest.fn(); const r = mount([{ category: 'Historical category', amount: 7 }], true, onPress);
  act(() => actionable(r, 'donut-legend-Historical category').props.onPress());
  expect(onPress).toHaveBeenCalledWith('Historical category');
  expect(r.root.findByType(DonutChart).props.data[0].label).toBe('Historical category');
});
it('withholds slices, legends and financial claims for an unverified read', () => {
  const r = mount(groupA, false);
  expect(r.root.findAllByType(DonutChart)).toHaveLength(0);
  expect(JSON.stringify(r.toJSON())).toContain('Category totals need a complete refresh');
  expect(JSON.stringify(r.toJSON())).not.toMatch(/1,500|₹800|₹700/);
});
it('shows refund-only, zero and empty states without a pie or spending legend', () => {
  const refund = mount([{ category: 'Other', amount: -200 }]);
  expect(refund.root.findAllByType(DonutChart)).toHaveLength(0);
  expect(JSON.stringify(refund.toJSON())).toContain('No positive spending in this view');
  for (const items of [[], [{ category: 'Other', amount: 0 }]]) expect(JSON.stringify(mount(items).toJSON())).toContain('No spending yet');
});
