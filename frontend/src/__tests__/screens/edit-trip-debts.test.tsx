/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Switch } from 'react-native';

const mockApi = jest.fn();
const mockRefresh = jest.fn();
const mockBack = jest.fn();
const mockToast = jest.fn();
let mockUser = { id: 'owner', is_super_admin: false };
let mockSessionMode = 'online';
let mockMode: 'light' | 'dark' = 'light';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: mockBack }),
}));
jest.mock('../../api', () => ({ api: (...args: unknown[]) => mockApi(...args) }));
jest.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: mockUser, sessionMode: mockSessionMode }),
}));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: require('../../theme').COLORS[mockMode], mode: mockMode }),
}));
jest.mock('../../offlineReads', () => ({
  refreshTripSettingsReads: (...args: unknown[]) => mockRefresh(...args),
}));
jest.mock('../../T', () => ({
  __esModule: true,
  default: (props: any) => require('react').createElement('T', props, props.children),
}));
jest.mock('../../ConfirmModal', () => ({
  __esModule: true,
  default: (props: any) => require('react').createElement('ConfirmModal', props),
}));
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    FormScreen: stub('FormScreen'), Input: stub('Input'), DateField: stub('DateField'),
    Button: stub('Button'), CurrencyPicker: stub('CurrencyPicker'), Card: stub('Card'),
    Icon: stub('Icon'), IconButton: stub('IconButton'), EmptyState: stub('EmptyState'), SkeletonCard: stub('SkeletonCard'),
    useToast: () => ({ show: mockToast }),
  };
});

import EditTrip from '../../../app/trip/[id]/edit';
import { COLORS } from '../../theme';

const trip = { id: 't1', name: 'Goa', currency: 'INR', budget: 3000,
  owner_id: 'owner', admin_ids: ['owner', 'admin'], user_ids: ['owner', 'admin', 'member'] };
let renderer: any;

async function mount(overrides: Record<string, unknown> = {}, payments: unknown[] = []) {
  mockApi.mockImplementation((path: string, options?: { method: string }) => {
    if (options?.method === 'PATCH') return Promise.resolve({ ...trip, ...overrides });
    if (path.endsWith('/payments')) return Promise.resolve(payments);
    if (path.endsWith('/settlements')) return Promise.resolve([]);
    return Promise.resolve({ ...trip, ...overrides });
  });
  await act(async () => { renderer = TestRenderer.create(<EditTrip />); });
  return renderer;
}

const toggle = () => renderer.root.findByType(Switch);
const confirm = () => renderer.root.findByType('ConfirmModal' as any);
const saveButton = () => renderer.root.findByType('Button' as any);
const patchCalls = () => mockApi.mock.calls.filter((call) => call[1]?.method === 'PATCH');

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'owner', is_super_admin: false };
  mockSessionMode = 'online';
  mockMode = 'light';
  mockRefresh.mockResolvedValue(true);
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('defaults older trips to enabled and places the toggle below official currency', async () => {
  await mount();
  expect(toggle().props.value).toBe(true);
  expect(toggle().props.disabled).toBe(false);
  expect(toggle().props.accessibilityLabel).toBe('Simplify group debts');
  const fields = renderer.root.findAll((node: any) => node.type === 'CurrencyPicker' || node.type === 'Card');
  expect(fields.map((node: any) => node.props.testID)).toEqual(['et-currency', 'et-debt-settings']);
});

it('requires confirmation and Save before changing the persisted setting', async () => {
  await mount();
  act(() => toggle().props.onValueChange(false));
  expect(toggle().props.value).toBe(true);
  expect(confirm().props.visible).toBe(true);
  expect(confirm().props.message).toContain('may increase the number of payments required to settle the group');
  act(() => confirm().props.actions[0].onPress());
  expect(toggle().props.value).toBe(true);
  expect(patchCalls()).toHaveLength(0);
  act(() => toggle().props.onValueChange(false));
  act(() => confirm().props.actions[1].onPress());
  expect(toggle().props.value).toBe(false);
  expect(patchCalls()).toHaveLength(0);
  await act(async () => { await saveButton().props.onPress(); });
  expect(patchCalls()[0][1].body.simplify_debts).toBe(false);
  expect(mockRefresh).toHaveBeenCalledWith('owner', 't1');
  expect(mockBack).toHaveBeenCalledTimes(1);
  expect(mockRefresh.mock.invocationCallOrder[0]).toBeLessThan(mockBack.mock.invocationCallOrder[0]);
});

it('persists false on reopening and allows switching back on without a warning', async () => {
  await mount({ simplify_debts: false });
  expect(toggle().props.value).toBe(false);
  act(() => toggle().props.onValueChange(true));
  expect(confirm().props.visible).toBe(false);
  await act(async () => { await saveButton().props.onPress(); });
  expect(patchCalls()[0][1].body.simplify_debts).toBe(true);
});

it('shows the setting read-only to admins and omits it when they save other fields', async () => {
  mockUser.id = 'admin';
  await mount({ simplify_debts: false });
  expect(toggle().props.disabled).toBe(true);
  act(() => toggle().props.onValueChange(true));
  expect(toggle().props.value).toBe(false);
  await act(async () => { await saveButton().props.onPress(); });
  expect(patchCalls()[0][1].body).not.toHaveProperty('simplify_debts');
});

it('retains the application administrator override and rejects member editing', async () => {
  mockUser = { id: 'operator', is_super_admin: true };
  await mount();
  expect(toggle().props.disabled).toBe(false);
  act(() => renderer.unmount());
  mockUser = { id: 'member', is_super_admin: false };
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(saveButton().props.disabled).toBe(true);
});

it('keeps an unsaved selection and shows an error when saving fails', async () => {
  await mount();
  act(() => toggle().props.onValueChange(false));
  act(() => confirm().props.actions[1].onPress());
  mockApi.mockRejectedValue(new Error('Balances changed. Refresh and retry.'));
  await act(async () => { await saveButton().props.onPress(); });
  expect(toggle().props.value).toBe(false);
  expect(mockBack).not.toHaveBeenCalled();
  expect(mockRefresh).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Balances changed. Refresh and retry.', 'error');
});

it('explains settlement carry-over when completed payments exist', async () => {
  await mount({}, [{ id: 'p1', amount: 100 }]);
  expect(renderer.root.findAllByProps({ testID: 'et-debt-carryover' }).length).toBeGreaterThan(0);
  act(() => toggle().props.onValueChange(false));
  expect(confirm().props.message).toContain('Completed settlements remain cleared');
});

it.each(['light', 'dark'] as const)('uses the %s theme for the switch', async (mode) => {
  mockMode = mode;
  await mount();
  expect(toggle().props.trackColor.true).toBe(COLORS[mode].primary);
  expect(toggle().props.thumbColor).toBe(COLORS[mode].primaryText);
  act(() => toggle().props.onValueChange(false));
  act(() => confirm().props.actions[1].onPress());
  expect(toggle().props.thumbColor).toBe(COLORS[mode].textMuted);
});

it('keeps settings unavailable until loading succeeds and offers retry on failure', async () => {
  mockApi.mockRejectedValue(new Error('Network unavailable'));
  await act(async () => { renderer = TestRenderer.create(<EditTrip />); });
  expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
  const error = renderer.root.findByType('EmptyState' as any);
  expect(error.props.body).toBe('Network unavailable');
  expect(error.props.ctaLabel).toBe('Try again');
});

it('disables updates in offline sessions', async () => {
  mockSessionMode = 'offline';
  await mount();
  expect(toggle().props.disabled).toBe(true);
  expect(saveButton().props.disabled).toBe(true);
});
