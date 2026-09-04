/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../api', () => ({
  api: jest.fn(),
  getToken: jest.fn(),
  setToken: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as apiModule from '../api';
import { AuthProvider, useAuth } from '../AuthContext';

let latest: ReturnType<typeof useAuth>;
let renderer: ReactTestRenderer | null = null;

function Consumer() {
  latest = useAuth();
  return null;
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(<AuthProvider><Consumer /></AuthProvider>);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (apiModule.getToken as jest.Mock).mockResolvedValue(null);
  (apiModule.setToken as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) => (
    key === 'last_login_email' ? Promise.resolve('saved@gmail.com') : Promise.resolve(null)
  ));
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  jest.restoreAllMocks();
});

it('marks the deployed chat protocol as supported', async () => {
  (apiModule.api as jest.Mock).mockResolvedValue({
    email_features_enabled: true,
    chat_protocol_version: 1,
    multi_currency_expenses_enabled: true,
    invite_links_enabled: true,
  });
  await mount();

  expect(latest.chatCapability).toBe('supported');
  expect(latest.multiCurrencyExpensesEnabled).toBe(true);
  expect(latest.inviteLinksEnabled).toBe(true);
  expect(latest.user).toBeNull();
});

it('persists and clears a pending invite path', async () => {
  (apiModule.api as jest.Mock).mockResolvedValue({ chat_protocol_version: 1 });
  await mount();
  const path = `/invite/${'a'.repeat(43)}`;

  await act(async () => latest.rememberInvite(path));
  expect(AsyncStorage.setItem).toHaveBeenCalledWith('pending_invite_path_v1', path);
  expect(latest.pendingInvitePath).toBe(path);

  await act(async () => latest.clearPendingInvite());
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('pending_invite_path_v1');
  expect(latest.pendingInvitePath).toBeNull();
});

it('identifies a successful old-server config response as unsupported', async () => {
  (apiModule.api as jest.Mock).mockResolvedValue({ email_features_enabled: true });
  await mount();

  expect(latest.chatCapability).toBe('unsupported');
  expect(latest.multiCurrencyExpensesEnabled).toBe(false);
});

it('leaves capability unknown when public config cannot be reached', async () => {
  (apiModule.api as jest.Mock).mockRejectedValue(new Error('offline'));
  await mount();

  expect(latest.chatCapability).toBe('unknown');
  expect(latest.multiCurrencyExpensesEnabled).toBe(false);
});

it('clears invalid authentication while retaining the saved login email', async () => {
  const user = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.getToken as jest.Mock).mockResolvedValue('expired-token');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(user);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();
  expect(latest.user).toEqual(user);

  await act(async () => latest.handleAuthenticationRequired());
  expect(apiModule.setToken).toHaveBeenCalledWith(null);
  expect(latest.user).toBeNull();
  expect(latest.savedEmail).toBe('saved@gmail.com');
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
});

it('signs in with an email and password payload only', async () => {
  const user = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/login') return Promise.resolve({ access_token: 'jwt', user });
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => latest.signIn('saved@gmail.com', 'password123'));

  expect(apiModule.api).toHaveBeenCalledWith('/auth/login', {
    method: 'POST',
    body: { email: 'saved@gmail.com', password: 'password123' },
    auth: false,
  });
  expect(latest.user).toEqual(user);
});

it('registers without a PIN field', async () => {
  const user = { id: 'u2', email: 'new@gmail.com', name: 'New User', role: 'user' };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/register') return Promise.resolve({ access_token: 'jwt', user });
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => latest.register('new@gmail.com', 'New User', 'password123'));

  expect(apiModule.api).toHaveBeenCalledWith('/auth/register', {
    method: 'POST',
    body: { email: 'new@gmail.com', name: 'New User', password: 'password123' },
    auth: false,
  });
  expect(latest.user).toEqual(user);
});
