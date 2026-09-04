import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, getToken, setToken } from './api';
import type { ChatCapability } from './chat';
import { unregisterCurrentPushInstallation } from './pushNotifications';

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  // Phase 9 (additive, optional so older payloads stay valid): email verification + whether a
  // Google-created account has configured its required local password.
  email_verified?: boolean;
  credentials_set?: boolean;
};

const SAVED_EMAIL_KEY = 'last_login_email';
const PENDING_INVITE_KEY = 'pending_invite_path_v1';

type Ctx = {
  user: User | null | undefined; // undefined = loading
  savedEmail: string | null;
  // Runtime feature flag from GET /meta/config. When false, the email-verification banner and the
  // "Forgot password?" link are hidden (those flows are ghosted until a deliverable domain exists).
  // Defaults to true so nothing is hidden while it loads or if the fetch fails.
  emailFeaturesEnabled: boolean;
  inviteLinksEnabled: boolean;
  pendingInvitePath: string | null;
  multiCurrencyExpensesEnabled: boolean;
  chatCapability: ChatCapability;
  handleAuthenticationRequired: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  signInWithGoogle: (idToken: string) => Promise<User>;
  signOut: (clearSavedEmail?: boolean) => Promise<void>;
  forgetSavedEmail: () => Promise<void>;
  refresh: () => Promise<void>;
  rememberInvite: (path: string) => Promise<void>;
  clearPendingInvite: () => Promise<void>;
};

const AuthCtx = createContext<Ctx>({} as Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const [emailFeaturesEnabled, setEmailFeaturesEnabled] = useState(true);
  const [inviteLinksEnabled, setInviteLinksEnabled] = useState(false);
  const [pendingInvitePath, setPendingInvitePath] = useState<string | null>(null);
  const [multiCurrencyExpensesEnabled, setMultiCurrencyExpensesEnabled] = useState(false);
  const [chatCapability, setChatCapability] = useState<ChatCapability>('loading');

  // Public, DB-free capability fetch. A successful response without the chat protocol identifies
  // an older backend; a request failure remains unknown so a temporary config outage does not
  // incorrectly disable chat.
  useEffect(() => {
    api<{
      email_features_enabled?: boolean;
      invite_links_enabled?: boolean;
      chat_protocol_version?: number;
      multi_currency_expenses_enabled?: boolean;
    }>('/meta/config', { auth: false })
      .then((config) => {
        setEmailFeaturesEnabled(config?.email_features_enabled !== false);
        setInviteLinksEnabled(config?.invite_links_enabled === true);
        setMultiCurrencyExpensesEnabled(config?.multi_currency_expenses_enabled === true);
        setChatCapability(config?.chat_protocol_version === 1 ? 'supported' : 'unsupported');
      })
      .catch(() => setChatCapability('unknown'));
  }, []);

  const handleAuthenticationRequired = useCallback(async () => {
    await setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const [t, e, pending] = await Promise.all([
      getToken(), AsyncStorage.getItem(SAVED_EMAIL_KEY), AsyncStorage.getItem(PENDING_INVITE_KEY),
    ]);
    setSavedEmail(e);
    // A freshly opened deep link can be remembered while this startup read is still in flight.
    // Never let an older null read overwrite that newer in-memory invitation.
    setPendingInvitePath((current) => pending ?? current);
    if (!t) { setUser(null); return; }
    try {
      const u = await api<User>('/auth/me');
      setUser(u);
    } catch {
      await setToken(null);
      setUser(null);
    }
  }, []);

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
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
  };

  const register = async (email: string, name: string, password: string) => {
    const res = await api<{ access_token: string; user: User }>('/auth/register', {
      method: 'POST', body: { email, name, password }, auth: false,
    });
    await setToken(res.access_token);
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
  };

  const signInWithGoogle = async (idToken: string): Promise<User> => {
    const res = await api<{ access_token: string; user: User }>('/auth/google', {
      method: 'POST', body: { id_token: idToken }, auth: false,
    });
    await setToken(res.access_token);
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
    // Returned so the caller can route a first-time OAuth user (credentials_set === false)
    // through mandatory local-password setup instead of straight to the dashboard.
    return res.user;
  };

  const signOut = async (clearSavedEmail = false) => {
    // Best effort while the bearer token still exists. A failure never blocks logout; the next
    // authenticated foreground sync safely reassigns this installation and Expo token.
    await unregisterCurrentPushInstallation();
    await setToken(null);
    if (clearSavedEmail) {
      await AsyncStorage.removeItem(SAVED_EMAIL_KEY);
      setSavedEmail(null);
    }
    setUser(null);
  };

  const forgetSavedEmail = async () => {
    await AsyncStorage.removeItem(SAVED_EMAIL_KEY);
    setSavedEmail(null);
  };

  return (
    <AuthCtx.Provider value={{
      user,
      savedEmail,
      emailFeaturesEnabled,
      inviteLinksEnabled,
      pendingInvitePath,
      multiCurrencyExpensesEnabled,
      chatCapability,
      handleAuthenticationRequired,
      signIn,
      register,
      signInWithGoogle,
      signOut,
      forgetSavedEmail,
      refresh,
      rememberInvite,
      clearPendingInvite,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
