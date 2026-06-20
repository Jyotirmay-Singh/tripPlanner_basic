import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import { Ionicons } from '@expo/vector-icons';
import { ThemeProvider, useTheme } from '../src/ThemeContext';
import { AuthProvider, useAuth } from '../src/AuthContext';
import { LogoutProvider } from '../src/LogoutProvider';
import LogoutButton from '../src/LogoutButton';
import { authRedirectTarget, navResetTo } from '../src/authNav';

function Inner() {
  const { mode, colors } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  // Declarative auth guard: redirect on any session change (logout, token expiry) and fully
  // reset the stack so back-navigation can't reach a signed-out screen. No-op while loading
  // (user === undefined) so the index splash shows.
  useEffect(() => {
    const target = authRedirectTarget(user, segments[0] === '(auth)');
    if (target) navResetTo(router, target);
  }, [user, segments, router]);

  const headerRight = user ? () => <LogoutButton /> : undefined;
  return (
    <LogoutProvider>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textMain,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.background },
        headerShadowVisible: false,
        headerRight,
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
      </Stack>
    </LogoutProvider>
  );
}

export default function RootLayout() {
  // Preload Ionicons font explicitly so all icons render in Expo Go even with a fresh cache.
  // Non-blocking — if the font fails (stale Expo Go asset cache), we still render UI;
  // every icon-only button also has a visible text label so the app stays usable.
  useFonts({ ...Ionicons.font });

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <Inner />
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
