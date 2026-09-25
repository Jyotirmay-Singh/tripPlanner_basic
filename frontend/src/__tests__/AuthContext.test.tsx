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
    getAllKeys: jest.fn(),
    multiRemove: jest.fn(),
  },
}));

jest.mock('../offlineStore', () => ({
  offlineStore: {
    setActiveAccount: jest.fn(),
    getIdentity: jest.fn(),
    saveIdentity: jest.fn(),
    pendingCount: jest.fn(),
    purgeAccount: jest.fn(),
  },
}));
jest.mock('../chatOutboxCleanup', () => ({ purgeAccountChatOutbox: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as apiModule from '../api';
import { AuthProvider, useAuth } from '../AuthContext';
import { offlineStore } from '../offlineStore';
import { purgeAccountChatOutbox } from '../chatOutboxCleanup';
import type { CachedIdentityRecord } from '../offlineStore.shared';

let latest: ReturnType<typeof useAuth>;
let renderer: ReactTestRenderer | null = null;
let activeAccount: string | null = null;
const identities = new Map<string, CachedIdentityRecord>();

function token(userId: string, expiresAt: number): string {
  return `header.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(expiresAt / 1000) }))
    .toString('base64url')}.signature`;
}

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
  identities.clear();
  activeAccount = null;
  (NetInfo.addEventListener as jest.Mock).mockImplementation(() => jest.fn());
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (apiModule.getToken as jest.Mock).mockResolvedValue(null);
  (apiModule.setToken as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) => (
    key === 'last_login_email' ? Promise.resolve('saved@gmail.com') : Promise.resolve(null)
  ));
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.getAllKeys as jest.Mock).mockResolvedValue([]);
  (AsyncStorage.multiRemove as jest.Mock).mockResolvedValue(undefined);
  (offlineStore.setActiveAccount as jest.Mock).mockImplementation((id) => { activeAccount = id; });
  (offlineStore.getIdentity as jest.Mock).mockImplementation(async (id) => {
    if (id !== activeAccount) throw new Error('account mismatch');
    return identities.get(id) ?? null;
  });
  (offlineStore.saveIdentity as jest.Mock).mockImplementation(async (record) => {
    if (record.profile.id !== activeAccount) throw new Error('account mismatch');
    identities.set(record.profile.id, record);
  });
  (offlineStore.pendingCount as jest.Mock).mockResolvedValue(0);
  (offlineStore.purgeAccount as jest.Mock).mockImplementation(async (id) => { identities.delete(id); });
  (purgeAccountChatOutbox as jest.Mock).mockResolvedValue(undefined);
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

it('clears every local identity hint after server-confirmed account deletion', async () => {
  const user = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(user);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();
  await act(async () => latest.rememberInvite(`/invite/${'b'.repeat(43)}`));

  await act(async () => latest.finalizeAccountDeletion());

  expect(apiModule.setToken).toHaveBeenCalledWith(null);
  expect(offlineStore.purgeAccount).toHaveBeenCalledWith('u1');
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('last_login_email');
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('pending_invite_path_v1');
  expect(latest.user).toBeNull();
  expect(latest.savedEmail).toBeNull();
  expect(latest.pendingInvitePath).toBeNull();
  expect(latest.mobileOnboardingPending).toBe(false);
  expect(latest.upiOnboardingPending).toBe(false);
});

it('restores a sanitized verified identity after process restart and network failure', async () => {
  const jwt = token('u1', Date.now() + 10 * 24 * 60 * 60 * 1000);
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    credentials_set: true, mobile_number: '+919876543210', upi_id: 'ravi@upi',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue(jwt);
  (apiModule.api as jest.Mock).mockImplementation((path: string) => path === '/auth/me'
    ? Promise.resolve(current) : Promise.resolve({}));
  await mount();
  expect(identities.get('u1')?.profile).not.toHaveProperty('upi_id');
  expect(identities.get('u1')?.profile).not.toHaveProperty('mobile_number');
  act(() => renderer?.unmount());
  renderer = null;

  (apiModule.api as jest.Mock).mockRejectedValue(
    new apiModule.ApiError('offline', { code: 'network' }),
  );
  await mount();
  expect(latest.user).toEqual(identities.get('u1')?.profile);
  expect(latest.sessionMode).toBe('offline');
  expect(apiModule.setToken).not.toHaveBeenCalledWith(null);
});

it('retains a token but requires online restoration when no identity was cached', async () => {
  (apiModule.getToken as jest.Mock).mockResolvedValue(token('u1', Date.now() + 86_400_000));
  (apiModule.api as jest.Mock).mockRejectedValue(
    new apiModule.ApiError('offline', { code: 'timeout' }),
  );
  await mount();
  expect(latest.user).toBeNull();
  expect(latest.sessionMode).toBe('online_required');
  expect(latest.sessionNotice).toMatch(/connect/i);
  expect(apiModule.setToken).not.toHaveBeenCalledWith(null);
});

it('locks cached identity on a confirmed 401 without deleting local rows', async () => {
  const jwt = token('u1', Date.now() + 86_400_000);
  identities.set('u1', {
    profile: { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' },
    verifiedAt: Date.now() - 1000, tokenExpiresAt: sessionExpiration(jwt),
  });
  (apiModule.getToken as jest.Mock).mockResolvedValue(jwt);
  (apiModule.api as jest.Mock).mockRejectedValue(
    new apiModule.ApiError('expired', { code: 'http', status: 401 }),
  );
  await mount();
  expect(latest.user).toBeNull();
  expect(apiModule.setToken).toHaveBeenCalledWith(null);
  expect(identities.has('u1')).toBe(true);
  expect(offlineStore.purgeAccount).not.toHaveBeenCalled();
});

it('keeps account A cached rows hidden when account B signs in', async () => {
  const first = { id: 'u1', email: 'a@gmail.com', name: 'A', role: 'user' };
  const second = { id: 'u2', email: 'b@gmail.com', name: 'B', role: 'user' };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({});
    if (path === '/auth/login') return Promise.resolve({
      access_token: token('u2', Date.now() + 86_400_000), user: second,
    });
    return Promise.reject(new Error('unexpected request'));
  });
  await mount();
  identities.set('u1', {
    profile: first, verifiedAt: Date.now(), tokenExpiresAt: Date.now() + 86_400_000,
  });
  await act(async () => { await latest.signIn(second.email, 'password123'); });
  expect(latest.user?.id).toBe('u2');
  expect(activeAccount).toBe('u2');
  await expect(offlineStore.getIdentity('u1')).rejects.toThrow('account mismatch');
  expect(identities.has('u1')).toBe(true);
});

