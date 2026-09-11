/* eslint-disable import/first */
import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../api', () => {
  const actual = jest.requireActual('../api');
  return {
    ...actual,
    api: jest.fn(),
    getToken: jest.fn(),
    setToken: jest.fn(),
  };
});

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
  expect(latest.multiCurrencyCapability).toBe('enabled');
  expect(latest.multiCurrencyExpensesEnabled).toBe(true);
  expect(latest.inviteLinksEnabled).toBe(true);
  expect(latest.user).toBeNull();
});

it('refreshes a changed invite rollout flag on demand before sharing', async () => {
  (apiModule.api as jest.Mock)
    .mockResolvedValueOnce({ chat_protocol_version: 1, invite_links_enabled: false })
    .mockResolvedValueOnce({ chat_protocol_version: 1, invite_links_enabled: true });
  await mount();
  expect(latest.inviteLinksEnabled).toBe(false);

  let snapshot: Awaited<ReturnType<typeof latest.refreshRuntimeConfig>> | undefined;
  await act(async () => { snapshot = await latest.refreshRuntimeConfig(); });

  expect(snapshot).toEqual({
    inviteLinksEnabled: true,
    multiCurrencyCapability: 'disabled',
  });
  expect(latest.inviteLinksEnabled).toBe(true);
  expect(apiModule.api).toHaveBeenLastCalledWith('/meta/config', { auth: false });
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
  expect(latest.multiCurrencyCapability).toBe('disabled');
  expect(latest.multiCurrencyExpensesEnabled).toBe(false);
});

it('leaves capability unknown when public config cannot be reached', async () => {
  (apiModule.api as jest.Mock).mockRejectedValue(new Error('offline'));
  await mount();

  expect(latest.chatCapability).toBe('unknown');
  expect(latest.multiCurrencyCapability).toBe('unknown');
  expect(latest.multiCurrencyExpensesEnabled).toBe(false);
});

it('retries an unknown currency capability and enables it after a successful config fetch', async () => {
  (apiModule.api as jest.Mock)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      chat_protocol_version: 1,
      multi_currency_expenses_enabled: true,
    });
  await mount();
  expect(latest.multiCurrencyCapability).toBe('unknown');

  await act(async () => { await latest.refreshRuntimeConfig(); });

  expect(latest.multiCurrencyCapability).toBe('enabled');
  expect(latest.multiCurrencyExpensesEnabled).toBe(true);
});

it('does not downgrade a previously confirmed currency capability during an outage', async () => {
  (apiModule.api as jest.Mock)
    .mockResolvedValueOnce({
      chat_protocol_version: 1,
      multi_currency_expenses_enabled: true,
    })
    .mockRejectedValueOnce(new Error('offline'));
  await mount();

  await act(async () => {
    await latest.refreshRuntimeConfig().catch(() => {});
  });

  expect(latest.multiCurrencyCapability).toBe('enabled');
  expect(latest.multiCurrencyExpensesEnabled).toBe(true);
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

it('refreshes the cached profile with the latest successful server response', async () => {
  const current = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  const updated = {
    ...current,
    upi_id: 'fresh@upi',
    upi_updated_at: '2026-09-11T10:00:00+00:00',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();
  (apiModule.api as jest.Mock).mockResolvedValueOnce(updated);

  await act(async () => { await latest.refreshUserProfile(); });

  expect(apiModule.api).toHaveBeenLastCalledWith('/auth/me');
  expect(latest.user).toEqual(updated);
});

it('retains the cached profile when a focused profile refresh has a network failure', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user', upi_id: 'cached@upi',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();
  (apiModule.api as jest.Mock).mockRejectedValueOnce(
    new apiModule.ApiError('offline', { code: 'network' }),
  );

  await act(async () => { await latest.refreshUserProfile().catch(() => {}); });

  expect(latest.user).toEqual(current);
  expect(apiModule.setToken).not.toHaveBeenCalledWith(null);
});

it('clears authentication only when profile refresh receives a confirmed HTTP 401', async () => {
  const current = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();
  (apiModule.api as jest.Mock).mockRejectedValueOnce(
    new apiModule.ApiError('expired', { code: 'http', status: 401 }),
  );

  await act(async () => { await latest.refreshUserProfile().catch(() => {}); });

  expect(apiModule.setToken).toHaveBeenCalledWith(null);
  expect(latest.user).toBeNull();
  expect(latest.savedEmail).toBe('saved@gmail.com');
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
  expect(latest.upiOnboardingPending).toBe(false);
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
  expect(latest.upiOnboardingPending).toBe(true);
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.map(([key]) => key))
    .not.toContain('upi_onboarding_pending');
});

it('keeps first-time Google UPI onboarding volatile and clears it explicitly', async () => {
  const user = {
    id: 'u3', email: 'google@gmail.com', name: 'Google User', role: 'user',
    credentials_set: false,
  };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/google') return Promise.resolve({ access_token: 'jwt', user });
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => { await latest.signInWithGoogle('google-id-token'); });
  expect(latest.upiOnboardingPending).toBe(true);

  act(() => latest.completeUpiOnboarding());
  expect(latest.upiOnboardingPending).toBe(false);
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.map(([key]) => key))
    .not.toContain('upi_onboarding_pending');
});

it('validates, trims, saves, and adopts the server UPI profile response', async () => {
  const current = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  const updated = {
    ...current,
    upi_id: 'Ravi.Pay@OkSbi',
    upi_updated_at: '2026-09-11T10:00:00+00:00',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me' && opts?.method === 'PATCH') return Promise.resolve(updated);
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  let result: Awaited<ReturnType<typeof latest.updateUpiId>> | undefined;
  await act(async () => { result = await latest.updateUpiId('  Ravi.Pay@OkSbi  '); });

  expect(apiModule.api).toHaveBeenCalledWith('/auth/me', {
    method: 'PATCH', body: { upi_id: 'Ravi.Pay@OkSbi' },
  });
  expect(result).toEqual(updated);
  expect(latest.user).toEqual(updated);
});

it('supports explicit UPI removal and adopts the null server fields', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    upi_id: 'ravi@upi', upi_updated_at: '2026-09-10T10:00:00+00:00',
  };
  const cleared = { ...current, upi_id: null, upi_updated_at: null };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me' && opts?.method === 'PATCH') return Promise.resolve(cleared);
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => { await latest.updateUpiId(null); });

  expect(apiModule.api).toHaveBeenCalledWith('/auth/me', {
    method: 'PATCH', body: { upi_id: null },
  });
  expect(latest.user).toEqual(cleared);
});

it('rejects an invalid UPI ID locally without changing user state', async () => {
  const current = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await expect(latest.updateUpiId('bad value@upi')).rejects.toThrow(/valid UPI ID/i);

  expect(apiModule.api).not.toHaveBeenCalledWith('/auth/me', expect.objectContaining({ method: 'PATCH' }));
  expect(latest.user).toEqual(current);
});

it('keeps the previous UPI profile when the server save fails', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    upi_id: 'old@upi', upi_updated_at: '2026-09-10T10:00:00+00:00',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me' && opts?.method === 'PATCH') return Promise.reject(new Error('offline'));
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => {
    await latest.updateUpiId('new@upi').catch(() => {});
  });

  expect(latest.user).toEqual(current);
});

it('keeps the previous UPI profile when the server removal fails', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    upi_id: 'keep@upi', upi_updated_at: '2026-09-10T10:00:00+00:00',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me' && opts?.method === 'PATCH') return Promise.reject(new Error('offline'));
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => {
    await latest.updateUpiId(null).catch(() => {});
  });

  expect(latest.user).toEqual(current);
});
