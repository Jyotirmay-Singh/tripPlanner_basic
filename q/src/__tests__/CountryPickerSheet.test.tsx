/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Input: stub('Input'),
    Icon: stub('Icon'),
    Sheet: (props: any) => props.visible ? R.createElement('Sheet', props, props.children) : null,
  };
});

import CountryPickerSheet from '../CountryPickerSheet';

const mounted: any[] = [];
const hosts = (renderer: any, testID: string) => renderer.root.findAll(
  (candidate: any) => typeof candidate.type === 'string' && candidate.props.testID === testID,
);
const interactive = (renderer: any, testID: string) => renderer.root.findAll(
  (candidate: any) => candidate.props.testID === testID
    && typeof candidate.props.onPress === 'function',
)[0];

function mount(overrides: Record<string, unknown> = {}) {
  let renderer: any;
  const props = {
    visible: true,
    selected: 'IN' as const,
    onSelect: jest.fn(),
    onClose: jest.fn(),
    ...overrides,
  };
  act(() => { renderer = TestRenderer.create(<CountryPickerSheet {...props} />); });
  mounted.push(renderer);
  return { renderer, props };
}

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
});

describe('mobile country picker', () => {
  it('marks the selected country and selects with a single close', async () => {
    const { renderer, props } = mount();
    const search = renderer.root.findByProps({ testID: 'mobile-country-search' });
    await act(async () => {
      search.props.onChangeText('India');
      await Promise.resolve();
    });
    const india = hosts(renderer, 'mobile-country-IN')[0];

    expect(india.props.accessibilityState).toEqual({ selected: true });
    await act(async () => {
      search.props.onChangeText('Japan');
      await Promise.resolve();
    });
    act(() => interactive(renderer, 'mobile-country-JP').props.onPress());

    expect(props.onSelect).toHaveBeenCalledWith('JP');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('filters by dial code and exposes an accessible empty result', async () => {
    const { renderer } = mount();
    const search = renderer.root.findByProps({ testID: 'mobile-country-search' });

    await act(async () => {
      search.props.onChangeText('+44');
      await Promise.resolve();
    });
    expect(hosts(renderer, 'mobile-country-GB')).toHaveLength(1);
    expect(hosts(renderer, 'mobile-country-US')).toHaveLength(0);

    await act(async () => {
      search.props.onChangeText('no-country-has-this-name');
      await Promise.resolve();
    });
    expect(hosts(renderer, 'mobile-country-empty')).toHaveLength(1);
  });
});