it('ignores an old account profile response after switching accounts', async () => {
  const first = { id: 'u1', email: 'a@gmail.com', name: 'A', role: 'user' };
  const second = { id: 'u2', email: 'b@gmail.com', name: 'B', role: 'user' };
  let finishProfile!: (value: typeof first) => void;
  (apiModule.api as jest.Mock).mockImplementation((path: string, options?: { body?: { email: string } }) => {
    if (path === '/meta/config') return Promise.resolve({});
    if (path === '/auth/login') {
      const selected = options?.body?.email === first.email ? first : second;
      return Promise.resolve({ access_token: token(selected.id, Date.now() + 86_400_000), user: selected });
    }
    if (path === '/auth/me') return new Promise((resolve) => { finishProfile = resolve; });
    return Promise.reject(new Error('unexpected request'));
  });
  await mount();
  await act(async () => { await latest.signIn(first.email, 'password123'); });
  let oldRefresh!: Promise<void>;
  act(() => { oldRefresh = latest.refreshUserProfile(); });
  await act(async () => { await latest.signIn(second.email, 'password123'); });
  await act(async () => { finishProfile(first); await oldRefresh; });
  expect(latest.user?.id).toBe('u2');
  expect(activeAccount).toBe('u2');
});

it('locks the session and retains a cleanup marker if confirmed deletion cannot purge local data', async () => {
  const current = { id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user' };
  (apiModule.getToken as jest.Mock).mockResolvedValue(token('u1', Date.now() + 86_400_000));
  (apiModule.api as jest.Mock).mockImplementation((path: string) => path === '/auth/me'
    ? Promise.resolve(current) : Promise.resolve({}));
  await mount();
  (offlineStore.purgeAccount as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));

  await act(async () => { await latest.finalizeAccountDeletion().catch(() => {}); });

  expect(latest.user).toBeNull();
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'pending_deleted_account_local_purge_v1', 'u1',
  );
  expect(AsyncStorage.removeItem).not.toHaveBeenCalledWith('pending_deleted_account_local_purge_v1');
  expect(latest.sessionNotice).toMatch(/account deleted/i);
});

function sessionExpiration(jwt: string): number {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp * 1000;
}

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

  expect(apiModule.api).toHaveBeenLastCalledWith('/auth/me', { timeoutMs: 10_000 });
  expect(latest.user).toEqual(updated);
});

it('retains the cached profile when a focused profile refresh has a network failure', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user', upi_id: 'cached@upi',
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue(token('u1', Date.now() + 86_400_000));
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

  await act(async () => { await latest.signIn('saved@gmail.com', 'password123'); });

  expect(apiModule.api).toHaveBeenCalledWith('/auth/login', {
    method: 'POST',
    body: { email: 'saved@gmail.com', password: 'password123' },
    auth: false,
  });
  expect(latest.user).toEqual(user);
  expect(latest.mobileOnboardingPending).toBe(true);
  expect(latest.upiOnboardingPending).toBe(false);

  act(() => latest.completeMobileOnboarding());
  expect(latest.mobileOnboardingPending).toBe(false);
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.map(([key]) => key))
    .not.toContain('mobile_onboarding_pending');
});

