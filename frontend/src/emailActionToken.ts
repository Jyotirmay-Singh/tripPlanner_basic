import { Platform } from 'react-native';

type Action = 'verify-email' | 'reset-password';
let pending: { action: Action; token: string } | undefined;

/** Capture once before the app renders; action tokens stay out of navigation/history. */
export function captureEmailActionToken(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const action = url.pathname.replace(/^\/|\/$/g, '');
  if (action !== 'verify-email' && action !== 'reset-password') return;
  const token = new URLSearchParams(url.hash.slice(1)).get('token') || url.searchParams.get('token');
  if (!token) return;
  pending = { action, token };
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
