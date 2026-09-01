import type { ExpenseConversionRequest } from './api';
import type { SplitMode } from './SplitModeSelector';

type Payload = Record<string, any>;

export function createExpenseAmountFields({
  multiCurrencyEnabled,
  originalAmount,
  sourceCurrency,
  tripCurrency,
  approvedConversion,
}: {
  multiCurrencyEnabled: boolean;
  originalAmount: number;
  sourceCurrency: string;
  tripCurrency: string;
  approvedConversion?: ExpenseConversionRequest | null;
}): Payload {
  if (!multiCurrencyEnabled) {
    return { amount: originalAmount, currency: sourceCurrency };
  }
  const fields: Payload = {
    original_amount: String(originalAmount),
    original_currency: sourceCurrency,
  };
  if (sourceCurrency !== tripCurrency && approvedConversion) {
    fields.conversion = approvedConversion;
  }
  return fields;
}

export function applyExpenseEditConversionContract({
  body: initialBody,
  multiCurrencyEnabled,
  originalAmount,
  sourceCurrency,
  conversionInputsChanged,
  amountChanged,
  currencyChanged,
  dateChanged,
  splitMode,
  exactChanged,
  originalCustomAmounts,
  approvedConversion,
  expectedConversionVersion,
}: {
  body: Payload;
  multiCurrencyEnabled: boolean;
  originalAmount: number;
  sourceCurrency: string;
  conversionInputsChanged: boolean;
  amountChanged: boolean;
  currencyChanged: boolean;
  dateChanged: boolean;
  splitMode: SplitMode;
  exactChanged: boolean;
  originalCustomAmounts: Record<string, number> | null;
  approvedConversion?: ExpenseConversionRequest | null;
  expectedConversionVersion: number;
}): Payload {
  const body = { ...initialBody };
  if (multiCurrencyEnabled) {
    delete body.amount;
    delete body.currency;
    delete body.custom_amounts;
    if (conversionInputsChanged) {
      body.original_amount = String(originalAmount);
      body.original_currency = sourceCurrency;
    } else {
      delete body.date;
    }
    if (approvedConversion) body.conversion = approvedConversion;
    if (exactChanged) body.original_custom_amounts = originalCustomAmounts;
    if (conversionInputsChanged || approvedConversion || exactChanged) {
      body.expected_conversion_version = expectedConversionVersion;
    }
    return body;
  }

  if (!amountChanged && !currencyChanged) {
    delete body.amount;
    delete body.currency;
  }
  if (!dateChanged) delete body.date;
  if (splitMode === 'EXACT' && !exactChanged) delete body.custom_amounts;
  return body;
}
