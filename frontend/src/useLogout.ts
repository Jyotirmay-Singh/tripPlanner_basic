import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';

// Single source of truth for the logout flow. Both the header LogoutButton and the
// Profile "Sign out" row call this so the confirm copy, redirect target, and behavior
// never drift. signOut() is called with the default (clearSavedEmail = false) so the
// last-used email is preserved for PIN quick-login.
export function useLogout() {
  const { signOut } = useAuth();
  const router = useRouter();

  const confirmAndSignOut = () => {
    Alert.alert('Sign out?', '', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/(auth)/login');
        },
      },
    ]);
  };

  return { confirmAndSignOut };
}
