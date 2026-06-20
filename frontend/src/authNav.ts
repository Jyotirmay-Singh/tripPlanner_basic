import type { Href } from 'expo-router';
import type { User } from './AuthContext';

// Pure auth-navigation helpers, kept free of React/JSX so they can be unit-tested
// without a component renderer (the project has no @testing-library/react-native).

export const AUTH_LOGIN_HREF = '/(auth)/login' as Href;
export const DASHBOARD_HREF = '/(tabs)/dashboard' as Href;

// Decision table for the root layout's declarative auth guard.
// `user === undefined` means the session is still loading — stay put so the splash shows.
export function authRedirectTarget(
  user: User | null | undefined,
  inAuthGroup: boolean,
): Href | null {
  if (user === undefined) return null;
  if (!user && !inAuthGroup) return AUTH_LOGIN_HREF;
  if (user && inAuthGroup) return DASHBOARD_HREF;
  return null;
}

// Orchestrates the single logout sequence: drop the session, then navigate.
// `navigate` is a plain callback so this stays router-agnostic and testable.
export async function performSignOut(
  signOut: () => Promise<void>,
  navigate: () => void,
): Promise<void> {
  await signOut();
  navigate();
}

// Minimal structural shape of the expo-router imperative router we depend on.
type NavRouter = {
  canDismiss?: () => boolean;
  dismissAll: () => void;
  replace: (href: Href) => void;
};

// Fully tears down the current (authenticated) stack before landing on `href`, so
// hardware-back can't return to a now-signed-out screen.
export function navResetTo(router: NavRouter, href: Href): void {
  if (router.canDismiss?.()) router.dismissAll();
  router.replace(href);
}
