import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { syncCoordinator } from './syncWorker';
import { ApiError, api, getToken, setToken, subscribeUnauthorized } from './api';
import type { ChatCapability } from './chat';
import { unregisterCurrentPushInstallation } from './pushNotifications';
import { isValidUpiId, normalizeUpiId, UPI_ID_INVALID_MESSAGE } from './validation';
import { canonicalMobileNumber } from './mobileNumber';
import { offlineStore } from './offlineStore';
import { purgeAccountChatOutbox } from './chatOutboxCleanup';
import { sanitizedIdentity, type CachedIdentityRecord } from './offlineStore.shared';
import { offlineAccessAllowed, sessionClaims } from './sessionClaims';
import type { CountryCode } from 'libphonenumber-js';

export type MultiCurrencyCapability = 'loading' | 'enabled' | 'disabled' | 'unknown';

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_super_admin?: boolean;
  // Phase 9 (additive, optional so older payloads stay valid): email verification + whether a
  // Google-created account has configured its required local password.
  email_verified?: boolean;
  credentials_set?: boolean;
  // Optional for compatibility while the additive backend fields roll out.
  upi_id?: string | null;
  upi_updated_at?: string | null;
  mobile_number?: string | null;
  mobile_country_code?: CountryCode | null;
  mobile_verified_at?: string | null;
};

const SAVED_EMAIL_KEY = 'last_login_email';
const PENDING_INVITE_KEY = 'pending_invite_path_v1';
const PENDING_LOCAL_PURGE_KEY = 'pending_deleted_account_local_purge_v1';

export type SessionMode = 'online' | 'offline' | 'online_required';

function transientAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'network' || error.code === 'timeout'
    || error.code === 'aborted' || (error.code === 'http' && !!error.status
      && (error.status >= 500 || error.status === 429)));
}

type Ctx = {
  user: User | null | undefined; // undefined = loading
  sessionMode: SessionMode;
  sessionNotice: string | null;
  offlineStorageError: string | null;
  savedEmail: string | null;
  // Runtime feature flag from GET /meta/config. When false, the email-verification banner and the
  // "Forgot password?" link are hidden (those flows are ghosted until a deliverable domain exists).
  // Defaults to true so nothing is hidden while it loads or if the fetch fails.
  emailFeaturesEnabled: boolean;
  inviteLinksEnabled: boolean;
  pendingInvitePath: string | null;
  // Volatile: explicit authentication may offer mobile setup, but token restoration never does.
  mobileOnboardingPending: boolean;
  // Volatile by design: only an account created in this running app session receives the
  // optional UPI offer. Restoring a session after an app restart must never recreate it.
  upiOnboardingPending: boolean;
  multiCurrencyCapability: MultiCurrencyCapability;
  multiCurrencyExpensesEnabled: boolean;
  chatCapability: ChatCapability;
  refreshRuntimeConfig: () => Promise<RuntimeConfigSnapshot>;
  refreshUserProfile: () => Promise<void>;
  handleAuthenticationRequired: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<User>;
  register: (email: string, name: string, password: string) => Promise<User>;
  signInWithGoogle: (idToken: string) => Promise<User>;
  updateMobileNumber: (mobileNumber: string | null, countryCode: CountryCode | null) => Promise<User>;
  completeMobileOnboarding: () => void;
  updateUpiId: (upiId: string | null) => Promise<User>;
  completeUpiOnboarding: () => void;
  signOut: (clearSavedEmail?: boolean) => Promise<void>;
  finalizeAccountDeletion: () => Promise<void>;
  forgetSavedEmail: () => Promise<void>;
  refresh: () => Promise<void>;
  pendingActionCount: () => Promise<number>;
  rememberInvite: (path: string) => Promise<void>;
  clearPendingInvite: () => Promise<void>;
};

export type RuntimeConfigSnapshot = {
  inviteLinksEnabled: boolean;
  multiCurrencyCapability: Exclude<MultiCurrencyCapability, 'loading' | 'unknown'>;
};