it('does not offer mobile onboarding after an explicit login with a saved number', async () => {
  const user = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    mobile_number: '+919876543210', mobile_country_code: 'IN',
  };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/login') return Promise.resolve({ access_token: 'jwt', user });
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => { await latest.signIn('saved@gmail.com', 'password123'); });

  expect(latest.mobileOnboardingPending).toBe(false);
});

it('does not recreate mobile onboarding while restoring a session without a number', async () => {
  const user = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    mobile_number: null, mobile_country_code: null,
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue(token('u1', Date.now() + 86_400_000));
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me') return Promise.resolve(user);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  expect(latest.user).toEqual(user);
  expect(latest.mobileOnboardingPending).toBe(false);
});

it('registers without a PIN field', async () => {
  const user = { id: 'u2', email: 'new@gmail.com', name: 'New User', role: 'user' };
  (apiModule.api as jest.Mock).mockImplementation((path: string) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/register') return Promise.resolve({ access_token: 'jwt', user });
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => { await latest.register('new@gmail.com', 'New User', 'password123'); });

  expect(apiModule.api).toHaveBeenCalledWith('/auth/register', {
    method: 'POST',
    body: { email: 'new@gmail.com', name: 'New User', password: 'password123' },
    auth: false,
  });
  expect(latest.user).toEqual(user);
  expect(latest.mobileOnboardingPending).toBe(true);
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
  expect(latest.mobileOnboardingPending).toBe(true);
  expect(latest.upiOnboardingPending).toBe(true);

  act(() => latest.completeMobileOnboarding());
  expect(latest.mobileOnboardingPending).toBe(false);

  act(() => latest.completeUpiOnboarding());
  expect(latest.upiOnboardingPending).toBe(false);
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.map(([key]) => key))
    .not.toContain('upi_onboarding_pending');
});

it('saves a canonical mobile profile and adopts the server response', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    mobile_number: null, mobile_country_code: null,
  };
  const updated = {
    ...current,
    mobile_number: '+919876543210',
    mobile_country_code: 'IN' as const,
    mobile_verified_at: null,
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me/mobile' && opts?.method === 'PATCH') return Promise.resolve(updated);
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  let result: Awaited<ReturnType<typeof latest.updateMobileNumber>> | undefined;
  await act(async () => {
    result = await latest.updateMobileNumber('98765 43210', 'IN');
  });

  expect(apiModule.api).toHaveBeenCalledWith('/auth/me/mobile', {
    method: 'PATCH',
    body: { mobile_number: '+919876543210', mobile_country_code: 'IN' },
  });
  expect(result).toEqual(updated);
  expect(latest.user).toEqual(updated);
});

it('removal stays skipped for this session but the next explicit login is eligible', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    mobile_number: '+919876543210', mobile_country_code: 'IN' as const,
  };
  const cleared = {
    ...current, mobile_number: null, mobile_country_code: null, mobile_verified_at: null,
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me/mobile' && opts?.method === 'PATCH') return Promise.resolve(cleared);
    if (path === '/auth/login') return Promise.resolve({ access_token: 'new-jwt', user: cleared });
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => { await latest.updateMobileNumber(null, null); });
  expect(latest.mobileOnboardingPending).toBe(false);
  expect(latest.user).toEqual(cleared);

  await act(async () => { await latest.signIn('saved@gmail.com', 'password123'); });
  expect(latest.mobileOnboardingPending).toBe(true);
});

it('keeps the prior mobile profile when a trip conflict rejects the save', async () => {
  const current = {
    id: 'u1', email: 'saved@gmail.com', name: 'Ravi', role: 'user',
    mobile_number: '+919111111111', mobile_country_code: 'IN' as const,
  };
  (apiModule.getToken as jest.Mock).mockResolvedValue('jwt');
  (apiModule.api as jest.Mock).mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/meta/config') return Promise.resolve({ chat_protocol_version: 1 });
    if (path === '/auth/me/mobile' && opts?.method === 'PATCH') {
      return Promise.reject(new apiModule.ApiError(
        'This mobile number is already used by Mina in Kerala.',
        { code: 'http', status: 409, detailCode: 'trip_mobile_conflict' },
      ));
    }
    if (path === '/auth/me') return Promise.resolve(current);
    return Promise.reject(new Error('unexpected path'));
  });
  await mount();

  await act(async () => {
    await latest.updateMobileNumber('9876543210', 'IN').catch(() => {});
  });

  expect(latest.user).toEqual(current);
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
