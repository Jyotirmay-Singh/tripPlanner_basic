import { useContext } from 'react';
import { LogoutContext } from './LogoutProvider';

// Thin accessor for the consolidated logout flow owned by LogoutProvider. The Profile "Sign out"
// row calls confirmAndSignOut(), so the confirm copy, redirect target, and behavior live in exactly
// one place (LogoutProvider).
export function useLogout() {
  return useContext(LogoutContext);
}
