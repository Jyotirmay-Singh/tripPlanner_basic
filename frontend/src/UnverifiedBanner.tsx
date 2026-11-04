import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { api } from './api';
import { useAuth } from './AuthContext';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';
import { Icon, IconButton, Button, useToast } from './ui';

// Dismissal hides only the Dashboard reminder; Profile keeps a verification action available.
// Neither dismissal nor requesting an email changes verification status.
export default function UnverifiedBanner({ dismissible = true }: { dismissible?: boolean }) {
  const {
    user, refresh, emailFeaturesEnabled, verificationReminderDismissed, dismissVerificationReminder,
    sessionMode,
  } = useAuth();
  const { colors } = useTheme();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const offline = sessionMode === 'offline';
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  // Hidden while email flows are ghosted (only an explicit false hides it, so mocks/loading
  // that omit the flag keep the existing behavior).
  if (emailFeaturesEnabled === false) return null;
  if (!user || user.email_verified !== false) return null;
  if (dismissible && verificationReminderDismissed) return null;

  const resend = async () => {
    if (offline || busy || remaining > 0) return;
    setBusy(true);
    try {
      const res = await api<{ message?: string }>('/auth/resend-verification', { method: 'POST' });
      toast.show(res?.message || 'Verification email sent.', 'success');
      setRemaining(60);
      await refresh().catch(() => {});
    } catch (e: any) {
      if (e.retryAfterMs) setRemaining(Math.ceil(e.retryAfterMs / 1000));
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
        <View style={styles.copy}>
          <T variant="h4">Verify your email</T>
          <T muted variant="caption">Confirm {user.email} to secure your account.</T>
        </View>
        {dismissible ? (
          <IconButton
            name="close"
            size={20}
            color={colors.textMuted}
            accessibilityLabel="Dismiss email verification reminder"
            testID="unverified-dismiss"
            onPress={dismissVerificationReminder}
          />
        ) : null}
      </View>
      {offline ? <T muted variant="caption">Connect to the internet to request a verification email.</T> : null}
      <Button
        label={remaining ? `Resend in ${remaining}s` : 'Send verification email'}
        icon="mail"
        variant="ghost"
        size="sm"
        onPress={resend}
        loading={busy}
        disabled={offline || remaining > 0}
        testID="unverified-resend"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACING.md, gap: SPACING.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  copy: { flex: 1, minWidth: 0 },
});
