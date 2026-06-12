import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';

export default function Index() {
  const { user } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (user === undefined) return;
    if (user) router.replace('/(tabs)/dashboard');
    else router.replace('/(auth)/login');
  }, [user, router]);

  return (
    <View style={[styles.c, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
