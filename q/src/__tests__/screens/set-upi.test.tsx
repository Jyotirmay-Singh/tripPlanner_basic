/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockReplace = jest.fn();
const mockUpdateUpiId = jest.fn();
const mockCompleteUpiOnboarding = jest.fn();
const mockToastShow = jest.fn();
let mockParams: any = {};
let mockAuthState: any = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../AuthContext', () => ({ useAuth: () => mockAuthState }));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({
    colors: new Proxy({}, { get: () => '#123456' }),
  }),
}));
jest.mock('../../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  const stub = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    __esModule: true,
    AuthShell: stub('AuthShell'),
    Button: stub('Button'),
    Card: stub('Card'),
    Icon: stub('Icon'),
    Input: stub('Input'),
    useToast: () => ({ show: mockToastShow }),
  };
});
jest.mock('../../ConfirmModal', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => props.visible ? R.createElement('ConfirmModal', props) : null,
  };
});

import SetUpi from '../../../app/set-upi';
import { UPI_ID_INVALID_MESSAGE } from '../../validation';

const node = (renderer: any, testID: string) => renderer.root.find(
  (candidate: any) => typeof candidate.type === 'string' && candidate.props.testID === testID,
);
const has = (renderer: any, testID: string) => renderer.root.findAll(
  (candidate: any) => typeof candidate.type === 'string' && candidate.props?.testID === testID,
).length > 0;

function mount() {
  let renderer: any;
  act(() => { renderer = TestRenderer.create(<SetUpi />); });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockAuthState = {
    user: {
      id: 'u1', email: 'ravi@gmail.com', name: 'Ravi', role: 'user',
      upi_id: null, upi_updated_at: null,
    },
    pendingInvitePath: null,
    updateUpiId: mockUpdateUpiId,
    completeUpiOnboarding: mockCompleteUpiOnboarding,
  };
  mockUpdateUpiId.mockImplementation(async (upiId: string | null) => ({
    ...mockAuthState.user,
    upi_id: upiId,
    upi_updated_at: upiId ? '2026-09-11T10:00:00+00:00' : null,
  }));
});

