/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the password-reset landing screen (app/reset-password.tsx). The heavy
// dependencies (expo-router, the api fetch wrapper, the themed `ui` kit) are mocked so we can
// drive the form and assert the request it makes — no renderer-provider plumbing needed.
const mockReplace = jest.fn();
const mockInvalidateSession = jest.fn();
let mockParams: any = {};
const mockToast = { show: jest.fn() };

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ handleAuthenticationRequired: mockInvalidateSession }) }));
jest.mock('../../ui', () => {
  const R = require('react');
  return {
    __esModule: true,
    AuthShell: ({ children }: any) => R.createElement('AuthShell', null, children),
    Input: (p: any) => R.createElement('Input', p),
    Button: (p: any) => R.createElement('Button', p),
    Icon: (p: any) => R.createElement('Icon', p),
    useToast: () => mockToast,
  };
});

import ResetPassword from '../../../app/reset-password';
import { api } from '../../api';
import { PASSWORD_TOO_SHORT_MESSAGE, PASSWORD_MISMATCH_MESSAGE } from '../../validation';

const apiMock = api as unknown as jest.Mock;
// Pick the host node (string type) so we don't double-match the mock component + its host.
const node = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.testID === id);
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id).length > 0;

beforeEach(() => {
  mockReplace.mockClear();
  mockInvalidateSession.mockReset().mockResolvedValue(undefined);
  mockToast.show.mockClear();
  apiMock.mockReset();
  mockParams = { token: 'reset-link-secret' }; // arrives from the email link
});

function mount() {
  let r: any;
  act(() => { r = TestRenderer.create(React.createElement(ResetPassword)); });
  return r;
}

describe('ResetPassword screen', () => {
  it('rejects a too-short password (inline error, no API call)', async () => {
    apiMock.mockResolvedValue({});
    const r = mount();
    expect(apiMock).not.toHaveBeenCalled();
    act(() => { node(r, 'reset-pw-password').props.onChangeText('short'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('short'); });
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });

    expect(mockToast.show).toHaveBeenCalledWith(PASSWORD_TOO_SHORT_MESSAGE, 'error');
    expect(apiMock).not.toHaveBeenCalled();
    expect(node(r, 'reset-pw-password').props.error).toBe(PASSWORD_TOO_SHORT_MESSAGE);
  });

  it('rejects mismatched confirmation (no API call)', async () => {
    apiMock.mockResolvedValue({});
    const r = mount();
    act(() => { node(r, 'reset-pw-password').props.onChangeText('validpass123'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('different123'); });
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });

    expect(mockToast.show).toHaveBeenCalledWith(PASSWORD_MISMATCH_MESSAGE, 'error');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('keeps the link token hidden and posts it only after explicit submission', async () => {
    apiMock.mockResolvedValue({ ok: true });
    const r = mount();
    expect(apiMock).not.toHaveBeenCalled();
    expect(has(r, 'reset-pw-token')).toBe(false);
    expect(r.root.findAll((n: any) => n.type === 'Input')).toHaveLength(2);
    expect(JSON.stringify(r.toJSON())).not.toContain('reset-link-secret');
    act(() => { node(r, 'reset-pw-password').props.onChangeText('validpass123'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('validpass123'); });
    expect(apiMock).not.toHaveBeenCalled();
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });

    expect(apiMock).toHaveBeenCalledWith('/auth/reset-password', {
      method: 'POST', body: { token: 'reset-link-secret', new_password: 'validpass123' }, auth: false,
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSession).toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    expect(mockToast.show).toHaveBeenCalledWith(expect.stringContaining('Password updated'), 'success');
  });

  it('offers a new reset link instead of token entry when the link is missing', () => {
    mockParams = {};
    const r = mount();

    expect(has(r, 'reset-pw-token')).toBe(false);
    expect(has(r, 'reset-pw-submit')).toBe(false);
    expect(r.root.findAll((n: any) => n.type === 'Input')).toHaveLength(0);
    act(() => { node(r, 'reset-pw-request-link').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/forgot-password');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('keeps rejected tokens hidden and lets the user request a new link', async () => {
    apiMock.mockRejectedValue(new Error('This link is invalid or has expired.'));
    const r = mount();
    act(() => { node(r, 'reset-pw-password').props.onChangeText('validpass123'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('validpass123'); });
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });

    expect(mockToast.show).toHaveBeenCalledWith('This link is invalid or has expired.', 'error');
    expect(has(r, 'reset-pw-token')).toBe(false);
    expect(JSON.stringify(r.toJSON())).not.toContain('reset-link-secret');
    expect(mockInvalidateSession).not.toHaveBeenCalled();
    act(() => { node(r, 'reset-pw-request-link').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/forgot-password');
  });

  it('directs an unverified legacy-link holder to verification without changing credentials', async () => {
    apiMock.mockRejectedValue(Object.assign(new Error('Verify your email before resetting your password.'), {
      detailCode: 'email_link_verification_required',
    }));
    const r = mount();
    act(() => { node(r, 'reset-pw-password').props.onChangeText('validpass123'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('validpass123'); });
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });
    expect(has(r, 'reset-pw-submit')).toBe(false);
    expect(r.root.findAll((n: any) => n.type === 'Input')).toHaveLength(0);
    expect(node(r, 'reset-pw-request-link').props.label).toBe('Get a recovery email');
    expect(mockInvalidateSession).not.toHaveBeenCalled();
    act(() => { node(r, 'reset-pw-request-link').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/forgot-password');
  });
});
