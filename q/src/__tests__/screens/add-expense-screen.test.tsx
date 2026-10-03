/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('../../ui/Sheet', () => ({ __esModule: true, default: (p: any) => p.visible ? require('react').createElement('Sheet', p, p.children) : null }));
jest.mock('../../ui/Icon', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui/CategoryBadge', () => ({ __esModule: true, default: () => null }));

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
  api: jest.fn(), quoteExchangeRate: jest.fn(), readExpenses: jest.fn(async (id: string) => ({ items: await require('../../api').api(`/trips/${id}/expenses`), complete: true })),
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
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: (p: any) => require('react').createElement('ConfirmModal', p) }));
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
    CategoryPicker: require('../../ui/CategoryPicker').default,
    Icon: stub('Icon'),
    ActionSheet: stub('ActionSheet'),
    SkeletonCard: stub('SkeletonCard'),
    CurrencyPicker: stub('CurrencyPicker'),
    DateField: stub('DateField'),
    TimeField: stub('TimeField'),
    ExchangeRatePanel: require('../../ui/ExchangeRatePanel').default,
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
    expect(renderer.root.findByProps({ testID: 'offline-read-status' })).toBeTruthy();
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

it('saves a foreign refund offline for later quote approval without sending it', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  const reads = require('../../offlineReads');
  const loader = jest.spyOn(reads, 'loadTripReadBundle').mockResolvedValue({
    data: { trip: FAMILY_TRIP, expenses: [], balances: { net: {}, transfers: [] },
      spend: { total: 0, count: 0, entities: [] }, payments: [] },
    source: 'cache', fetchedAt: 1_700_000_000_000,
  });
  try {
    const renderer = await mountScreen();
    await act(async () => {
      renderer.root.findByProps({ testID: 'ae-currency' }).props.onChange('USD');
      renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('-90');
    });
    expect(renderer.root.findByProps({ testID: 'ae-submit' }).props.disabled).toBe(false);
    expect(renderer.root.findByProps({ testID: 'ae-foreign-offline' })).toBeTruthy();
    await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
    expect(mockCaptureExpense).toHaveBeenCalledTimes(1);
    expect(mockCaptureExpense.mock.calls[0][0]).toMatchObject({
      state: 'needs_review', lastSafeErrorCode: 'conversion_review_needed',
      payload: { original_amount: '-90', original_currency: 'USD',
        split_member_ids: ['family-1'] },
    });
    expect(apiMock.mock.calls.some(([path]) => String(path).includes('/expenses'))).toBe(false);
  } finally { loader.mockRestore(); }
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

it('keeps Food as default and submits an approved new category string without changing form state', async () => {
  mockExpenseCaptureActive.mockReturnValue(true);
  const renderer = await mountScreen();
  expect(renderer.root.findByType(require('../../ui/CategoryPicker').default).props.value).toBe('Food');
  await act(async () => {
    renderer.root.findByProps({ testID: 'ae-amount' }).props.onChangeText('120');
    renderer.root.findByType(require('../../ui/CategoryPicker').default).props.onChange('Subscriptions & Memberships');
  });
  expect(renderer.root.findByProps({ testID: 'ae-amount' }).props.value).toBe('120');
  await act(async () => { renderer.root.findByProps({ testID: 'ae-submit' }).props.onPress(); });
  expect(mockCaptureExpense.mock.calls[0][0].payload).toMatchObject({ category: 'Subscriptions & Memberships', original_amount: '120' });
});

function formControl(r: any, id: string, event = 'onPress') { return r.root.findAll((n: any) => n.props.testID === id && typeof n.props[event] === 'function')[0]; }
async function exerciseChooser(r: any, prefix: string) {
  await act(async () => formControl(r, `${prefix}-category`).props.onPress());
  await act(async () => formControl(r, `${prefix}-category-search`, 'onChangeText').props.onChangeText('taxi'));
  expect(formControl(r, `${prefix}-category-option-Local Transportation`).props.accessibilityRole).toBe('radio');
  await act(async () => r.root.findByType('Sheet' as any).props.onClose());
  await act(async () => formControl(r, `${prefix}-category`).props.onPress());
  expect(formControl(r, `${prefix}-category-search`, 'onChangeText').props.value).toBe('');
  await act(async () => formControl(r, `${prefix}-category-search`, 'onChangeText').props.onChangeText('taxes'));
  await act(async () => formControl(r, `${prefix}-category-option-Taxes & Government Fees`).props.onPress());
}

it.each(['ordinary', 'EXACT', 'family', 'foreign'])('preserves a populated %s Add form through cancel/search/select/reopen and budget confirmation', async (kind) => {
  jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(null);
  const quote = require('../../api').quoteExchangeRate as jest.Mock;
  quote.mockResolvedValue({ quote_id: 'stable-quote', source_amount: '120', source_currency: 'USD', target_currency: 'INR', target_amount: '9960', rate: '83', requested_date: '2026-10-03', effective_rate_date: '2026-10-02', provider: 'frankfurter_v2_blended', mode: 'automatic', stale: false, manual: false, provider_sources: [], expires_at: '2099-01-01T00:00:00Z' });
  require('expo-image-picker').requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  require('expo-image-picker').launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///populated-receipt.jpg', mimeType: 'image/jpeg', fileName: 'receipt.jpg' }] });
  apiMock.mockImplementation((path: string, options: any) => {
    if (options?.method === 'POST') return Promise.resolve(path.includes('force=true') ? { expense: { id: 'saved' } } : { requires_confirmation: true, total: 900, budget: 100, over_by: 800 });
    if (path === '/trips/t1') return Promise.resolve({ ...FAMILY_TRIP, budget: 100 });
    if (path.endsWith('/expenses') || path.endsWith('/payments')) return Promise.resolve([]);
    return Promise.resolve({ net: {}, transfers: [], total: 0, entities: [] });
  });
  const r = await mountScreen();
  await act(async () => {
    formControl(r, 'ae-amount', 'onChangeText').props.onChangeText('120');
    formControl(r, 'ae-desc', 'onChangeText').props.onChangeText('Preserved receipt and participants');
    formControl(r, 'ae-date', 'onChangeText').props.onChangeText('03/10/2026');
    formControl(r, 'ae-time', 'onChange').props.onChange('14:35');
    if (kind === 'foreign') formControl(r, 'ae-currency', 'onChange').props.onChange('USD');
    if (kind === 'family') { r.root.findByType('SplitModeSelector' as any).props.onChange('PER_FAMILY'); formControl(r, 'ae-fammem-family-1-1').props.onPress(); }
    if (kind === 'EXACT') r.root.findByType('SplitModeSelector' as any).props.onChange('EXACT');
  });
  if (kind === 'EXACT') await act(async () => r.root.findByType('ExactSplitEditor' as any).props.onChange([
    { memberId: 'person-1', entityId: 'family-1', included: true, amount: 80 }, { memberId: 'person-2', entityId: 'family-1', included: true, amount: 40 } ]));
  await act(async () => formControl(r, 'ae-receipt').props.onPress());
  await act(async () => r.root.findAllByType('ActionSheet' as any).find((n: any) => n.props.title === 'Add receipt').props.actions.find((a: any) => a.label === 'Choose from library').onPress());
  if (kind === 'foreign') { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); }); await act(async () => formControl(r, 'ae-exchange-rate-approve').props.onPress()); }
  const before = ['ae-amount', 'ae-desc', 'ae-date', 'ae-time', 'ae-currency'].map((id) => r.root.findByProps({ testID: id }).props.value);
  const fxBefore = r.root.findByType(require('../../ui/ExchangeRatePanel').default).props;
  const requests = quote.mock.calls.length;
  await exerciseChooser(r, 'ae');
  await act(async () => formControl(r, 'ae-category').props.onPress());
  expect(formControl(r, 'ae-category-option-Taxes & Government Fees').props.accessibilityState.checked).toBe(true);
  await act(async () => r.root.findByType('Sheet' as any).props.onRequestClose());
  expect(['ae-amount', 'ae-desc', 'ae-date', 'ae-time', 'ae-currency'].map((id) => r.root.findByProps({ testID: id }).props.value)).toEqual(before);
  expect(r.root.findByProps({ testID: 'receipt-view' })).toBeTruthy();
  expect(r.root.findByType(require('../../ui/ExchangeRatePanel').default).props).toEqual(fxBefore);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(quote).toHaveBeenCalledTimes(requests); expect(requests).toBe(kind === 'foreign' ? 1 : 0);
  await act(async () => formControl(r, 'ae-submit').props.onPress());
  expect(mockRouterBack).not.toHaveBeenCalled();
  const post = apiMock.mock.calls.find((c) => c[1]?.method === 'POST')![1].body;
  expect(post).toMatchObject({ category: 'Taxes & Government Fees', original_amount: '120', original_currency: kind === 'foreign' ? 'USD' : 'INR', description: 'Preserved receipt and participants', paid_by_member_id: 'family-1', date: '03-10-26', time: '14:35', split_mode: kind === 'family' ? 'PER_FAMILY' : kind === 'EXACT' ? 'EXACT' : 'PER_CAPITA' });
  if (kind === 'EXACT') expect(post.original_custom_amounts).toEqual({ 'person-1': 80, 'person-2': 40 });
  if (kind === 'family') expect(post.family_participants).toEqual({ 'family-1': ['person-1'] });
  if (kind === 'foreign') expect(post.conversion).toMatchObject({ quote_id: 'stable-quote', approved: true });
  await act(async () => r.root.findAllByType('ConfirmModal' as any).find((n: any) => n.props.visible && n.props.title === 'Budget warning').props.actions[1].onPress());
  expect(apiMock.mock.calls.filter((c) => c[1]?.method === 'POST')[1][1].body).toEqual(post);
  expect(require('../../api').uploadReceipt).toHaveBeenCalledWith('t1', 'saved', { uri: 'file:///populated-receipt.jpg', mimeType: 'image/jpeg', fileName: 'receipt.jpg' });
  expect(mockRouterBack).toHaveBeenCalledTimes(1);
  await act(async () => r.unmount()); jest.restoreAllMocks();
});
