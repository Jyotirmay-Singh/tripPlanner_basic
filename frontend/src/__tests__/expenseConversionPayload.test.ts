import {
  applyExpenseEditConversionContract,
  createExpenseAmountFields,
} from '../expenseConversionPayload';

const conversion = {
  mode: 'automatic' as const,
  quote_id: 'quote-1',
  approved: true as const,
  allow_stale: false,
};

it('uses original fields and an approved quote for a foreign create', () => {
  expect(createExpenseAmountFields({
    multiCurrencyEnabled: true,
    originalAmount: 1000,
    sourceCurrency: 'INR',
    tripCurrency: 'LKR',
    approvedConversion: conversion,
  })).toEqual({
    original_amount: '1000',
    original_currency: 'INR',
    conversion,
  });
});

it('keeps the legacy canonical create contract while rollout is disabled', () => {
  expect(createExpenseAmountFields({
    multiCurrencyEnabled: false,
    originalAmount: 125.50,
    sourceCurrency: 'LKR',
    tripCurrency: 'LKR',
  })).toEqual({ amount: 125.50, currency: 'LKR' });
});

it('omits conversion fields from a description-only edit', () => {
  const body = applyExpenseEditConversionContract({
    body: {
      amount: 3520.40,
      currency: 'INR',
      description: 'Updated description',
      date: '28-08-26',
      split_mode: 'PER_CAPITA',
      custom_amounts: null,
    },
    multiCurrencyEnabled: true,
    originalAmount: 1000,
    sourceCurrency: 'NPR',
    conversionInputsChanged: false,
    amountChanged: false,
    currencyChanged: false,
    dateChanged: false,
    splitMode: 'PER_CAPITA',
    exactChanged: false,
    originalCustomAmounts: null,
    expectedConversionVersion: 4,
  });

  expect(body).toEqual({
    description: 'Updated description',
    split_mode: 'PER_CAPITA',
  });
});

it('sends changed source inputs, approved quote, and expected version for reconversion', () => {
  const body = applyExpenseEditConversionContract({
    body: {
      amount: 7040.80,
      currency: 'INR',
      description: 'Two tickets',
      date: '29-08-26',
      custom_amounts: null,
    },
    multiCurrencyEnabled: true,
    originalAmount: 2000,
    sourceCurrency: 'NPR',
    conversionInputsChanged: true,
    amountChanged: true,
    currencyChanged: false,
    dateChanged: true,
    splitMode: 'PER_CAPITA',
    exactChanged: false,
    originalCustomAmounts: null,
    approvedConversion: conversion,
    expectedConversionVersion: 4,
  });

  expect(body).toEqual({
    description: 'Two tickets',
    date: '29-08-26',
    original_amount: '2000',
    original_currency: 'NPR',
    conversion,
    expected_conversion_version: 4,
  });
});

it('sends original-currency EXACT allocations without canonical shares or a requote', () => {
  const body = applyExpenseEditConversionContract({
    body: {
      amount: 3520.40,
      currency: 'LKR',
      date: '28-08-26',
      split_mode: 'EXACT',
      custom_amounts: { ann: 1760.20, bob: 1760.20 },
    },
    multiCurrencyEnabled: true,
    originalAmount: 1000,
    sourceCurrency: 'INR',
    conversionInputsChanged: false,
    amountChanged: false,
    currencyChanged: false,
    dateChanged: false,
    splitMode: 'EXACT',
    exactChanged: true,
    originalCustomAmounts: { ann: 500, bob: 500 },
    expectedConversionVersion: 4,
  });

  expect(body).toEqual({
    split_mode: 'EXACT',
    original_custom_amounts: { ann: 500, bob: 500 },
    expected_conversion_version: 4,
  });
});
