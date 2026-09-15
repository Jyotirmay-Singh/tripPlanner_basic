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
  return { Icon: (props: any) => R.createElement('Icon', props) };
});
jest.mock('../CountryPickerSheet', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => R.createElement('CountryPickerSheet', props),
  };
});

import MobileNumberInput from '../MobileNumberInput';

describe('MobileNumberInput', () => {
  it('uses phone affordances and adopts an E.164 paste country', () => {
    const onChange = jest.fn();
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <MobileNumberInput value="" country="IN" onChange={onChange} />,
      );
    });
    const input = renderer.root.findByProps({ testID: 'mobile-number-input' });

    expect(input.props).toEqual(expect.objectContaining({
      keyboardType: 'phone-pad',
      textContentType: 'telephoneNumber',
      autoComplete: 'tel',
      accessibilityLabel: 'Mobile number',
    }));
    act(() => input.props.onChangeText('+1 415 555 2671'));
    expect(onChange).toHaveBeenCalledWith('(415) 555-2671', 'US');
  });

  it('opens the picker, applies a selection, and exposes inline errors accessibly', () => {
    const onChange = jest.fn();
    let renderer: any;
    act(() => {
      renderer = TestRenderer.create(
        <MobileNumberInput
          value="98765 43210"
          country="IN"
          onChange={onChange}
          error="Number is already used on Kerala"
        />,
      );
    });

    const trigger = renderer.root.findByProps({ testID: 'mobile-country-trigger' });
    expect(trigger.props.accessibilityLabel).toContain('India');
    act(() => trigger.props.onPress());
    const picker = renderer.root.findByType('CountryPickerSheet' as any);
    expect(picker.props.visible).toBe(true);
    act(() => picker.props.onSelect('US'));
    expect(onChange).toHaveBeenCalledWith('(987) 654-3210', 'US');

    const error = renderer.root.findByProps({ testID: 'mobile-number-error' });
    expect(error.props.accessibilityRole).toBe('alert');
    expect(error.props.accessibilityLiveRegion).toBe('polite');
    expect(renderer.root.findByProps({ testID: 'mobile-number-input' }).props.accessibilityState)
      .toEqual(expect.objectContaining({ invalid: true }));
  });
});