describe('UPI onboarding mode', () => {
  it.each([
    ['malformed', 'not-a-upi'],
    ['whitespace-containing', 'ravi pay@upi'],
    ['control-character', 'ravi@upi\n'],
  ])('rejects %s input locally without a profile mutation', async (_case, value) => {
    const renderer = mount();
    act(() => node(renderer, 'upi-input').props.onChangeText(value));
    await act(async () => node(renderer, 'upi-save').props.onPress());

    expect(mockUpdateUpiId).not.toHaveBeenCalled();
    expect(node(renderer, 'upi-input').props.error).toBe(UPI_ID_INVALID_MESSAGE);
    expect(node(renderer, 'upi-input').props.errorTestID).toBe('upi-error');
    expect(node(renderer, 'upi-input').props.focusOnError).toBe(true);
    expect(node(renderer, 'upi-save').props.label).toBe('Try again');
  });

  it('trims a valid ID, trusts the saved response, and continues to a safe invite', async () => {
    const invite = `/invite/${'a'.repeat(43)}`;
    mockParams = { returnTo: invite };
    mockUpdateUpiId.mockResolvedValueOnce({
      ...mockAuthState.user,
      upi_id: 'Ravi.Pay@OkSbi',
      upi_updated_at: '2026-09-11T10:00:00+00:00',
    });
    const renderer = mount();

    act(() => node(renderer, 'upi-input').props.onChangeText('  Ravi.Pay@OkSbi  '));
    await act(async () => node(renderer, 'upi-save').props.onPress());

    expect(mockUpdateUpiId).toHaveBeenCalledWith('Ravi.Pay@OkSbi');
    expect(node(renderer, 'upi-input').props.value).toBe('Ravi.Pay@OkSbi');
    expect(mockToastShow).toHaveBeenCalledWith('UPI ID saved.', 'success');
    expect(mockCompleteUpiOnboarding).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(invite);
  });

  it('preserves a failed value, exposes retry, and keeps a write-free Skip available', async () => {
    mockUpdateUpiId.mockRejectedValueOnce(new Error('Could not reach the server'));
    const renderer = mount();
    act(() => node(renderer, 'upi-input').props.onChangeText('ravi@upi'));

    await act(async () => node(renderer, 'upi-save').props.onPress());

    expect(node(renderer, 'upi-input').props.value).toBe('ravi@upi');
    expect(node(renderer, 'upi-input').props.error).toBe('Could not reach the server');
    expect(node(renderer, 'upi-save').props.label).toBe('Try again');
    expect(node(renderer, 'upi-skip').props.disabled).toBe(false);
    expect(mockToastShow).not.toHaveBeenCalled();
    expect(mockCompleteUpiOnboarding).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();

    act(() => node(renderer, 'upi-skip').props.onPress());
    expect(mockUpdateUpiId).toHaveBeenCalledTimes(1);
    expect(mockCompleteUpiOnboarding).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('rejects an unsafe return path when skipping and never writes data', () => {
    mockParams = { returnTo: 'https://evil.example/invite/secret' };
    const renderer = mount();

    act(() => node(renderer, 'upi-skip').props.onPress());

    expect(mockUpdateUpiId).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
  });

  it('wires the UPI-specific input, safety copy, and duplicate-mutation states', async () => {
    let resolveSave: (value: any) => void = () => {};
    mockUpdateUpiId.mockReturnValueOnce(new Promise((resolve) => { resolveSave = resolve; }));
    const renderer = mount();
    const input = node(renderer, 'upi-input');

    expect(input.props).toEqual(expect.objectContaining({
      label: 'UPI ID',
      placeholder: 'name@bank',
      autoCapitalize: 'none',
      autoCorrect: false,
      keyboardType: 'email-address',
    }));
    expect(node(renderer, 'upi-security-note')).toBeDefined();
    act(() => input.props.onChangeText('ravi@upi'));
    act(() => {
      void node(renderer, 'upi-save').props.onPress();
      void node(renderer, 'upi-save').props.onPress();
    });

    expect(mockUpdateUpiId).toHaveBeenCalledTimes(1);
    expect(node(renderer, 'upi-save').props.loading).toBe(true);
    expect(node(renderer, 'upi-save').props.disabled).toBe(true);
    expect(node(renderer, 'upi-skip').props.disabled).toBe(true);
    expect(node(renderer, 'upi-input').props.editable).toBe(false);

    await act(async () => {
      resolveSave({ ...mockAuthState.user, upi_id: 'ravi@upi' });
      await Promise.resolve();
    });
  });
});

describe('UPI profile mode', () => {
  beforeEach(() => {
    mockParams = { mode: 'profile' };
    mockAuthState.user = {
      ...mockAuthState.user,
      upi_id: 'old@upi',
      upi_updated_at: '2026-09-10T10:00:00+00:00',
    };
  });

  it('prefills, edits, and saves before returning to Profile', async () => {
    const renderer = mount();
    expect(node(renderer, 'upi-input').props.value).toBe('old@upi');
    expect(node(renderer, 'upi-save').props.label).toBe('Save changes');

    act(() => node(renderer, 'upi-input').props.onChangeText('new@upi'));
    await act(async () => node(renderer, 'upi-save').props.onPress());

    expect(mockUpdateUpiId).toHaveBeenCalledWith('new@upi');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
    expect(mockCompleteUpiOnboarding).not.toHaveBeenCalled();
  });

  it('cancels editing without saving', () => {
    const renderer = mount();
    act(() => node(renderer, 'upi-input').props.onChangeText('unsaved@upi'));
    act(() => node(renderer, 'upi-cancel').props.onPress());

    expect(mockUpdateUpiId).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
  });

  it('supports canceling and confirming removal through the themed modal', async () => {
    const renderer = mount();
    act(() => node(renderer, 'upi-remove').props.onPress());
    let modal = node(renderer, 'upi-remove-confirm-modal');

    act(() => modal.props.actions.find((item: any) => item.testID === 'upi-remove-cancel').onPress());
    expect(has(renderer, 'upi-remove-confirm-modal')).toBe(false);
    expect(mockUpdateUpiId).not.toHaveBeenCalled();

    act(() => node(renderer, 'upi-remove').props.onPress());
    modal = node(renderer, 'upi-remove-confirm-modal');
    await act(async () => modal.props.actions
      .find((item: any) => item.testID === 'upi-remove-confirm').onPress());

    expect(mockUpdateUpiId).toHaveBeenCalledWith(null);
    expect(mockToastShow).toHaveBeenCalledWith('UPI ID removed.', 'success');
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/profile');
  });
});
