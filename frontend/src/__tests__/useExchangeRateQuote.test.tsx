/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../api', () => ({
  ApiError: class ApiError extends Error {
    code: string;
    status?: number;
    detailCode?: string;
    retryable?: boolean;

    constructor(message: string, options: any) {
      super(message);
      this.code = options.code;
      this.status = options.status;
      this.detailCode = options.detailCode;
      this.retryable = options.retryable;
    }
  },
  quoteExchangeRate: jest.fn(),
}));

import * as rateApi from '../api';
import { QuoteInputs, useExchangeRateQuote } from '../useExchangeRateQuote';

type Result = ReturnType<typeof useExchangeRateQuote>;
let latest: Result;
let renderer: any = null;

const automaticQuote: rateApi.ExchangeRateQuote = {
  quote_id: 'q1',
  mode: 'automatic',
  source_amount: '1000.00',
  source_currency: 'INR',
  target_amount: '3520.40',
  target_currency: 'LKR',
  rate: '3.5204',
  requested_date: '2026-08-28',
  effective_rate_date: '2026-08-28',
  provider: 'frankfurter_v2_blended',
  provider_sources: [],
  cache_hit: false,
  stale: false,
  manual: false,
  manual_input_type: null,
  manual_input_value: null,
  requires_confirmation: true,
  expires_at: '2026-08-31T10:30:00Z',
};

const defaults = (overrides: Partial<QuoteInputs> = {}): QuoteInputs => ({
  enabled: true,
  sourceCurrency: 'INR',
  targetCurrency: 'LKR',
  amount: '1000',
  date: '2026-08-28',
  mode: 'automatic',
  manualInputType: 'rate',
  manualValue: '',
  debounceMs: 400,
  ...overrides,
});

function Harness({ inputs }: { inputs: QuoteInputs }) {
  latest = useExchangeRateQuote(inputs);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('debounces a historical quote and exposes success', async () => {
  (rateApi.quoteExchangeRate as jest.Mock).mockResolvedValue(automaticQuote);
  await act(async () => { renderer = TestRenderer.create(<Harness inputs={defaults()} />); });

  expect(latest.status).toBe('loading');
  act(() => jest.advanceTimersByTime(399));
  expect(rateApi.quoteExchangeRate).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  await flush();

  expect(rateApi.quoteExchangeRate).toHaveBeenCalledWith(expect.objectContaining({
    from: 'INR', to: 'LKR', amount: '1000', date: '2026-08-28', mode: 'automatic',
  }), expect.any(AbortSignal));
  expect(latest.status).toBe('success');
  expect(latest.quote?.target_amount).toBe('3520.40');
});

it('aborts an obsolete request and only publishes the latest quote', async () => {
  let resolveFirst!: (quote: rateApi.ExchangeRateQuote) => void;
  let resolveSecond!: (quote: rateApi.ExchangeRateQuote) => void;
  const signals: AbortSignal[] = [];
  (rateApi.quoteExchangeRate as jest.Mock)
    .mockImplementationOnce((_params, signal) => {
      signals.push(signal);
      return new Promise((resolve) => { resolveFirst = resolve; });
    })
    .mockImplementationOnce((_params, signal) => {
      signals.push(signal);
      return new Promise((resolve) => { resolveSecond = resolve; });
    });

  await act(async () => { renderer = TestRenderer.create(<Harness inputs={defaults()} />); });
  act(() => jest.advanceTimersByTime(400));
  await flush();
  await act(async () => {
    renderer?.update(<Harness inputs={defaults({ amount: '2000' })} />);
  });
  expect(signals[0].aborted).toBe(true);
  act(() => jest.advanceTimersByTime(400));
  await flush();

  await act(async () => {
    resolveFirst({ ...automaticQuote, quote_id: 'obsolete' });
    resolveSecond({ ...automaticQuote, quote_id: 'latest', source_amount: '2000.00', target_amount: '7040.80' });
    await Promise.resolve();
  });
  expect(latest.quote?.quote_id).toBe('latest');
  expect(latest.quote?.target_amount).toBe('7040.80');
});

it('passes explicit manual final-amount inputs and exposes retryable errors', async () => {
  const error = new rateApi.ApiError('Provider timed out', {
    code: 'http', status: 503, detailCode: 'exchange_rate_timeout', retryable: true,
  });
  (rateApi.quoteExchangeRate as jest.Mock).mockRejectedValueOnce(error);
  await act(async () => {
    renderer = TestRenderer.create(<Harness inputs={defaults({
      mode: 'manual', manualInputType: 'target_amount', manualValue: '3520.40',
    })} />);
  });
  act(() => jest.advanceTimersByTime(400));
  await flush();

  expect(rateApi.quoteExchangeRate).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'manual', manualInputType: 'target_amount', manualTargetAmount: '3520.40',
  }), expect.any(AbortSignal));
  expect(latest.status).toBe('error');
  expect(latest.error).toMatchObject({ detailCode: 'exchange_rate_timeout', retryable: true });
});

it('does not request a quote for invalid or disabled inputs', async () => {
  await act(async () => {
    renderer = TestRenderer.create(<Harness inputs={defaults({ amount: '0' })} />);
  });
  act(() => jest.advanceTimersByTime(1000));
  expect(latest.status).toBe('idle');
  expect(rateApi.quoteExchangeRate).not.toHaveBeenCalled();

  await act(async () => {
    renderer?.update(<Harness inputs={defaults({ enabled: false })} />);
  });
  act(() => jest.advanceTimersByTime(1000));
  expect(rateApi.quoteExchangeRate).not.toHaveBeenCalled();
});
