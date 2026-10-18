/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Switch } from 'react-native';

const mockApi = jest.fn();
const mockReplace = jest.fn();
const mockToast = jest.fn();

jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('../../api', () => ({ api: (...args: unknown[]) => mockApi(...args) }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner', name: 'Owner' } }) }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({ colors: require('../../theme').COLORS.light, mode: 'light' }),
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
    Button: stub('Button'), CurrencyPicker: stub('CurrencyPicker'), Pill: stub('Pill'),
    Icon: stub('Icon'), Card: stub('Card'), SegmentedControl: stub('SegmentedControl'),
    useToast: () => ({ show: mockToast }),
  };
});

import CreateTrip from '../../../app/create-trip';

let renderer: any;
const toggle = () => renderer.root.findByType(Switch);
const confirmation = () => renderer.root.findByType('ConfirmModal' as any);
const submit = () => renderer.root.findByType('Button' as any);
const input = (id: string) => renderer.root.findAllByType('Input' as any)
  .find((node: any) => node.props.testID === id)!;

async function mount() {
  await act(async () => { renderer = TestRenderer.create(<CreateTrip />); });
  act(() => input('ct-name').props.onChangeText('Goa weekend'));
}

function turnOff() {
  act(() => toggle().props.onValueChange(false));
  act(() => confirmation().props.actions[1].onPress());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApi.mockResolvedValue({ id: 'new-group' });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); });

it('shows an enabled setting below official currency and before the identity fields', async () => {
  await mount();
  expect(toggle().props.value).toBe(true);
  expect(toggle().props.disabled).toBe(false);
  const fields = renderer.root.findAll((node: any) =>
    node.type === 'CurrencyPicker' || node.type === 'Card' || node.type === 'SegmentedControl');
  expect(fields.map((node: any) => node.props.testID || node.props.testIDPrefix))
    .toEqual(['ct-currency', 'ct-debt-settings', 'ct-self']);
});

it('creates a group with simplification enabled by default', async () => {
  await mount();
  await act(async () => { await submit().props.onPress(); });
  expect(mockApi).toHaveBeenCalledWith('/trips', expect.objectContaining({
    method: 'POST', body: expect.objectContaining({ simplify_debts: true }),
  }));
  expect(mockReplace).toHaveBeenCalledWith('/trip/new-group');
});

it('keeps simplification on when the turn-off confirmation is cancelled', async () => {
  await mount();
  act(() => toggle().props.onValueChange(false));
  expect(toggle().props.value).toBe(true);
  expect(confirmation().props.visible).toBe(true);
  expect(confirmation().props.message).toContain('may increase the number of payments');
  expect(confirmation().props.message).not.toContain('Completed settlements');
  act(() => confirmation().props.actions[0].onPress());
  expect(toggle().props.value).toBe(true);
  expect(mockApi).not.toHaveBeenCalled();
});

it('submits direct repayment only after confirmation and Create group', async () => {
  await mount();
  turnOff();
  expect(toggle().props.value).toBe(false);
  expect(mockApi).not.toHaveBeenCalled();
  await act(async () => { await submit().props.onPress(); });
  expect(mockApi.mock.calls[0][1].body.simplify_debts).toBe(false);
});

it('allows re-enabling before creation without a confirmation', async () => {
  await mount();
  turnOff();
  act(() => toggle().props.onValueChange(true));
  expect(confirmation().props.visible).toBe(false);
  await act(async () => { await submit().props.onPress(); });
  expect(mockApi.mock.calls[0][1].body.simplify_debts).toBe(true);
});

it('retains the selected mode when creation fails', async () => {
  await mount();
  turnOff();
  mockApi.mockRejectedValue(new Error('Could not create group'));
  await act(async () => { await submit().props.onPress(); });
  expect(toggle().props.value).toBe(false);
  expect(toggle().props.disabled).toBe(false);
  expect(mockReplace).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Could not create group', 'error');
});

it('keeps the chosen mode stable while the creation request is running', async () => {
  await mount();
  turnOff();
  let complete!: (trip: { id: string }) => void;
  mockApi.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  let saving!: Promise<void>;
  act(() => { saving = submit().props.onPress(); });
  expect(toggle().props.disabled).toBe(true);
  act(() => toggle().props.onValueChange(true));
  expect(toggle().props.value).toBe(false);
  await act(async () => { complete({ id: 'new-group' }); await saving; });
});

it('preserves the mode when the creator joins as a family', async () => {
  await mount();
  turnOff();
  act(() => renderer.root.findByType('SegmentedControl' as any).props.onChange('family'));
  act(() => input('ct-family-name').props.onChangeText('Owner family'));
  await act(async () => { await submit().props.onPress(); });
  expect(mockApi.mock.calls[0][1].body).toEqual(expect.objectContaining({
    simplify_debts: false, self_kind: 'family', family_name: 'Owner family',
    family_members: ['Owner'], self_index: 0,
  }));
});
