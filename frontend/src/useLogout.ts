import { useContext } from 'react';
import { LogoutContext } from './LogoutProvider';

// Thin accessor for the consolidated logout flow owned by LogoutProvider. Both the header
// LogoutButton and the Profile "Sign out" row call confirmAndSignOut(), so the confirm copy,
// redirect target, and behavior live in exactly one place (LogoutProvider).
export function useLogout() {
  return useContext(LogoutContext);
}
