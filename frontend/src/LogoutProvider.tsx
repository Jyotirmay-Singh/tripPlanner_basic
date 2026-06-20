import React, { createContext, useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import ConfirmModal from './ConfirmModal';
import { AUTH_LOGIN_HREF, navResetTo, performSignOut } from './authNav';

// Single source of truth for the logout flow. Mounted once near the root so exactly one
// themed ConfirmModal exists; both the header LogoutButton and the Profile "Sign out" row
// trigger it via useLogout(). A native Alert can't be used here — it has no buttons on web —
// and a hook alone can't mount a Modal, which is why the flow lives in a provider.
type LogoutCtx = { confirmAndSignOut: () => void };

export const LogoutContext = createContext<LogoutCtx>({ confirmAndSignOut: () => {} });

export function LogoutProvider({ children }: { children: React.ReactNode }) {
  const { signOut } = useAuth();
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  const confirmAndSignOut = useCallback(() => setVisible(true), []);

  const doSignOut = useCallback(() => {
    setVisible(false);
    // signOut() keeps the saved email (clearSavedEmail defaults to false) for PIN quick-login.
    performSignOut(signOut, () => navResetTo(router, AUTH_LOGIN_HREF));
  }, [signOut, router]);

  return (
    <LogoutContext.Provider value={{ confirmAndSignOut }}>
      {children}
      <ConfirmModal
        visible={visible}
        title="Sign out?"
        message="You'll need your PIN to sign back in."
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
