import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { Ionicons } from '@expo/vector-icons';
import { Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold } from '@expo-google-fonts/outfit';
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree';
import { ThemeProvider, useTheme } from '../src/ThemeContext';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { LogoutProvider } from '../src/LogoutProvider';
import LogoutButton from '../src/LogoutButton';
import { ToastProvider } from '../src/ui';
import { FONTS } from '../src/theme';
import { authRedirectTarget, navResetTo, isPublicTokenRoute } from '../src/authNav';

// Keep the native splash up until our fonts are ready, so text never flashes in a fallback face.
SplashScreen.preventAutoHideAsync().catch(() => {});

function Inner() {
  const { mode, colors } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  // Declarative auth guard: redirect on any session change (logout, token expiry) and fully
  // reset the stack so back-navigation can't reach a signed-out screen. No-op while loading
  // (user === undefined) so the index splash shows.
  useEffect(() => {
    const target = authRedirectTarget(user, segments[0] === '(auth)', isPublicTokenRoute(segments[0]));
    if (target) navResetTo(router, target);
  }, [user, segments, router]);

  const headerRight = user ? () => <LogoutButton /> : undefined;
  return (
    <LogoutProvider>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textMain,
        headerTitleStyle: { fontFamily: FONTS.heading },
        contentStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerRight,
        animation: 'fade',
      }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="trip/[id]/index" options={{ title: 'Trip' }} />
        <Stack.Screen name="trip/[id]/add-member" options={{ title: 'Add Member', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/edit-member" options={{ title: 'Edit Member', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/manage-member" options={{ title: 'Manage Member', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/add-expense" options={{ title: 'Add Transaction', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/edit-expense" options={{ title: 'Edit Transaction', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/settle-up" options={{ title: 'Settle Up' }} />
        <Stack.Screen name="trip/[id]/edit" options={{ title: 'Edit Trip', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="trip/[id]/category/[name]" options={{ title: 'Category' }} />
        <Stack.Screen name="create-trip" options={{ title: 'Create Trip', presentation: 'modal', headerRight: undefined }} />
        <Stack.Screen name="join-trip" options={{ title: 'Join Trip', presentation: 'modal', headerRight: undefined }} />
        {/* Phase 9: email-link landing pages (work signed-out) + the one-time OAuth setup step. */}
        <Stack.Screen name="verify-email" options={{ headerShown: false }} />
        <Stack.Screen name="reset-password" options={{ headerShown: false }} />
        <Stack.Screen name="set-credentials" options={{ headerShown: false }} />
      </Stack>
    </LogoutProvider>
  );
}

export default function RootLayout() {
  // Load the brand typefaces (Outfit headings/numbers + Figtree body) and Ionicons glyphs.
  // We gate the first render on this so headings never paint in a fallback font; `error`
  // still releases the splash so a font CDN/cache failure can't wedge the app.
  const [loaded, error] = useFonts({
    ...Ionicons.font,
    Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold,
    Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold,
  });

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <Inner />
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