const AuthCtx = createContext<Ctx>({} as Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [sessionMode, setSessionMode] = useState<SessionMode>('online_required');
  const [offlineDeadline, setOfflineDeadline] = useState<number | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [offlineStorageError, setOfflineStorageError] = useState<string | null>(null);
  const authGeneration = useRef(0);
  const lastVerifiedAt = useRef(0);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [emailFeaturesEnabled, setEmailFeaturesEnabled] = useState(true);
  const [inviteLinksEnabled, setInviteLinksEnabled] = useState(false);
  const [pendingInvitePath, setPendingInvitePath] = useState<string | null>(null);
  const [mobileOnboardingPending, setMobileOnboardingPending] = useState(false);
  const [upiOnboardingPending, setUpiOnboardingPending] = useState(false);
  const [multiCurrencyCapability, setMultiCurrencyCapability] =
    useState<MultiCurrencyCapability>('loading');
  const [chatCapability, setChatCapability] = useState<ChatCapability>('loading');
  const multiCurrencyExpensesEnabled = multiCurrencyCapability === 'enabled';

  // Public, DB-free capability fetch. It is callable by share actions so a long-running app never
  // relies on the flag value captured at launch during a coordinated backend/APK rollout.
  const refreshRuntimeConfig = useCallback(async (): Promise<RuntimeConfigSnapshot> => {
    setMultiCurrencyCapability((current) =>
      current === 'unknown' || current === 'loading' ? 'loading' : current
    );
    try {
      const config = await api<{
      email_features_enabled?: boolean;
      invite_links_enabled?: boolean;
      chat_protocol_version?: number;
      multi_currency_expenses_enabled?: boolean;
      expense_create_protocol_version?: number;
      payment_create_protocol_version?: number;
      }>('/meta/config', { auth: false });
      const linksEnabled = config?.invite_links_enabled === true;
      const currencyCapability = config?.multi_currency_expenses_enabled === true
        ? 'enabled'
        : 'disabled';
      setEmailFeaturesEnabled(config?.email_features_enabled !== false);
      setInviteLinksEnabled(linksEnabled);
      setMultiCurrencyCapability(currencyCapability);
      setChatCapability(config?.chat_protocol_version === 1 ? 'supported' : 'unsupported');
      const expenseCreateProtocolVersion = config?.expense_create_protocol_version === 1 ? 1 : 0;
      const paymentCreateProtocolVersion = config?.payment_create_protocol_version === 1 ? 1 : 0;
      if (user?.id) {
        await Promise.all([
          offlineStore.setExpenseProtocolVersion(user.id, expenseCreateProtocolVersion),
          offlineStore.setPaymentProtocolVersion(user.id, paymentCreateProtocolVersion),
        ].map((operation) => operation.catch(() => {})));
      }
      return { inviteLinksEnabled: linksEnabled, multiCurrencyCapability: currencyCapability };
    } catch (error) {
      // A temporary config outage must not downgrade a capability that was already confirmed.
      setChatCapability((current) => current === 'loading' ? 'unknown' : current);
      setMultiCurrencyCapability((current) =>
        current === 'enabled' || current === 'disabled' ? current : 'unknown'
      );
      throw error;
    }
  }, [user?.id]);

  useEffect(() => {
    void refreshRuntimeConfig().catch(() => {});
  }, [refreshRuntimeConfig]);

  const cacheVerifiedIdentity = useCallback(async (
    profile: User, token: string | null, generation: number = authGeneration.current,
  ) => {
    if (generation !== authGeneration.current) return;
    const claims = token ? sessionClaims(token) : null;
    offlineStore.setActiveAccount(profile.id);
    const verifiedAt = Date.now();
    lastVerifiedAt.current = verifiedAt;
    setOfflineDeadline(null);
    if (!claims || claims.userId !== profile.id || claims.expiresAt <= Date.now()) {
      if (generation === authGeneration.current) {
        setOfflineStorageError('This session cannot be used offline until you sign in again.');
      }
      return;
    }
    try {
      await offlineStore.saveIdentity({
        profile: sanitizedIdentity(profile),
        verifiedAt,
        tokenExpiresAt: claims.expiresAt,
      });
      // Expire confirmed cache opportunistically after a verified sign-in. Cleanup failure
      // must not undo a successfully saved identity or interrupt the online session.
      void offlineStore.pruneRetainedData(profile.id, verifiedAt).catch(() => {});
      if (generation === authGeneration.current) setOfflineStorageError(null);
    } catch {
      // Online authentication remains usable. An unreadable local store is never reset here.
      if (generation === authGeneration.current) {
        setOfflineStorageError('Offline storage is unavailable. Your saved local data was not cleared.');
      }
    }
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refreshRuntimeConfig().catch(() => {});
    });
    return () => subscription?.remove?.();
  }, [refreshRuntimeConfig]);

  const handleAuthenticationRequired = useCallback(async () => {
    try {
      await setToken(null);
    } catch {
      setOfflineStorageError('The invalid token could not be removed from device storage.');
    }
    authGeneration.current += 1;
    lastVerifiedAt.current = 0;
    setOfflineDeadline(null);
    offlineStore.setActiveAccount(null);
    setMobileOnboardingPending(false);
    setUpiOnboardingPending(false);
    setUser(null);
    setSessionMode('online_required');
    setSessionNotice('Your session expired. Sign in to access this account again.');
  }, []);

  useEffect(() => subscribeUnauthorized((failedToken) => {
    void getToken().then((currentToken) => {
      if (currentToken === failedToken) void handleAuthenticationRequired();
    }).catch(() => {});
  }), [handleAuthenticationRequired]);

  useEffect(() => {
    const accountId = sessionMode === 'online_required' ? null : user?.id ?? null;
    syncCoordinator.setAccount(accountId, () => { void handleAuthenticationRequired(); });
    if (!accountId) return () => { syncCoordinator.setAccount(null); };
    const appSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncCoordinator.wake(accountId);
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected) syncCoordinator.wake(accountId);
    });
    return () => {
      appSubscription?.remove?.();
      networkSubscription();
      syncCoordinator.setAccount(null);
    };
  }, [user?.id, sessionMode, handleAuthenticationRequired]);

  const refreshUserProfile = useCallback(async () => {
    const generation = authGeneration.current;
    try {
      const updated = await api<User>('/auth/me', { timeoutMs: 10_000 });
      if (generation !== authGeneration.current) return;
      await cacheVerifiedIdentity(updated, await getToken().catch(() => null), generation);
      if (generation !== authGeneration.current) return;
      setUser(updated);
      setSessionMode('online');
      setSessionNotice(null);
    } catch (error) {
      if (generation !== authGeneration.current) return;
      // A transient outage must not erase a usable cached profile. Only the API client's
      // authenticated HTTP 401 classification confirms that this session is no longer valid.
      if (error instanceof ApiError && error.code === 'http' && error.status === 401) {
        await handleAuthenticationRequired();
      } else if (transientAuthError(error)) {
        const currentToken = await getToken().catch(() => null);
        const claims = currentToken ? sessionClaims(currentToken) : null;
        if (offlineAccessAllowed(claims, lastVerifiedAt.current)) {
          setSessionMode('offline');
          setOfflineDeadline(Math.min(
            claims!.expiresAt,
            lastVerifiedAt.current + 30 * 24 * 60 * 60 * 1000,
          ));
        } else {
          offlineStore.setActiveAccount(null);
          setUser(null);
          setSessionMode('online_required');
          setSessionNotice('Offline access expired. Sign in online to continue.');
        }
      }
      throw error;
    }
  }, [cacheVerifiedIdentity, handleAuthenticationRequired]);

  useEffect(() => {
    if (sessionMode !== 'offline' || !offlineDeadline) return;
    const enforceDeadline = () => {
      if (Date.now() >= offlineDeadline || Date.now() < lastVerifiedAt.current) {
        offlineStore.setActiveAccount(null);
        setUser(null);
        setSessionMode('online_required');
        setSessionNotice('Offline access expired. Sign in online to continue.');
      }
    };
    enforceDeadline();
    const timer = setInterval(enforceDeadline, 60_000);
    return () => clearInterval(timer);
  }, [sessionMode, offlineDeadline]);

  useEffect(() => {
    if (sessionMode !== 'offline' || !user) return;
    let active = true;
    let checking = false;
    let lastAttempt = 0;
    const check = () => {
      const now = Date.now();
      if (!active || checking || now - lastAttempt < 5_000) return;
      checking = true;
      lastAttempt = now;
      void refreshUserProfile().catch(() => {}).finally(() => { checking = false; });
    };
    const appSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    const networkSubscription = NetInfo.addEventListener((state) => {
      if (state.isConnected) check();
    });
    return () => {
      active = false;
      appSubscription?.remove?.();
      networkSubscription();
    };
  }, [sessionMode, user, refreshUserProfile]);

  const refresh = useCallback(async () => {
    const generation = authGeneration.current;
    let purgeFailed = false;
    let pendingPurge: string | null = null;
    try {
      pendingPurge = await AsyncStorage.getItem(PENDING_LOCAL_PURGE_KEY);
    } catch {
      purgeFailed = true;
    }
    if (pendingPurge) {
      try {
        offlineStore.setActiveAccount(pendingPurge);
        await offlineStore.purgeAccount(pendingPurge);
        await purgeAccountChatOutbox(pendingPurge);
        await AsyncStorage.removeItem(PENDING_LOCAL_PURGE_KEY);
      } catch {
        purgeFailed = true;
      }
    }
    let t: string | null;
    let e: string | null;
    let pending: string | null;
    try {
      [t, e, pending] = await Promise.all([
        getToken(), AsyncStorage.getItem(SAVED_EMAIL_KEY), AsyncStorage.getItem(PENDING_INVITE_KEY),
      ]);
    } catch {
      if (generation !== authGeneration.current) return;
      setUser(null);
      setSessionMode('online_required');
      setSessionNotice('The saved session could not be read. Try again when storage is available.');
      return;
    }
    if (generation !== authGeneration.current) return;
    setSavedEmail(e);
    // A freshly opened deep link can be remembered while this startup read is still in flight.
    // Never let an older null read overwrite that newer in-memory invitation.
    setPendingInvitePath((current) => pending ?? current);
    if (!t) {
      offlineStore.setActiveAccount(null);
      setMobileOnboardingPending(false);
      setUpiOnboardingPending(false);
      setUser(null);
      setSessionMode('online_required');
      if (purgeFailed) setOfflineStorageError('Local account cleanup needs another retry.');
      return;
    }
    const claims = sessionClaims(t);
    if (purgeFailed && pendingPurge && claims?.userId === pendingPurge) {
      offlineStore.setActiveAccount(null);
      setUser(null);
      setSessionMode('online_required');
      setSessionNotice('This account was deleted. Local cleanup must finish before it can be opened.');
      setOfflineStorageError('Local account cleanup needs another retry.');
      return;
    }
    offlineStore.setActiveAccount(claims?.userId ?? null);
    let cached: CachedIdentityRecord | null = null;
    if (claims) {
      try {
        cached = await offlineStore.getIdentity(claims.userId);
      } catch {
        setOfflineStorageError('Offline storage is unavailable. Your saved local data was not cleared.');
      }
    }
    if (generation !== authGeneration.current) return;
    try {
      const u = await api<User>('/auth/me', { timeoutMs: 10_000 });
      if (generation !== authGeneration.current) return;
      await cacheVerifiedIdentity(u, t, generation);
      if (generation !== authGeneration.current) return;
      setUser(u);
      setSessionMode('online');
      setSessionNotice(null);
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.code === 'http' && error.status === 401) {
        await handleAuthenticationRequired();
        return;
      }
      setMobileOnboardingPending(false);
      setUpiOnboardingPending(false);
      const unexpired = cached && claims && cached.profile.id === claims.userId
        && offlineAccessAllowed(
          { ...claims, expiresAt: Math.min(claims.expiresAt, cached.tokenExpiresAt) },
          cached.verifiedAt,
        );
      if (transientAuthError(error) && unexpired && cached && cached.profile.credentials_set !== false) {
        lastVerifiedAt.current = cached.verifiedAt;
        setUser(cached.profile);
        setSessionMode('offline');
        setOfflineDeadline(Math.min(
          claims!.expiresAt, cached.tokenExpiresAt,
          cached.verifiedAt + 30 * 24 * 60 * 60 * 1000,
        ));
        setSessionNotice(null);
      } else {
        offlineStore.setActiveAccount(null);
        setUser(null);
        setSessionMode('online_required');
        setOfflineDeadline(null);
        setSessionNotice(cached?.profile.credentials_set === false
          ? 'Connect to finish password setup before opening this account.'
          : claims && Date.now() >= claims.expiresAt
            ? 'Offline access expired. Sign in online to continue.'
            : 'Connect to the server to restore this session. Your token was kept.');
      }
    }
    if (purgeFailed) setOfflineStorageError('Local account cleanup needs another retry.');
  }, [cacheVerifiedIdentity, handleAuthenticationRequired]);

  useEffect(() => { refresh(); }, [refresh]);

  const rememberInvite = useCallback(async (path: string) => {
    await AsyncStorage.setItem(PENDING_INVITE_KEY, path);
    setPendingInvitePath(path);
  }, []);

  const clearPendingInvite = useCallback(async () => {
    await AsyncStorage.removeItem(PENDING_INVITE_KEY);
    setPendingInvitePath(null);
  }, []);

  const signIn = async (email: string, password: string) => {
    const res = await api<{ access_token: string; user: User }>('/auth/login', {
      method: 'POST', body: { email, password }, auth: false,
    });
    await setToken(res.access_token);
    const generation = ++authGeneration.current;
    await cacheVerifiedIdentity(res.user, res.access_token, generation);
    if (generation !== authGeneration.current) throw new Error('The active account changed');
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setMobileOnboardingPending(!res.user.mobile_number);
    setUpiOnboardingPending(false);
    setUser(res.user);
    setSessionMode('online');
    setSessionNotice(null);
    return res.user;
  };

  const register = async (email: string, name: string, password: string) => {
    const res = await api<{ access_token: string; user: User }>('/auth/register', {
      method: 'POST', body: { email, name, password }, auth: false,
    });
    await setToken(res.access_token);
    const generation = ++authGeneration.current;
    await cacheVerifiedIdentity(res.user, res.access_token, generation);
    if (generation !== authGeneration.current) throw new Error('The active account changed');
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setMobileOnboardingPending(!res.user.mobile_number);
    setUpiOnboardingPending(true);
    setUser(res.user);
    setSessionMode('online');
    setSessionNotice(null);
    return res.user;
  };

  const signInWithGoogle = async (idToken: string): Promise<User> => {
    const res = await api<{ access_token: string; user: User }>('/auth/google', {
      method: 'POST', body: { id_token: idToken }, auth: false,
    });
    await setToken(res.access_token);
    const generation = ++authGeneration.current;
    await cacheVerifiedIdentity(res.user, res.access_token, generation);
    if (generation !== authGeneration.current) throw new Error('The active account changed');
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setMobileOnboardingPending(!res.user.mobile_number);
    setUpiOnboardingPending(res.user.credentials_set === false);
    setUser(res.user);
    setSessionMode('online');
    setSessionNotice(null);
    // Returned so the caller can route a first-time OAuth user (credentials_set === false)
    // through mandatory local-password setup instead of straight to the dashboard.
    return res.user;
  };

  const updateMobileNumber = async (
    mobileNumber: string | null,
    countryCode: CountryCode | null,
  ): Promise<User> => {
    const generation = authGeneration.current;
    if ((mobileNumber === null) !== (countryCode === null)) {
      throw new Error('Mobile number and country are required together');
    }
    const canonical = mobileNumber === null
      ? null
      : canonicalMobileNumber(mobileNumber, countryCode as CountryCode);
    const updated = await api<User>('/auth/me/mobile', {
      method: 'PATCH',
      body: { mobile_number: canonical, mobile_country_code: countryCode },
    });
    if (generation !== authGeneration.current) throw new Error('The active account changed');
    setUser(updated);
    await cacheVerifiedIdentity(updated, await getToken().catch(() => null), generation);
    return updated;
  };

  const completeMobileOnboarding = useCallback(() => {
    setMobileOnboardingPending(false);
  }, []);

  const updateUpiId = async (upiId: string | null): Promise<User> => {
    const generation = authGeneration.current;
    if (upiId !== null && !isValidUpiId(upiId)) {
      throw new Error(UPI_ID_INVALID_MESSAGE);
    }
    const normalized = upiId === null ? null : normalizeUpiId(upiId);
    const updated = await api<User>('/auth/me', {
      method: 'PATCH', body: { upi_id: normalized },
    });
    if (generation !== authGeneration.current) throw new Error('The active account changed');
    // Trust the server response for both the normalized value and its timestamp.
    setUser(updated);
    await cacheVerifiedIdentity(updated, await getToken().catch(() => null), generation);
    return updated;
  };

  const completeUpiOnboarding = useCallback(() => {
    setUpiOnboardingPending(false);
  }, []);

  const signOut = async (clearSavedEmail = false) => {
    // Best effort while the bearer token still exists. A failure never blocks logout; the next
    // authenticated foreground sync safely reassigns this installation and Expo token.
    await unregisterCurrentPushInstallation();
    await setToken(null);
    authGeneration.current += 1;
    offlineStore.setActiveAccount(null);
    lastVerifiedAt.current = 0;
    setOfflineDeadline(null);
    setMobileOnboardingPending(false);
    setUpiOnboardingPending(false);
    if (clearSavedEmail) {
      await AsyncStorage.removeItem(SAVED_EMAIL_KEY);
      setSavedEmail(null);
    }
    setUser(null);
    setSessionMode('online_required');
    setSessionNotice(null);
  };

  const finalizeAccountDeletion = async () => {
    // The server has already removed the device registration and invalidated the account. Clear
    // every local identity/navigation hint before exposing Login; a later registration is new.
    const accountId = user?.id;
    let cleanupFailed = false;
    if (accountId) {
      let markerWritten = false;
      try {
        await AsyncStorage.setItem(PENDING_LOCAL_PURGE_KEY, accountId);
        markerWritten = true;
      } catch {
        // Still attempt the purge when AsyncStorage is unavailable.
      }
      try {
        offlineStore.setActiveAccount(accountId);
        await offlineStore.purgeAccount(accountId);
        await purgeAccountChatOutbox(accountId);
        if (markerWritten) await AsyncStorage.removeItem(PENDING_LOCAL_PURGE_KEY);
      } catch {
        cleanupFailed = true;
      }
    }
    await Promise.allSettled([
      setToken(null),
      AsyncStorage.removeItem(SAVED_EMAIL_KEY),
      AsyncStorage.removeItem(PENDING_INVITE_KEY),
    ]);
    authGeneration.current += 1;
    offlineStore.setActiveAccount(null);
    lastVerifiedAt.current = 0;
    setOfflineDeadline(null);
    setSavedEmail(null);
    setPendingInvitePath(null);
    setMobileOnboardingPending(false);
    setUpiOnboardingPending(false);
    setUser(null);
    setSessionMode('online_required');
    setSessionNotice(cleanupFailed
      ? 'Account deleted. Local cleanup will retry when storage is available.' : null);
    if (cleanupFailed) {
      setOfflineStorageError('Local account cleanup needs another retry.');
      throw new Error('Account deleted; local cleanup needs retry');
    }
  };

  const pendingActionCount = useCallback(async (): Promise<number> => {
    return user ? offlineStore.pendingCount(user.id) : 0;
  }, [user]);

  const forgetSavedEmail = async () => {
    await AsyncStorage.removeItem(SAVED_EMAIL_KEY);
    setSavedEmail(null);
  };

  return (
    <AuthCtx.Provider value={{
      user,
      sessionMode,
      sessionNotice,
      offlineStorageError,
      savedEmail,
      emailFeaturesEnabled,
      inviteLinksEnabled,
      pendingInvitePath,
      mobileOnboardingPending,
      upiOnboardingPending,
      multiCurrencyCapability,
      multiCurrencyExpensesEnabled,
      chatCapability,
      refreshRuntimeConfig,
      refreshUserProfile,
      handleAuthenticationRequired,
      signIn,
      register,
      signInWithGoogle,
      updateMobileNumber,
      completeMobileOnboarding,
      updateUpiId,
      completeUpiOnboarding,
      signOut,
      finalizeAccountDeletion,
      forgetSavedEmail,
      refresh,
      pendingActionCount,
      rememberInvite,
      clearPendingInvite,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
