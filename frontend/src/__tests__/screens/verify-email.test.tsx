/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the email-verification landing screen (app/verify-email.tsx): it auto-submits
// a token from the URL on mount, shows a success/retry state, and supports manual token entry.
const mockReplace = jest.fn();
let mockParams: any = {};
const mockToast = { show: jest.fn() };
let mockUser: any = null;
const mockRefresh = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: mockUser, refresh: mockRefresh }) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: { primary: '#000', success: '#0a0' } }) }));
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

import VerifyEmail from '../../../app/verify-email';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const node = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.testID === id);
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id).length > 0;

beforeEach(() => {
  mockReplace.mockClear(); mockToast.show.mockClear(); mockRefresh.mockClear();
  apiMock.mockReset(); mockParams = {}; mockUser = null;
});

async function mountAsync() {
  let r: any;
  await act(async () => { r = TestRenderer.create(React.createElement(VerifyEmail)); });
  return r;
}

describe('VerifyEmail screen', () => {
  it('auto-verifies a token from the URL and shows the success state', async () => {
    apiMock.mockResolvedValue({ ok: true });
    mockParams = { token: 'goodtok' };
    const r = await mountAsync();

    expect(apiMock).toHaveBeenCalledWith('/auth/verify-email', {
      method: 'POST', body: { token: 'goodtok' }, auth: false,
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(has(r, 'verify-continue')).toBe(true); // success branch rendered
  });

  it('shows the retry UI and a toast when the token is rejected', async () => {
    apiMock.mockRejectedValue(new Error('This link is invalid or has expired.'));
    mockParams = { token: 'badtok' };
    const r = await mountAsync();

    expect(mockToast.show).toHaveBeenCalledWith('This link is invalid or has expired.', 'error');
    expect(has(r, 'verify-submit')).toBe(true); // back to manual-entry / retry
  });

  it('does not auto-submit without a token and supports manual entry', async () => {
    apiMock.mockResolvedValue({ ok: true });
    mockParams = {};
    const r = await mountAsync();
    expect(apiMock).not.toHaveBeenCalled();

    act(() => { node(r, 'verify-token').props.onChangeText('typedtok'); });
    await act(async () => { await node(r, 'verify-submit').props.onPress(); });
    expect(apiMock).toHaveBeenCalledWith('/auth/verify-email', {
      method: 'POST', body: { token: 'typedtok' }, auth: false,
    });
  });
});
