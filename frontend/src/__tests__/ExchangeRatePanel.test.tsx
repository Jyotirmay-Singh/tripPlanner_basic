/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';

const mockUseExchangeRateQuote = jest.fn();

jest.mock('../useExchangeRateQuote', () => ({
  useExchangeRateQuote: (inputs: unknown) => mockUseExchangeRateQuote(inputs),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      primary: '#146c94', textMain: '#111111', textMuted: '#666666',
      surface: '#ffffff', surfaceMuted: '#f2f4f5', border: '#dddddd',
      warning: '#a05a00', danger: '#b00020',
    },
  }),
}));
jest.mock('../T', () => {
  const R = require('react');
  const { Text: NativeText } = require('react-native');
  return {
    __esModule: true,
    default: ({ children, ...props }: any) => R.createElement(NativeText, props, children),
  };
});
jest.mock('../ui/Button', () => {
  const R = require('react');
  const { Text: NativeText, TouchableOpacity } = require('react-native');
  return {
    __esModule: true,
    default: ({ label, onPress, testID, disabled }: any) => R.createElement(
      TouchableOpacity,
      { testID, onPress, disabled },
      R.createElement(NativeText, null, label),
    ),
  };
});
jest.mock('../ui/Input', () => {
  const R = require('react');
  const { TextInput: NativeInput } = require('react-native');
  return {
    __esModule: true,
    default: (props: any) => R.createElement(NativeInput, props),
  };
});

import type { ExchangeRateQuote } from '../api';
import ExchangeRatePanel, { type LockedConversion } from '../ui/ExchangeRatePanel';

const automaticQuote: ExchangeRateQuote = {
  quote_id: 'quote-auto',
  mode: 'automatic',
  source_amount: '1000.00',
  source_currency: 'INR',
  target_amount: '3520.40',
  target_currency: 'LKR',
  rate: '3.5204',
  requested_date: '2026-08-30',
  effective_rate_date: '2026-08-28',
  provider: 'frankfurter_v2_blended',
  provider_sources: [],
  cache_hit: true,
  stale: true,
  manual: false,
  manual_input_type: null,
  manual_input_value: null,
  requires_confirmation: true,
  expires_at: '2026-08-31T10:30:00Z',
};

const manualQuote: ExchangeRateQuote = {
  ...automaticQuote,
  quote_id: 'quote-manual',
  mode: 'manual',
  target_amount: '3600.00',
  rate: '3.6',
  effective_rate_date: null,
  provider: 'manual',
  cache_hit: false,
  stale: false,
  manual: true,
  manual_input_type: 'target_amount',
  manual_input_value: '3600.00',
};

const locked: LockedConversion = {
  version: 3,
  sourceAmount: '1000.00',
  sourceCurrency: 'INR',
  targetAmount: 3520.40,
  targetCurrency: 'LKR',
  requestedDate: '2026-08-30',
  effectiveDate: '2026-08-28',
  rate: '3.5204',
  provider: 'frankfurter_v2_blended',
  mode: 'automatic',
  stale: false,
};

function props(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    amount: '1000',
    sourceCurrency: 'INR',
    targetCurrency: 'LKR',
    date: '2026-08-30',
    onApprovalChange: jest.fn(),
    ...overrides,
  } as React.ComponentProps<typeof ExchangeRatePanel>;
}

function textContent(renderer: any): string {
  return renderer.root.findAllByType(Text).map((node: any) => node.props.children).flat(Infinity).join(' ');
}

beforeEach(() => {
  jest.resetAllMocks();
  mockUseExchangeRateQuote.mockReturnValue({
    status: 'idle', quote: null, error: null, valid: true, retry: jest.fn(),
  });
});

