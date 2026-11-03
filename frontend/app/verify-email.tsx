import React, { useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { SPACING } from '../src/theme';
import { AuthShell, Button, Icon, useToast } from '../src/ui';
import { clearEmailActionToken, readEmailActionToken, useEmailActionNavigation } from '../src/emailActionToken';

type Status = 'verifying' | 'success' | 'error' | 'idle';

// Landing page for the verification email link (top-level so it works whether or not the visitor
// is signed in — see PUBLIC_TOKEN_ROUTES). Only an explicit press consumes the token.
export default function VerifyEmail() {
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { user, refresh } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState(() => readEmailActionToken('verify-email', params.token));
  const [status, setStatus] = useState<Status>('idle');
  useEmailActionNavigation('verify-email', router.replace);

  const verify = async () => {
    if (!token.trim()) return;
    setStatus('verifying');
    try {
      await api('/auth/verify-email', { method: 'POST', body: { token: token.trim() }, auth: false });
      setStatus('success');
      setToken('');
      clearEmailActionToken('verify-email');
      await refresh().catch(() => {}); // clear the unverified banner if signed in
    } catch (e: any) {
      setStatus('error');
      toast.show(e.message || 'This link is invalid or has expired.', 'error');
    }
  };

  const goOn = () => router.replace(user ? '/(tabs)/dashboard' : '/(auth)/login');

  if (status === 'verifying') {
    return (
      <AuthShell brandIcon="mail" title="Verifying your email" subtitle="Just a moment…">
        <View style={{ alignItems: 'center', marginTop: SPACING.md }}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </AuthShell>
    );
  }

  if (status === 'success') {
    return (
      <AuthShell brandIcon="check-circle" title="Email verified" subtitle="Your account is all set.">
        <View style={{ alignItems: 'center', gap: SPACING.md }}>
          <Icon name="shield-check" size={40} color={colors.success} />
          <Button label="Continue" icon="check" onPress={goOn} fullWidth size="lg" testID="verify-continue" />
        </View>
      </AuthShell>
    );
  }

  if (!token.trim()) {
    return (
      <AuthShell
        brandIcon="mail"
        title="Open your verification email"
        subtitle="Open the verification link in your email to continue. You can request a new email from your dashboard."
      >
        <Button
          label={user ? 'Go to dashboard' : 'Sign in to request a new link'}
          onPress={goOn}
          fullWidth
          size="lg"
          testID="verify-back"
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      brandIcon="mail"
      title="Verify your email"
      subtitle="Confirm that you want to verify the email address this link was sent to."
    >
      <Button label="Verify email" icon="check" onPress={verify} fullWidth size="lg" testID="verify-submit" />
      <Button label={user ? 'Go to dashboard' : 'Back to sign in'} variant="ghost" onPress={goOn} fullWidth testID="verify-back" />
    </AuthShell>
  );
}
