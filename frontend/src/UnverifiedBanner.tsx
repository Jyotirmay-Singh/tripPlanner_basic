import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { api } from './api';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';
import { Icon, Button, useToast } from './ui';

// Soft-gate banner: shown on the dashboard when the signed-in user hasn't verified their email.
// `email_verified === undefined` (legacy payloads / OAuth) is treated as verified, so the banner
// only appears for genuinely-unverified accounts. Offers a rate-limited "resend" action.
export default function UnverifiedBanner() {
  const { user, refresh } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  if (!user || user.email_verified !== false) return null;

  const resend = async () => {
    setBusy(true);
    try {
      const res = await api<{ message?: string }>('/auth/resend-verification', { method: 'POST' });
      toast.show(res?.message || 'Verification email sent.', 'success');
      await refresh().catch(() => {});
    } catch (e: any) {
      toast.show(e.message || 'Could not send right now. Try again shortly.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <View
      testID="unverified-banner"
      style={[styles.wrap, { backgroundColor: colors.surfaceMuted, borderColor: colors.warning }]}
    >
      <View style={styles.row}>
        <Icon name="mail" size={20} color={colors.warning} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="h4">Verify your email</T>
          <T muted variant="caption">Check {user.email} for a verification link to secure your account.</T>
        </View>
      </View>
      <Button label="Resend email" icon="refresh" variant="ghost" size="sm" onPress={resend} loading={busy} testID="unverified-resend" />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.md, gap: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
});
