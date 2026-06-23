/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the password-reset landing screen (app/reset-password.tsx). The heavy
// dependencies (expo-router, the api fetch wrapper, the themed `ui` kit) are mocked so we can
// drive the form and assert the request it makes — no renderer-provider plumbing needed.
const mockReplace = jest.fn();
let mockParams: any = {};
const mockToast = { show: jest.fn() };

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../api', () => ({ api: jest.fn() }));
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

beforeEach(() => {
  mockReplace.mockClear();
  mockToast.show.mockClear();
  apiMock.mockReset();
  mockParams = { token: 't' }; // arrives from the email link
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

  it('posts {token, new_password} on a valid submit', async () => {
    apiMock.mockResolvedValue({ ok: true });
    const r = mount();
    act(() => { node(r, 'reset-pw-password').props.onChangeText('validpass123'); });
    act(() => { node(r, 'reset-pw-confirm').props.onChangeText('validpass123'); });
    await act(async () => { await node(r, 'reset-pw-submit').props.onPress(); });

    expect(apiMock).toHaveBeenCalledWith('/auth/reset-password', {
      method: 'POST', body: { token: 't', new_password: 'validpass123' }, auth: false,
    });
    expect(mockToast.show).toHaveBeenCalledWith(expect.stringContaining('Password updated'), 'success');
  });
});
