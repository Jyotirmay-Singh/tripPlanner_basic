/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the forgot-PASSWORD request screen (app/(auth)/forgot-password.tsx): gmail-only
// inline validation, and the generic "check your email" confirmation after a successful request.
const mockReplace = jest.fn();
const mockToast = { show: jest.fn() };

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
}));
jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../ui', () => {
  const R = require('react');
  return {
    __esModule: true,
    AuthShell: ({ children }: any) => R.createElement('AuthShell', null, children),
    Input: (p: any) => R.createElement('Input', p),
    Button: (p: any) => R.createElement('Button', p),
    useToast: () => mockToast,
  };
});

import ForgotPassword from '../../../app/(auth)/forgot-password';
import { api } from '../../api';
import { GMAIL_ONLY_MESSAGE } from '../../validation';

const apiMock = api as unknown as jest.Mock;
const node = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.testID === id);
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id).length > 0;

beforeEach(() => {
  mockReplace.mockClear();
  mockToast.show.mockClear();
  apiMock.mockReset();
});

function mount() {
  let r: any;
  act(() => { r = TestRenderer.create(React.createElement(ForgotPassword)); });
  return r;
}

describe('ForgotPassword screen', () => {
  it('rejects a non-gmail address (inline error, no API call)', async () => {
    const r = mount();
    act(() => { node(r, 'forgot-pw-email').props.onChangeText('me@yahoo.com'); });
    await act(async () => { await node(r, 'forgot-pw-submit').props.onPress(); });

    expect(mockToast.show).toHaveBeenCalledWith(GMAIL_ONLY_MESSAGE, 'error');
    expect(apiMock).not.toHaveBeenCalled();
    expect(node(r, 'forgot-pw-email').props.error).toBe(GMAIL_ONLY_MESSAGE);
  });

  it('posts the email and shows the generic confirmation state', async () => {
    apiMock.mockResolvedValue({ ok: true, message: 'If this email exists, a reset link has been sent.' });
    const r = mount();
    act(() => { node(r, 'forgot-pw-email').props.onChangeText('me@gmail.com'); });
    await act(async () => { await node(r, 'forgot-pw-submit').props.onPress(); });

    expect(apiMock).toHaveBeenCalledWith('/auth/request-password-reset', {
      method: 'POST', body: { email: 'me@gmail.com' }, auth: false,
    });
    expect(has(r, 'forgot-pw-back')).toBe(true); // "Check your email" confirmation
  });
});
