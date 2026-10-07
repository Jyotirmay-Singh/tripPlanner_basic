import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { subscribeFinancialChanges, publishFinancialChange } from './financialRefresh';
export default function useFinancialRefresh(accountId: string | undefined, tripId: string, refresh: () => unknown, active = true) {
  const current = useRef(refresh); current.current = refresh;
  useEffect(() => {
    if (!accountId || !tripId || !active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeFinancialChanges(event => {
      if (event.accountId !== accountId || event.tripId !== tripId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void current.current(); }, 150);
    });
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') publishFinancialChange({ accountId, tripId, reason: 'foreground' });
    });
    return () => { unsubscribe(); foreground.remove(); if (timer) clearTimeout(timer); };
  }, [accountId, tripId, active]);
}