it('shows a locked conversion without requiring a new quote for unrelated edits', () => {
  let renderer: any;
  const onRequoteRequiredChange = jest.fn();
  act(() => {
    renderer = TestRenderer.create(
      <ExchangeRatePanel {...props({ locked, onRequoteRequiredChange })} />,
    );
  });

  expect(renderer.root.findByProps({ testID: 'exchange-rate-locked' })).toBeTruthy();
  expect(textContent(renderer)).toContain('LKR 3,520.40');
  expect(textContent(renderer)).toContain('Reference rate from 28 Aug 2026');
  expect(textContent(renderer)).toContain('frankfurter_v2_blended');
  expect(mockUseExchangeRateQuote).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  expect(onRequoteRequiredChange).toHaveBeenLastCalledWith(false);
});

it('approves an automatic cached stale quote and clears approval when an input changes', () => {
  mockUseExchangeRateQuote.mockReturnValue({
    status: 'success', quote: automaticQuote, error: null, valid: true, retry: jest.fn(),
  });
  const onApprovalChange = jest.fn();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <ExchangeRatePanel {...props({ onApprovalChange })} />,
    );
  });

  expect(textContent(renderer)).toContain('cached');
  expect(textContent(renderer)).toContain('stale');
  expect(textContent(renderer)).toContain('frankfurter_v2_blended');
  act(() => renderer.root.findByProps({ testID: 'exchange-rate-approve' }).props.onPress());
  expect(onApprovalChange).toHaveBeenLastCalledWith({
    quote: automaticQuote,
    request: {
      mode: 'automatic', quote_id: 'quote-auto', approved: true, allow_stale: true,
    },
  });

  act(() => {
    renderer.update(
      <ExchangeRatePanel {...props({ amount: '2000', onApprovalChange })} />,
    );
  });
  expect(onApprovalChange).toHaveBeenLastCalledWith(null);
});

it('submits an explicit manual final-amount conversion', () => {
  mockUseExchangeRateQuote.mockImplementation((inputs: any) => ({
    status: inputs.mode === 'manual' && inputs.manualValue === '3600.00' ? 'success' : 'idle',
    quote: inputs.mode === 'manual' && inputs.manualValue === '3600.00' ? manualQuote : null,
    error: null,
    valid: true,
    retry: jest.fn(),
  }));
  const onApprovalChange = jest.fn();
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(
      <ExchangeRatePanel {...props({ onApprovalChange })} />,
    );
  });

  act(() => renderer.root.findByProps({ testID: 'exchange-rate-manual' }).props.onPress());
  act(() => renderer.root.findByProps({ testID: 'exchange-rate-manual-target' }).props.onPress());
  const input = renderer.root.findByType(TextInput);
  act(() => input.props.onChangeText('3600.00'));

  expect(mockUseExchangeRateQuote).toHaveBeenLastCalledWith(expect.objectContaining({
    mode: 'manual', manualInputType: 'target_amount', manualValue: '3600.00',
  }));
  act(() => renderer.root.findByProps({ testID: 'exchange-rate-approve' }).props.onPress());
  expect(onApprovalChange).toHaveBeenLastCalledWith({
    quote: manualQuote,
    request: {
      mode: 'manual', quote_id: 'quote-manual', approved: true, allow_stale: false,
      manual_input_type: 'target_amount', manual_target_amount: '3600.00',
    },
  });
});

it('shows a retryable provider error and invokes retry', () => {
  const retry = jest.fn();
  mockUseExchangeRateQuote.mockReturnValue({
    status: 'error', quote: null,
    error: { message: 'Exchange-rate provider timed out', retryable: true },
    valid: true, retry,
  });
  let renderer: any;
  act(() => {
    renderer = TestRenderer.create(<ExchangeRatePanel {...props()} />);
  });

  expect(renderer.root.findByProps({ testID: 'exchange-rate-error' })).toBeTruthy();
  expect(textContent(renderer)).toContain('Exchange-rate provider timed out');
  act(() => renderer.root.findByProps({ testID: 'exchange-rate-retry' }).props.onPress());
  expect(retry).toHaveBeenCalledTimes(1);
});
