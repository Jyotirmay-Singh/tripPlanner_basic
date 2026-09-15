import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import {
  mobileSetupHref, passwordSetupHref, postAuthHref, upiSetupHref,
} from '../src/inviteNavigation';

export default function Index() {
  const {
    user, pendingInvitePath, mobileOnboardingPending, upiOnboardingPending,
  } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();

  useEffect(() => {
    if (user === undefined) return;
    if (user?.credentials_set === false) router.replace(passwordSetupHref(pendingInvitePath));
    else if (user && mobileOnboardingPending) router.replace(mobileSetupHref(pendingInvitePath));
    else if (user && upiOnboardingPending) router.replace(upiSetupHref(pendingInvitePath));
    else if (user) router.replace(postAuthHref(pendingInvitePath));
    else router.replace('/(auth)/login');
  }, [
    user, router, pendingInvitePath, mobileOnboardingPending, upiOnboardingPending,
  ]);

  return (
    <View style={[styles.c, { backgroundColor: colors.background }]}>
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
