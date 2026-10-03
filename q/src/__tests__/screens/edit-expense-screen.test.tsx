/* eslint-disable import/first, @typescript-eslint/no-require-imports */
jest.mock('../../ui/Sheet', () => ({ __esModule: true, default: (p: any) => p.visible ? require('react').createElement('Sheet', p, p.children) : null }));
jest.mock('../../ui/Icon', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ui/CategoryBadge', () => ({ __esModule: true, default: () => null }));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
const mockToast = jest.fn(); const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 't1', eid: 'e1' }), useRouter: () => ({ back: mockBack }) }));
jest.mock('../../api', () => ({ api: jest.fn(), quoteExchangeRate: jest.fn(), getExpense: jest.fn(), uploadReceipt: jest.fn(), deleteReceipt: jest.fn(), readExpenses: jest.fn(), getToken: jest.fn().mockResolvedValue(null), receiptUrl: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'user' }, sessionMode: 'online', multiCurrencyCapability: 'enabled', multiCurrencyExpensesEnabled: true, refreshRuntimeConfig: async () => {} }) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), mode: 'light' }) }));
jest.mock('../../ReceiptViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('../../ConfirmModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../../SplitModeSelector', () => ({ __esModule: true, default: (props: any) => require('react').createElement('SplitModeSelector', props), splitPreviewLabel: () => '' }));
jest.mock('../../ExactSplitEditor', () => ({ __esModule: true, default: (props: any) => require('react').createElement('ExactSplitEditor', props) }));
jest.mock('../../ui', () => {
  const R = require('react'); const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return { FormScreen: stub('FormScreen'), Screen: stub('Screen'), Card: stub('Card'), Button: stub('Button'), Input: stub('Input'),
    Pill: stub('Pill'), Icon: stub('Icon'), ActionSheet: stub('ActionSheet'), SkeletonCard: stub('SkeletonCard'),
    CategoryPicker: require('../../ui/CategoryPicker').default, CurrencyPicker: stub('CurrencyPicker'), ExchangeRatePanel: require('../../ui/ExchangeRatePanel').default,
    DateField: stub('DateField'), TimeField: stub('TimeField'), useToast: () => ({ show: mockToast }) };
});
import EditExpense from '../../../app/trip/[id]/edit-expense';
import { api, getExpense, readExpenses } from '../../api';
const trip = { id: 't1', name: 'Trip', currency: 'INR', owner_id: 'u1', admin_ids: [], members: [{ id: 'm1', name: 'Member', kind: 'individual', family_members: [], user_id: 'u1' }] };
const baseline = { id: 'e1', amount: 100, currency: 'INR', category: 'Food', description: 'Original', date: '03-10-26', paid_by_member_id: 'm1', split_member_ids: ['m1'], split_mode: 'PER_CAPITA', created_by: 'u1', original_amount: '100', original_currency: 'INR', conversion_version: 1 };
beforeEach(() => { jest.clearAllMocks(); (api as jest.Mock).mockImplementation(async (_path: string, options: any) => options?.method === 'PATCH' ? { ...baseline, ...options.body } : trip); (getExpense as jest.Mock).mockResolvedValue(baseline); (readExpenses as jest.Mock).mockResolvedValue({ items: [baseline], complete: true }); });
async function mount() { let renderer: any; await act(async () => { renderer = TestRenderer.create(<EditExpense />); await Promise.resolve(); }); return renderer; }
it.each(['PER_CAPITA', 'EXACT'])('edits one category while retaining %s allocations and source amount', async (split_mode) => {
  (getExpense as jest.Mock).mockResolvedValue({ ...baseline, split_mode, ...(split_mode === 'EXACT' ? { custom_amounts: { m1: 100 }, original_custom_amounts: { m1: '100' } } : {}) });
  const renderer = await mount();
  await act(async () => renderer.root.findByType(require('../../ui/CategoryPicker').default).props.onChange('Taxes & Government Fees'));
  expect(renderer.root.findByProps({ testID: 'ee-amount' }).props.value).toBe('100');
  expect(renderer.root.findByProps({ testID: 'ee-desc' }).props.value).toBe('Original');
  await act(async () => renderer.root.findByProps({ testID: 'ee-save' }).props.onPress());
  const patch = (api as jest.Mock).mock.calls.find((call) => call[1]?.method === 'PATCH')?.[1].body;
  expect(patch).toMatchObject({ category: 'Taxes & Government Fees', split_mode, description: 'Original', paid_by_member_id: 'm1' });
  expect(patch.conversion).toBeUndefined();
  expect(patch.date).toBeUndefined(); // Unchanged conversion inputs must stay locked.
  expect(patch.original_custom_amounts).toBeUndefined();
  expect(mockBack).toHaveBeenCalledTimes(1);
});
it('requires explicit approved selection for unknown historical values and keeps the form intact', async () => {
  (getExpense as jest.Mock).mockResolvedValue({ ...baseline, category: 'Historical category' });
  const renderer = await mount();
  expect(renderer.root.findByType(require('../../ui/CategoryPicker').default).props.value).toBe('Historical category');
  await act(async () => renderer.root.findByProps({ testID: 'ee-save' }).props.onPress());
  expect((api as jest.Mock).mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false);
  expect(mockToast).toHaveBeenCalledWith('Choose an approved category before saving.', 'error');
  expect(renderer.root.findByProps({ testID: 'ee-amount' }).props.value).toBe('100');
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

it.each(['ordinary', 'EXACT', 'family', 'foreign'])('preserves every populated %s Edit field and its locked conversion across chooser interactions', async (kind) => {
  jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(null);
  const family = { id: 'family-1', name: 'Family', kind: 'family', family_members: ['A', 'B'], family_member_ids: ['person-1', 'person-2'] };
  const loaded = { ...baseline, time: '14:35', has_receipt: true, receipt_id: 'durable-receipt',
    ...(kind === 'EXACT' ? { split_mode: 'EXACT', custom_amounts: { m1: 100 }, original_custom_amounts: { m1: '100' } } : {}),
    ...(kind === 'family' ? { split_mode: 'PER_FAMILY', paid_by_member_id: 'family-1', split_member_ids: ['family-1'], family_participants: { 'family-1': ['person-1'] } } : {}),
    ...(kind === 'foreign' ? { amount: 8300, original_currency: 'USD', exchange_rate: '83', exchange_rate_date: '2026-10-02', exchange_rate_provider: 'frankfurter_v2_blended', conversion_mode: 'automatic', conversion_version: 4 } : {}) };
  const withFamily = { ...trip, budget: 50, members: [...trip.members, family] };
  (getExpense as jest.Mock).mockResolvedValue(loaded); (readExpenses as jest.Mock).mockResolvedValue({ items: [loaded], complete: true });
  require('../../api').getToken.mockResolvedValue('local-test-token'); require('../../api').receiptUrl.mockReturnValue('receipt://durable-receipt');
  (api as jest.Mock).mockImplementation(async (_path: string, options: any) => options?.method === 'PATCH' ? { ...loaded, ...options.body } : withFamily);
  const r = await mount();
  const snapshot = () => ['ee-amount', 'ee-desc', 'ee-date', 'ee-time', 'ee-currency'].map((id) => r.root.findByProps({ testID: id }).props.value);
  const before = snapshot(); const fx = r.root.findByType(require('../../ui/ExchangeRatePanel').default).props;
  const exact = kind === 'EXACT' ? r.root.findByType('ExactSplitEditor' as any).props.rows : undefined;
  await exerciseChooser(r, 'ee');
  await act(async () => formControl(r, 'ee-category').props.onPress());
  expect(formControl(r, 'ee-category-option-Taxes & Government Fees').props.accessibilityState.checked).toBe(true);
  await act(async () => r.root.findByType('Sheet' as any).props.onClose());
  expect(snapshot()).toEqual(before); expect(r.root.findByType(require('../../ui/ExchangeRatePanel').default).props).toEqual(fx);
  if (kind === 'EXACT') expect(r.root.findByType('ExactSplitEditor' as any).props.rows).toEqual(exact);
  expect(r.root.findByProps({ testID: 'receipt-view' })).toBeTruthy();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
  expect(require('../../api').quoteExchangeRate).not.toHaveBeenCalled();
  await act(async () => formControl(r, 'ee-save').props.onPress());
  const patch = (api as jest.Mock).mock.calls.find((c) => c[1]?.method === 'PATCH')![1].body;
  expect(patch).toMatchObject({ category: 'Taxes & Government Fees', description: 'Original', time: '14:35', paid_by_member_id: loaded.paid_by_member_id, split_mode: loaded.split_mode });
  expect(patch.family_participants).toEqual(kind === 'family' ? { 'family-1': ['person-1'] } : null);
  for (const field of ['amount', 'currency', 'date', 'conversion', 'original_amount', 'original_currency', 'original_custom_amounts', 'expected_conversion_version']) expect(patch).not.toHaveProperty(field);
  expect(require('../../api').uploadReceipt).not.toHaveBeenCalled(); expect(require('../../api').deleteReceipt).not.toHaveBeenCalled();
  expect(mockBack).toHaveBeenCalledTimes(1); await act(async () => r.unmount()); jest.restoreAllMocks();
});
