import React, { createContext, useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import ConfirmModal from './ConfirmModal';
import { AUTH_LOGIN_HREF, navResetTo, performSignOut } from './authNav';

// Single source of truth for the logout flow. Mounted once near the root so exactly one
// themed ConfirmModal exists; the Profile "Sign out" row triggers it via useLogout() (the header
// now shows a ProfileAvatarButton that routes to Profile instead of signing out). A native Alert
// can't be used here — it has no buttons on web — and a hook alone can't mount a Modal, which is
// why the flow lives in a provider.
type LogoutCtx = { confirmAndSignOut: () => void };

export const LogoutContext = createContext<LogoutCtx>({ confirmAndSignOut: () => {} });

export function LogoutProvider({ children }: { children: React.ReactNode }) {
  const { signOut, pendingActionCount } = useAuth();
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const [pendingCount, setPendingCount] = useState<number | null>(0);
  const [signOutFailed, setSignOutFailed] = useState(false);

  const confirmAndSignOut = useCallback(() => {
    setSignOutFailed(false);
    setPendingCount(null);
    setVisible(true);
    void pendingActionCount().then(setPendingCount).catch(() => setPendingCount(null));
  }, [pendingActionCount]);

  const doSignOut = useCallback(() => {
    setVisible(false);
    // signOut() keeps the saved email (clearSavedEmail defaults to false) for faster sign-in.
    void performSignOut(signOut, () => navResetTo(router, AUTH_LOGIN_HREF)).catch(() => {
      setSignOutFailed(true);
      setVisible(true);
    });
  }, [signOut, router]);

  return (
    <LogoutContext.Provider value={{ confirmAndSignOut }}>
      {children}
      <ConfirmModal
        visible={visible}
        title="Sign out?"
        message={signOutFailed
          ? 'Could not sign out. Try again when device storage is available.'
          : pendingCount === null
          ? 'Pending actions could not be checked. Any saved actions stay on this device for the same account. You will need to sign in again.'
          : pendingCount > 0
            ? `${pendingCount} pending action${pendingCount === 1 ? '' : 's'} will stay on this device and will not sync until the same account signs in again.`
            : "You'll need your password or Google account to sign back in."}
        onRequestClose={() => setVisible(false)}
        testID="logout-confirm"
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setVisible(false), testID: 'logout-confirm-cancel' },
          { label: 'Sign out', variant: 'destructive', onPress: doSignOut, testID: 'logout-confirm-yes' },
        ]}
      />
    </LogoutContext.Provider>
  );
}
