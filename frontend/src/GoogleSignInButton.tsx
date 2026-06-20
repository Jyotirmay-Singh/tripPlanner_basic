import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons'; // brand logo only (lucide has no brand glyphs)
import { useRouter } from 'expo-router';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS, FONTS } from './theme';
import T from './T';
import { useToast } from './ui';

WebBrowser.maybeCompleteAuthSession();

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || undefined;
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || undefined;
const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || undefined;

// The id-token auth hook validates that the client ID for the *current* platform is
// defined and throws if it isn't (e.g. "Client Id property 'androidClientId' must be
// defined to use Google auth on this platform"). Hooks can't be called conditionally,
// so we gate the hook-bearing component behind this check in the parent: an
// unconfigured platform hides the button instead of crashing the whole screen.
const PLATFORM_CLIENT_ID =
  Platform.OS === 'android' ? ANDROID_CLIENT_ID
  : Platform.OS === 'ios' ? IOS_CLIENT_ID
  : WEB_CLIENT_ID;

function GoogleSignInInner() {
  const { signInWithGoogle } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: WEB_CLIENT_ID,
    webClientId: WEB_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID,
    androidClientId: ANDROID_CLIENT_ID,
  });

  useEffect(() => {
    if (response?.type !== 'success') {
      if (response?.type === 'error') toast.show('Google sign-in failed. Try again.', 'error');
      return;
    }
    const idToken = response.params?.id_token || response.authentication?.idToken;
    if (!idToken) return;
    setLoading(true);
    signInWithGoogle(idToken)
      .then(() => router.replace('/(tabs)/dashboard'))
      .catch((e: any) => toast.show(e.message || 'Google sign-in failed', 'error'))
      .finally(() => setLoading(false));
  }, [response, router, signInWithGoogle, toast]);

  return (
    <Pressable
      testID="google-signin"
      disabled={!request || loading}
      onPress={() => promptAsync()}
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
  // Only mount the hook-bearing component when this platform's client ID is configured.
  if (!PLATFORM_CLIENT_ID) return null;
  return <GoogleSignInInner />;
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: RADIUS.pill, borderWidth: 1,
  },
});
