import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { SPACING } from '../src/theme';
import { AuthShell, Input, Button, Icon, useToast } from '../src/ui';

type Status = 'verifying' | 'success' | 'error' | 'idle';

// Landing page for the verification email link (top-level so it works whether or not the visitor
// is signed in — see PUBLIC_TOKEN_ROUTES). Auto-submits the token from the URL on mount.
export default function VerifyEmail() {
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { user, refresh } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState((params.token as string) || '');
  const [status, setStatus] = useState<Status>(params.token ? 'verifying' : 'idle');

  const verify = async (t: string) => {
    if (!t) return toast.show('Enter the token from your email', 'error');
    setStatus('verifying');
    try {
      await api('/auth/verify-email', { method: 'POST', body: { token: t.trim() }, auth: false });
      setStatus('success');
      await refresh().catch(() => {}); // clear the unverified banner if signed in
    } catch (e: any) {
      setStatus('error');
      toast.show(e.message || 'This link is invalid or has expired.', 'error');
    }
  };

  // Auto-verify once if a token arrived in the URL.
  useEffect(() => {
    if (params.token) verify(params.token as string);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // idle (manual entry) or error — let the user paste/retry the token.
  return (
    <AuthShell
      brandIcon="mail"
      title="Verify your email"
      subtitle="Paste the token from your verification email."
    >
      <Input
        testID="verify-token"
        label="Verification token"
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        placeholder="Token from email"
        icon="key"
      />
      <Button label="Verify email" icon="check" onPress={() => verify(token)} fullWidth size="lg" testID="verify-submit" />
      <Button label="Back to sign in" variant="ghost" onPress={goOn} fullWidth testID="verify-back" />
    </AuthShell>
  );
}
