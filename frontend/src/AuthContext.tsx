import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, getToken, setToken } from './api';

export type User = { id: string; email: string; name: string; role: string };

const SAVED_EMAIL_KEY = 'last_login_email';

type Ctx = {
  user: User | null | undefined; // undefined = loading
  savedEmail: string | null;
  signIn: (email: string, password?: string, pin?: string) => Promise<void>;
  register: (email: string, pin: string, name: string, password?: string) => Promise<void>;
  signInWithGoogle: (idToken: string) => Promise<void>;
  signOut: (clearSavedEmail?: boolean) => Promise<void>;
  forgetSavedEmail: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthCtx = createContext<Ctx>({} as Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [t, e] = await Promise.all([getToken(), AsyncStorage.getItem(SAVED_EMAIL_KEY)]);
    setSavedEmail(e);
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

  const signIn = async (email: string, password?: string, pin?: string) => {
    const body: any = { email };
    if (password) body.password = password;
    if (pin) body.pin = pin;
    const res = await api<{ access_token: string; user: User }>('/auth/login', {
      method: 'POST', body, auth: false,
    });
    await setToken(res.access_token);
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
  };

  const register = async (email: string, pin: string, name: string, password?: string) => {
    const body: any = { email, pin, name };
    if (password) body.password = password;
    const res = await api<{ access_token: string; user: User }>('/auth/register', {
      method: 'POST', body, auth: false,
    });
    await setToken(res.access_token);
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
  };

  const signInWithGoogle = async (idToken: string) => {
    const res = await api<{ access_token: string; user: User }>('/auth/google', {
      method: 'POST', body: { id_token: idToken }, auth: false,
    });
    await setToken(res.access_token);
    await AsyncStorage.setItem(SAVED_EMAIL_KEY, res.user.email);
    setSavedEmail(res.user.email);
    setUser(res.user);
  };

  const signOut = async (clearSavedEmail = false) => {
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
    <AuthCtx.Provider value={{ user, savedEmail, signIn, register, signInWithGoogle, signOut, forgetSavedEmail, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
