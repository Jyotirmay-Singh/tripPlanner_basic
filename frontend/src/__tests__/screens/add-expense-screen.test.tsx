/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockRefreshRuntimeConfig = jest.fn().mockResolvedValue(undefined);
const mockToastShow = jest.fn();
const mockRouterBack = jest.fn();
const mockRouterReplace = jest.fn();
const mockCaptureExpense = jest.fn();
const mockExpenseCaptureActive = jest.fn(() => false);
const mockListOutbox = jest.fn();
let mockSearchParams: { id: string; reviewId?: string } = { id: 't1' };

jest.mock('../../api', () => ({
  api: jest.fn(),
  uploadReceipt: jest.fn(),
}));
jest.mock('../../AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
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
  useLocalSearchParams: () => mockSearchParams,
  useRouter: () => ({ back: mockRouterBack, replace: mockRouterReplace, push: jest.fn() }),
}));
jest.mock('../../offlineStore', () => ({ offlineStore: {
  listOutbox: (...args: any[]) => mockListOutbox(...args),
} }));
jest.mock('../../offlineExpenses', () => ({
  ...jest.requireActual('../../offlineExpenses'),
  expenseCaptureActive: () => mockExpenseCaptureActive(),
  captureExpense: (...args: any[]) => mockCaptureExpense(...args),
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
jest.mock('../../ExactSplitEditor', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('ExactSplitEditor', props) };
});
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
  mockExpenseCaptureActive.mockReturnValue(false);
  mockCaptureExpense.mockResolvedValue(undefined);
  mockListOutbox.mockResolvedValue([]);
  mockSearchParams = { id: 't1' };
  apiMock.mockImplementation((path: string) => {
    if (path === '/trips/t1') return Promise.resolve(FAMILY_TRIP);
    if (path === '/trips/t1/expenses') return Promise.resolve([]);
    if (path === '/trips/t1/balances') return Promise.resolve({ net: {}, transfers: [], members: FAMILY_TRIP.members, currency: 'INR' });
    if (path === '/trips/t1/spend-summary') return Promise.resolve({ total: 0, count: 0, entities: [] });
    if (path === '/trips/t1/payments') return Promise.resolve([]);
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

it('opens a saved roster in airplane mode without claiming the form can save', async () => {
  const reads = require('../../offlineReads');
  const loader = jest.spyOn(reads, 'loadTripReadBundle').mockResolvedValue({
    data: { trip: FAMILY_TRIP, expenses: [], balances: { net: {}, transfers: [] },
      spend: { total: 0, count: 0, entities: [] }, payments: [] },
    source: 'cache', fetchedAt: 1_700_000_000_000,
  });
  try {
    const renderer = await mountScreen();
    expect(renderer.root.findByProps({ testID: 'ae-amount' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'ae-submit' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'ae-receipt' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ testID: 'ae-offline-note' })).toBeTruthy();
  } finally {
    loader.mockRestore();
  }
});

it('queues a selected family participant for a refund and ignores a duplicate tap', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  let complete!: () => void;
  mockCaptureExpense.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
  const renderer = await mountScreen();
  await act(async () => {
    renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('-90');
    renderer.root.findByType('SplitModeSelector' as any).props.onChange('PER_FAMILY');
    renderer.root.findByProps({ testID: 'ae-fammem-family-1-1' }).props.onPress();
  });
  const save = renderer.root.findByProps({ testID: 'ae-submit' });
  await act(async () => { save.props.onPress(); save.props.onPress(); await Promise.resolve(); });
  expect(mockCaptureExpense).toHaveBeenCalledTimes(1);
  const item = mockCaptureExpense.mock.calls[0][0];
  expect(item.payload).toMatchObject({
    original_amount: '-90', original_currency: 'INR', split_mode: 'PER_FAMILY',
    split_member_ids: ['family-1'], family_participants: { 'family-1': ['person-1'] },
  });
  expect(item.payload.expected_roster.members[0].family_member_ids).toEqual(['person-1', 'person-2']);
  await act(async () => { complete(); });
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
});

it('keeps the form and does not claim success when device storage fails', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  mockCaptureExpense.mockRejectedValue(new Error('disk full'));
  const renderer = await mountScreen();
  await act(async () => { renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('90'); });
  await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
  expect(mockRouterBack).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ testID: 'ae-amount' }).props.value).toBe('90');
  expect(mockToastShow).toHaveBeenCalledWith(
    'Not saved on this device. Your form is still here; please try again.', 'error');
  expect(mockToastShow).not.toHaveBeenCalledWith('Saved on this device. Pending sync.', 'success');
  const firstUuid = mockCaptureExpense.mock.calls[0][0].clientMutationId;
  mockCaptureExpense.mockResolvedValue(undefined);
  await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
  expect(mockCaptureExpense.mock.calls[1][0].clientMutationId).toBe(firstUuid);
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
});

it('captures exact person allocations without expanding to everyone', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  const renderer = await mountScreen();
  await act(async () => {
    renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('-90');
    renderer.root.findByType('SplitModeSelector' as any).props.onChange('EXACT');
  });
  await act(async () => {
    renderer.root.findByType('ExactSplitEditor' as any).props.onChange([
      { memberId: 'person-1', entityId: 'family-1', included: true, amount: 90 },
      { memberId: 'person-2', entityId: 'family-1', included: false, amount: null },
    ]);
  });
  await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
  expect(mockCaptureExpense).toHaveBeenCalledTimes(1);
  expect(mockCaptureExpense.mock.calls[0][0].payload).toMatchObject({
    split_mode: 'EXACT', split_member_ids: ['family-1'],
    original_custom_amounts: { 'person-1': 90 }, original_amount: '-90',
  });
});

it('rehydrates a rejected family refund and atomically requeues its edited intent', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  mockSearchParams = { id: 't1', reviewId: 'old-uuid' };
  mockListOutbox.mockResolvedValue([{
    clientMutationId: 'old-uuid', tripId: 't1', operation: 'expense_create',
    state: 'needs_review', payload: {
      original_amount: '-90', original_currency: 'INR', category: 'Food',
      description: 'Family refund', date: '25-09-26', time: null,
      paid_by_member_id: 'family-1', split_member_ids: ['family-1'],
      split_mode: 'PER_FAMILY', family_participants: { 'family-1': ['person-1'] },
      expected_roster: { currency: 'INR', members: [
        { id: 'family-1', kind: 'family', family_member_ids: ['person-1', 'person-2'] },
      ] },
    },
  }]);
  const renderer = await mountScreen();
  expect(renderer.root.findByProps({ testID: 'ae-amount' }).props.value).toBe('-90');
  expect(renderer.root.findByType('SplitModeSelector' as any).props.value).toBe('PER_FAMILY');
  await act(async () => { renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('-80'); });
  await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
  expect(mockCaptureExpense).toHaveBeenCalledTimes(1);
  expect(mockCaptureExpense.mock.calls[0][1]).toBe('old-uuid');
  expect(mockCaptureExpense.mock.calls[0][0].clientMutationId).not.toBe('old-uuid');
  expect(mockCaptureExpense.mock.calls[0][0].payload).toMatchObject({
    original_amount: '-80', split_member_ids: ['family-1'],
    family_participants: { 'family-1': ['person-1'] },
  });
  expect(mockRouterReplace).toHaveBeenCalledWith({
    pathname: '/trip/[id]', params: { id: 't1', tab: 'expenses' },
  });
});
