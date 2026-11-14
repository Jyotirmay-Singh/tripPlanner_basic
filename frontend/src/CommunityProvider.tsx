import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from './AuthContext';
import { ApiError } from './api';
import { COMMUNITY_TERMS_VERSION, getCommunityState, type CommunityState } from './communitySafety';

type CommunityContext = { state: CommunityState | null; loading: boolean; error: string | null; refresh: () => Promise<void> };
const Context = createContext<CommunityContext | null>(null);

export function CommunityProvider({ children }: { children: React.ReactNode }) {
  const { user, sessionMode, refreshUserProfile } = useAuth();
  const accountId = user?.id;
  const [state, setState] = useState<CommunityState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const activeAccount = useRef(accountId);
  const stateOwner = useRef<string | undefined>(undefined);
  activeAccount.current = accountId;
  const profile = useRef(user);
  profile.current = user;

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!accountId) { setState(null); setLoading(false); setError(null); return; }
    if (sessionMode === 'offline') {
      const cached = profile.current;
      stateOwner.current = accountId;
      setState(cached?.community_terms_version === COMMUNITY_TERMS_VERSION && cached.community_permissions ? {
        terms_version: COMMUNITY_TERMS_VERSION, accepted: true, age_band: cached.community_age_band,
        permissions: cached.community_permissions, suspended: false, blocks: [], children: [],
      } : null);
      setError(cached?.community_permissions ? null : 'Connect once to review Community safety before using saved groups.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await getCommunityState();
      if (request !== generation.current || accountId !== activeAccount.current) return;
      stateOwner.current = accountId;
      setState(result);
      setError(null);
    } catch (failure: any) {
      if (request !== generation.current || accountId !== activeAccount.current) return;
      if (failure instanceof ApiError && (failure.code === 'network' || failure.code === 'timeout'
        || (failure.code === 'http' && !!failure.status && (failure.status >= 500 || failure.status === 429)))) {
        // Let authentication enforce its cached-session deadline. A transient safety
        // request failure must not turn a previously verified account into a denial.
        void refreshUserProfile().catch(() => {});
        setError(failure.message);
        return;
      }
      stateOwner.current = accountId;
      setState(null);
      setError(failure?.message || 'Community settings could not be loaded. Try again.');
    } finally {
      if (request === generation.current && accountId === activeAccount.current) setLoading(false);
    }
  }, [accountId, sessionMode, refreshUserProfile]);

  useEffect(() => {
    setState(null);
    void refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh();
    }, 30_000);
    return () => { generation.current += 1; clearInterval(timer); subscription.remove(); };
  }, [refresh]);

  const accountState = stateOwner.current === accountId ? state : null;
  const accountLoading = loading || (!!accountId && stateOwner.current !== accountId);
  return <Context.Provider value={{ state: accountState, loading: accountLoading, error, refresh }}>{children}</Context.Provider>;
}

export function useCommunity() {
  const context = useContext(Context);
  if (!context) throw new Error('CommunityProvider is required');
  return context;
}
