/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRefreshRuntimeConfig = jest.fn().mockResolvedValue(undefined);
const mockToastShow = jest.fn();

jest.mock('../../api', () => ({
  api: jest.fn(),
  uploadReceipt: jest.fn(),
}));
jest.mock('../../AuthContext', () => ({
  useAuth: () => ({
    multiCurrencyCapability: 'enabled',
    multiCurrencyExpensesEnabled: true,
    refreshRuntimeConfig: mockRefreshRuntimeConfig,
  }),
}));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      background: '#0a0d0c', surface: '#121715', surfaceMuted: '#1a221f',
      primary: '#87c0b2', primaryText: '#0a0d0c', textMain: '#f7f5f0',
      textMuted: '#8ea39d', border: '#24302c', danger: '#ff8a66',
      success: '#8fc98f', warning: '#f5c28f',
    },
  }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../SplitModeSelector', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => R.createElement('SplitModeSelector', props),
    splitPreviewLabel: () => 'Split preview',
  };
});
jest.mock('../../ExactSplitEditor', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ReceiptViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    FormScreen: stub('FormScreen'),
    Screen: stub('Screen'),
    Card: stub('Card'),
    Button: stub('Button'),
    Input: stub('Input'),
    Pill: stub('Pill'),
    Icon: stub('Icon'),
    ActionSheet: stub('ActionSheet'),
    SkeletonCard: stub('SkeletonCard'),
    CurrencyPicker: stub('CurrencyPicker'),
    DateField: stub('DateField'),
    TimeField: stub('TimeField'),
    ExchangeRatePanel: stub('ExchangeRatePanel'),
    useToast: () => ({ show: mockToastShow }),
  };
});

import AddExpense from '../../../app/trip/[id]/add-expense';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const FAMILY_TRIP = {
  id: 't1',
  name: 'Family holiday',
  currency: 'INR',
  members: [{
    id: 'family-1',
    name: 'Sharma family',
    kind: 'family',
    family_members: ['Asha', 'Vik'],
    family_member_ids: ['person-1', 'person-2'],
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips/t1') return Promise.resolve(FAMILY_TRIP);
    if (path === '/trips/t1/expenses') return Promise.resolve([]);
    return Promise.reject(new Error(`Unexpected API path: ${path}`));
  });
});

async function mountScreen() {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(<AddExpense />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return renderer;
}

it('keeps a family-trip form stable for blank or incomplete amounts and previews valid amounts', async () => {
  const renderer = await mountScreen();
  const amountInput = renderer.root.findByProps({ testID: 'ae-amount' });

  expect(renderer.root.findAllByProps({ testID: 'ae-fam-preview-family-1' })).toHaveLength(0);

  for (const value of ['-', '.', '']) {
    await act(async () => { amountInput.props.onChangeText(value); });
    expect(renderer.root.findAllByProps({ testID: 'ae-fam-preview-family-1' })).toHaveLength(0);
  }

  await act(async () => { amountInput.props.onChangeText('10'); });
  const preview = renderer.root.findByProps({ testID: 'ae-fam-preview-family-1' });
  const previewText = Array.isArray(preview.props.children)
    ? preview.props.children.join('')
    : String(preview.props.children);
  expect(previewText).toContain('Asha ₹5');
  expect(previewText).toContain('Vik ₹5');
});
