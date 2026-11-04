/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Email-link tokens stay out of the rendered UI, and only explicit confirmation verifies them.
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
  it('waits for confirmation before verifying the URL token', async () => {
    apiMock.mockResolvedValue({ ok: true });
    mockParams = { token: 'goodtok' };
    const r = await mountAsync();
    expect(apiMock).not.toHaveBeenCalled();
    expect(has(r, 'verify-token')).toBe(false);
    expect(JSON.stringify(r.toJSON())).not.toContain('goodtok');
    await act(async () => { await node(r, 'verify-submit').props.onPress(); });

    expect(apiMock).toHaveBeenCalledWith('/auth/verify-email', {
      method: 'POST', body: { token: 'goodtok' }, auth: false,
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalled();
    expect(has(r, 'verify-continue')).toBe(true); // success branch rendered
  });

  it('shows the retry UI and a toast when the token is rejected', async () => {
    apiMock.mockRejectedValue(new Error('This link is invalid or has expired.'));
    mockParams = { token: 'badtok' };
    const r = await mountAsync();
    expect(apiMock).not.toHaveBeenCalled();
    await act(async () => { await node(r, 'verify-submit').props.onPress(); });

    expect(mockToast.show).toHaveBeenCalledWith('This link is invalid or has expired.', 'error');
    expect(has(r, 'verify-submit')).toBe(true);
    expect(has(r, 'verify-token')).toBe(false);
    expect(JSON.stringify(r.toJSON())).not.toContain('badtok');
  });

  it('offers sign-in to request a new link when no email link was provided', async () => {
    const r = await mountAsync();
    expect(apiMock).not.toHaveBeenCalled();
    expect(has(r, 'verify-token')).toBe(false);
    expect(has(r, 'verify-submit')).toBe(false);
    expect(node(r, 'verify-back').props.label).toBe('Sign in to request a new link');

    act(() => { node(r, 'verify-back').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/(auth)/login');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('returns signed-in users to the dashboard to request a new link', async () => {
    mockUser = { id: 'user1' };
    const r = await mountAsync();

    expect(has(r, 'verify-submit')).toBe(false);
    expect(node(r, 'verify-back').props.label).toBe('Go to dashboard');
    act(() => { node(r, 'verify-back').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('continues a recovery request only after successful verification, using the proved address', async () => {
    mockParams = { token: 'recovery-verification-token' };
    mockUser = { id: 'other-account', email: 'someone.else@gmail.com' };
    apiMock.mockResolvedValueOnce({ ok: true, password_reset_email: 'proved@gmail.com' });
    apiMock.mockResolvedValueOnce({ ok: true });
    const r = await mountAsync();
    expect(has(r, 'verify-request-reset')).toBe(false);
    await act(async () => { await node(r, 'verify-submit').props.onPress(); });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(has(r, 'verify-submit')).toBe(false);
    expect(has(r, 'verify-request-reset')).toBe(true);
    await act(async () => { await node(r, 'verify-request-reset').props.onPress(); });
    expect(apiMock).toHaveBeenLastCalledWith('/auth/request-password-reset', {
      method: 'POST', body: { email: 'proved@gmail.com' }, auth: false,
    });
    expect(has(r, 'verify-request-reset')).toBe(false);
    expect(has(r, 'verify-recovery-back')).toBe(true);
    expect(node(r, 'verify-recovery-back').props.label).toBe('Back to password settings');
    act(() => { node(r, 'verify-recovery-back').props.onPress(); });
    expect(mockReplace).toHaveBeenCalledWith('/change-password');
    expect(mockReplace).not.toHaveBeenCalledWith('/(tabs)/dashboard');
    expect(JSON.stringify(r.toJSON())).not.toContain('recovery-verification-token');
  });

  it('preserves a retry after a recovery delivery request fails', async () => {
    mockParams = { token: 'recovery-token' };
    apiMock.mockResolvedValueOnce({ ok: true, password_reset_email: 'proved@gmail.com' });
    const r = await mountAsync();
    await act(async () => { await node(r, 'verify-submit').props.onPress(); });
    apiMock.mockRejectedValueOnce(new Error('Unable to connect.'));
    await act(async () => { await node(r, 'verify-request-reset').props.onPress(); });
    expect(mockToast.show).toHaveBeenCalledWith('Unable to connect.', 'error');
    expect(node(r, 'verify-request-reset').props.loading).toBe(false);
    expect(has(r, 'verify-request-reset')).toBe(true);
    expect(node(r, 'verify-recovery-back').props.label).toBe('Back to sign in');
  });
});
