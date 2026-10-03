/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Keyboard } from 'react-native';
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ mode: 'light', colors: { surface: '#ffffff', surfaceMuted: '#f4f4f4', textMain: '#222222', textMuted: '#666666', primary: '#1C3F39', border: '#bbbbbb' } }) }));
jest.mock('../ui/Icon', () => ({ __esModule: true, default: () => null }));
jest.mock('../ui/Sheet', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => props.visible ? R.createElement('Sheet', props, props.children) : null };
});
import CategoryPicker from '../ui/CategoryPicker';
import { CATEGORIES } from '../categories';
const mounted: any[] = [];
function mount(value = 'Food', disabled = false) {
  let renderer: any;
  const onChange = jest.fn();
  act(() => { renderer = TestRenderer.create(<CategoryPicker value={value} onChange={onChange} disabled={disabled} testID="category" />); });
  mounted.push(renderer);
  const trigger = () => renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').find((node: any) => node.props.testID === 'category')!;
  const open = () => act(() => trigger().props.onPress());
  return { renderer, onChange, trigger, open };
}
beforeEach(() => { jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(null); });
afterEach(() => { act(() => mounted.splice(0).forEach((renderer) => renderer.unmount())); jest.restoreAllMocks(); });
it('shows all 30 exactly once with radio/check states and submits the canonical name', () => {
  const { renderer, onChange, open } = mount(); open();
  const radios = renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').filter((node: any) => node.props.accessibilityRole === 'radio');
  expect(radios).toHaveLength(30);
  expect(radios.find((node: any) => node.props.accessibilityLabel === 'Food').props['aria-checked']).toBe(true);
  expect(radios.map((node: any) => node.props.accessibilityLabel).sort()).toEqual([...CATEGORIES].sort());
  expect(radios.find((node: any) => node.props.accessibilityLabel === 'Food').props.accessibilityState).toEqual({ selected: true, checked: true });
  act(() => renderer.root.find((node: any) => node.props.testID === 'category-search' && typeof node.props.onChangeText === 'function').props.onChangeText('taxi'));
  const result = renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').find((node: any) => node.props.accessibilityRole === 'radio');
  expect(result.props.accessibilityLabel).toBe('Local Transportation');
  act(() => result.props.onPress());
  expect(onChange).toHaveBeenCalledWith('Local Transportation');
  expect(renderer.root.findAllByType('Sheet' as any)).toHaveLength(0);
});
it('cancel preserves the value, clears search, and reopening marks the existing selection', () => {
  const { renderer, onChange, open } = mount('Subscriptions & Memberships'); open();
  act(() => renderer.root.find((node: any) => node.props.testID === 'category-search' && typeof node.props.onChangeText === 'function').props.onChangeText('no-such-category'));
  expect(JSON.stringify(renderer.toJSON())).toContain('No categories found');
  act(() => renderer.root.findByType('Sheet' as any).props.onClose());
  expect(onChange).not.toHaveBeenCalled(); open();
  expect(renderer.root.find((node: any) => node.props.testID === 'category-search' && typeof node.props.onChangeText === 'function').props.value).toBe('');
  const selected = renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').find((node: any) => node.props.accessibilityState?.selected);
  expect(selected.props.accessibilityLabel).toBe('Subscriptions & Memberships');
});
it('selecting the current category closes, and disabled triggers expose their state', () => {
  const { renderer, onChange, open } = mount(); open();
  act(() => renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').find((node: any) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === 'Food')!.props.onPress());
  expect(onChange).toHaveBeenCalledWith('Food');
  expect(renderer.root.findAllByType('Sheet' as any)).toHaveLength(0);
  expect(mount('Food', true).trigger().props.disabled).toBe(true);
});
it('keeps long names untruncated and uses full-width rows at large text', () => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 320, height: 700, scale: 1, fontScale: 2 });
  const { renderer, open } = mount(); open();
  const option = renderer.root.findAll((node: any) => typeof node.props.onPress === 'function').find((node: any) => node.props.accessibilityLabel === 'Subscriptions & Memberships')!;
  expect(option.props.style({}).some((style: any) => style?.minHeight === 64)).toBe(true);
  expect(option.findAll((node: any) => node.props.numberOfLines === 1)).toHaveLength(0);
});

it('native Back dismisses the keyboard first, then cancels without changing selection', () => {
  const listeners: Record<string, () => void> = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
    listeners[event] = listener;
    return { remove: jest.fn() };
  }) as any);
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  const { renderer, onChange, open } = mount(); open();
  act(() => listeners.keyboardDidShow());
  act(() => renderer.root.findByType('Sheet' as any).props.onRequestClose());
  expect(dismiss).toHaveBeenCalled();
  expect(renderer.root.findAllByType('Sheet' as any)).toHaveLength(1);
  act(() => listeners.keyboardDidHide());
  act(() => renderer.root.findByType('Sheet' as any).props.onRequestClose());
  expect(renderer.root.findAllByType('Sheet' as any)).toHaveLength(0);
  expect(onChange).not.toHaveBeenCalled();
});
