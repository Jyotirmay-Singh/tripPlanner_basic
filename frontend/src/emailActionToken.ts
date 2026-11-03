import { Platform } from 'react-native';
import { useEffect } from 'react';

type Action = 'verify-email' | 'reset-password';
let pending: { action: Action; token: string; navigationScrubbed: boolean } | undefined;

/** Capture once before the app renders; action tokens stay out of navigation/history. */
export function captureEmailActionToken(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const action = url.pathname.replace(/^\/|\/$/g, '');
  if (action !== 'verify-email' && action !== 'reset-password') return;
  const token = new URLSearchParams(url.hash.slice(1)).get('token') || url.searchParams.get('token');
  if (!token) return;
  if (pending?.action !== action || pending.token !== token) {
    pending = { action, token, navigationScrubbed: false };
  }
  url.hash = '';
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url.pathname + url.search);
}

export function readEmailActionToken(action: Action, nativeToken?: string): string {
  return pending?.action === action ? pending.token : nativeToken || '';
}

export function clearEmailActionToken(action: Action): void {
  if (pending?.action === action) pending = undefined;
}

export function finishEmailActionNavigation(action: Action, replace: (path: `/${Action}`) => void): void {
  if (Platform.OS !== 'web') return;
  captureEmailActionToken();
  if (pending?.action === action && !pending.navigationScrubbed) {
    pending.navigationScrubbed = true;
    // Expo may restore its initial fragment after the early history scrub. Replacing the
    // router state as well prevents later navigation from bringing that fragment back.
    replace(`/${action}`);
  }
}

export function useEmailActionNavigation(action: Action, replace: (path: `/${Action}`) => void): void {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const timer = setTimeout(() => finishEmailActionNavigation(action, replace), 0);
    return () => clearTimeout(timer);
  }, [action, replace]);
}
