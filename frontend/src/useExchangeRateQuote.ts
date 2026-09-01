import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  ExchangeRateMode,
  ExchangeRateQuote,
  ManualExchangeInput,
  quoteExchangeRate,
} from './api';

export type QuoteState = 'idle' | 'loading' | 'success' | 'error';

export type QuoteInputs = {
  enabled: boolean;
  sourceCurrency: string;
  targetCurrency: string;
  amount: string;
  date: string | null;
  mode: ExchangeRateMode;
  manualInputType: ManualExchangeInput;
  manualValue: string;
  debounceMs?: number;
};

export function useExchangeRateQuote(inputs: QuoteInputs) {
  const [status, setStatus] = useState<QuoteState>('idle');
  const [quote, setQuote] = useState<ExchangeRateQuote | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const sequence = useRef(0);

  const valid = useMemo(() => {
    const parsedAmount = Number(inputs.amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount === 0 || !inputs.date) return false;
    if (inputs.mode === 'manual') {
      const parsedManual = Number(inputs.manualValue);
      if (!Number.isFinite(parsedManual) || parsedManual <= 0) return false;
    }
    return true;
  }, [inputs.amount, inputs.date, inputs.manualValue, inputs.mode]);

  useEffect(() => {
    const requestSequence = ++sequence.current;
    if (!inputs.enabled || !valid) {
      setStatus('idle');
      setQuote(null);
      setError(null);
      return undefined;
    }

    const controller = new AbortController();
    setStatus('loading');
    setQuote(null);
    setError(null);
    const timer = setTimeout(async () => {
      try {
        const next = await quoteExchangeRate({
          from: inputs.sourceCurrency,
          to: inputs.targetCurrency,
          amount: inputs.amount,
          date: inputs.date,
          mode: inputs.mode,
          manualInputType: inputs.mode === 'manual' ? inputs.manualInputType : null,
          manualRate: inputs.mode === 'manual' && inputs.manualInputType === 'rate'
            ? inputs.manualValue : null,
          manualTargetAmount: inputs.mode === 'manual' && inputs.manualInputType === 'target_amount'
            ? inputs.manualValue : null,
          refresh: false,
        }, controller.signal);
        if (requestSequence !== sequence.current) return;
        setQuote(next);
        setStatus('success');
      } catch (caught) {
        if (requestSequence !== sequence.current) return;
        const nextError = caught instanceof ApiError
          ? caught
          : new ApiError('Could not load an exchange-rate quote', { code: 'network' });
        if (nextError.code === 'aborted') return;
        setError(nextError);
        setStatus('error');
      }
    }, inputs.debounceMs ?? 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    inputs.amount,
    inputs.date,
    inputs.debounceMs,
    inputs.enabled,
    inputs.manualInputType,
    inputs.manualValue,
    inputs.mode,
    inputs.sourceCurrency,
    inputs.targetCurrency,
    retryNonce,
    valid,
  ]);

  const retry = useCallback(() => setRetryNonce((value) => value + 1), []);
  return { status, quote, error, valid, retry };
}
