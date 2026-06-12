import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../src/ThemeContext';

export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.textMain,
      headerShadowVisible: false,
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ title: 'Create account' }} />
      <Stack.Screen name="pin-login" options={{ title: 'PIN Login' }} />
      <Stack.Screen name="forgot" options={{ title: 'Forgot password' }} />
      <Stack.Screen name="reset" options={{ title: 'Reset password' }} />
    </Stack>
  );
}
