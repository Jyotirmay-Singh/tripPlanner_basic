import React, { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Ionicons } from '@expo/vector-icons'; // brand logo only (lucide has no brand glyphs)
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS, FONTS } from './theme';
import T from './T';
import { useToast } from './ui';

type NitroGoogleSignInModule = typeof import('react-native-nitro-google-signin');

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() || undefined;

export function isAndroidGoogleAuthAvailable(
  webClientId: string | null | undefined,
  executionEnvironment: ExecutionEnvironment | string,
) {
  return !!webClientId?.trim() && executionEnvironment !== ExecutionEnvironment.StoreClient;
}

// Nitro is native code and is intentionally unavailable in Expo Go. Hiding the button there keeps
// the rest of the app usable; Android development/preview/production builds include the module.
export const googleAuthAvailable = isAndroidGoogleAuthAvailable(
  WEB_CLIENT_ID,
  Constants.executionEnvironment,
);

let nitroModule: NitroGoogleSignInModule | null = null;

async function loadNitroGoogleSignIn(): Promise<NitroGoogleSignInModule> {
  if (nitroModule) return nitroModule;
  // Keep the native package behind a runtime require. Metro includes it in native builds but does
  // not evaluate it in Expo Go, where this component returns null before a press is possible.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require('react-native-nitro-google-signin') as NitroGoogleSignInModule;
  nitroModule = loaded;
  return loaded;
}

function errorCode(error: unknown) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function nativeErrorMessage(error: unknown): string | null {
  switch (errorCode(error)) {
    case 'SIGN_IN_CANCELLED':
    case 'IN_PROGRESS':
      return null;
    case 'PLAY_SERVICES_NOT_AVAILABLE':
      return 'Update Google Play Services to continue.';
    case 'DEVELOPER_ERROR':
      return 'Google sign-in is not configured for this app build.';
    default:
      return 'Google sign-in failed. Try again.';
  }
}

function GoogleSignInInner() {
  const { signInWithGoogle } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const signInInFlight = useRef(false);

  const handlePress = async () => {
    // Pressable's disabled state follows React state, while this ref closes the small interval
    // before the state update is committed and prevents two Credential Manager requests.
    if (signInInFlight.current || !WEB_CLIENT_ID) return;
    signInInFlight.current = true;
    setLoading(true);

    try {
      const google = await loadNitroGoogleSignIn();
      google.GoogleOneTapSignIn.configure({
        webClientId: WEB_CLIENT_ID,
        offlineAccess: false,
      });
      await google.GoogleOneTapSignIn.checkPlayServices();
      const response = await google.GoogleOneTapSignIn.presentExplicitSignIn();

      if (google.isCancelledResponse(response)) return;
      if (!google.isSuccessResponse(response)) {
        toast.show('Google sign-in failed. Try again.', 'error');
        return;
      }

      const idToken = response.data.idToken?.trim();
      if (!idToken) {
        toast.show('Google sign-in failed. Try again.', 'error');
        return;
      }

      try {
        const user = await signInWithGoogle(idToken);
        // A first-time Google user still completes Trip Splitter's one-time PIN/password setup.
        router.replace(user.credentials_set === false ? '/set-credentials' : '/(tabs)/dashboard');
      } catch (error) {
        const message = error instanceof Error && error.message
          ? error.message
          : 'Google sign-in failed. Try again.';
        toast.show(message, 'error');
      }
    } catch (error) {
      const message = nativeErrorMessage(error);
      if (message) toast.show(message, 'error');
    } finally {
      signInInFlight.current = false;
      setLoading(false);
    }
  };

  return (
    <Pressable
      testID="google-signin"
      disabled={loading}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel="Continue with Google"
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      {loading ? <ActivityIndicator color={colors.textMain} /> : (
        <>
          <Ionicons name="logo-google" size={18} color={colors.textMain} />
          <T style={{ marginLeft: SPACING.sm, fontFamily: FONTS.bodyBold }}>Continue with Google</T>
        </>
      )}
    </Pressable>
  );
}

export default function GoogleSignInButton() {
  if (!googleAuthAvailable) return null;
  return <GoogleSignInInner />;
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: RADIUS.pill, borderWidth: 1,
  },
});
