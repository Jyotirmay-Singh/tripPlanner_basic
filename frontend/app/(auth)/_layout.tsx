import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../src/ThemeContext';
import { FONTS } from '../../src/theme';

export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.textMain,
      headerTitleStyle: { fontFamily: FONTS.heading },
      headerShadowVisible: false,
      headerBackTitle: '',
      contentStyle: { backgroundColor: colors.background },
      animation: 'fade',
    }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="register" options={{ title: '' }} />
      <Stack.Screen name="pin-login" options={{ title: '' }} />
      <Stack.Screen name="forgot" options={{ title: '' }} />
      <Stack.Screen name="reset" options={{ title: '' }} />
    </Stack>
  );
}
