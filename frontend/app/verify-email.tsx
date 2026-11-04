import React, { useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { SPACING } from '../src/theme';
import T from '../src/T';
import { AuthShell, Button, Icon, useToast } from '../src/ui';
import { clearEmailActionToken, readEmailActionToken, useEmailActionNavigation } from '../src/emailActionToken';

type Status = 'verifying' | 'success' | 'error' | 'idle';

// Landing page for the verification email link (top-level so it works whether or not the visitor
// is signed in — see PUBLIC_TOKEN_ROUTES). Only an explicit press consumes the token.
export default function VerifyEmail() {
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const { user, refresh, emailFeaturesEnabled } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState(() => readEmailActionToken('verify-email', params.token));
  const [status, setStatus] = useState<Status>('idle');
  const [recoveryEmail, setRecoveryEmail] = useState<string | null>(null);
  const [requestingReset, setRequestingReset] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  useEmailActionNavigation('verify-email', router.replace);

  const verify = async () => {
    if (!token.trim() || status === 'verifying') return;
    setStatus('verifying');
    try {
      const result = await api<{ password_reset_email?: string }>('/auth/verify-email', {
        method: 'POST', body: { token: token.trim() }, auth: false,
      });
      setRecoveryEmail(result?.password_reset_email || null);
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

  const requestReset = async () => {
    if (!recoveryEmail || requestingReset || emailFeaturesEnabled === false) return;
    setRequestingReset(true);
    try {
      await api('/auth/request-password-reset', {
        method: 'POST', body: { email: recoveryEmail }, auth: false,
      });
      setResetRequested(true);
    } catch (e: any) {
      toast.show(e.message || 'Could not request your reset link. Please try again.', 'error');
    } finally { setRequestingReset(false); }
  };

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
    if (recoveryEmail) {
      return (
        <AuthShell
          brandIcon={resetRequested ? 'mail' : 'shield-check'}
          title={resetRequested ? 'Check your email' : 'Email verified'}
          subtitle={resetRequested
            ? `Check ${recoveryEmail} for your password reset link.`
            : 'You can now reset your password using a secure email link.'}
        >
          {!resetRequested ? (
            <>
              <T muted testID="verify-recovery-email">We’ll send the reset link to {recoveryEmail}.</T>
              {emailFeaturesEnabled === false ? <T muted>Email recovery is temporarily unavailable. Please try again later.</T> : null}
              <Button
                label="Send password reset link"
                icon="mail"
                onPress={requestReset}
                loading={requestingReset}
                disabled={emailFeaturesEnabled === false}
                fullWidth
                size="lg"
                testID="verify-request-reset"
              />
            </>
          ) : <T muted>Open the link to choose a new password. Check your spam folder if the email doesn’t appear.</T>}
          <Button
            label={user ? 'Back to password settings' : 'Back to sign in'}
            variant={resetRequested ? 'primary' : 'ghost'}
            onPress={() => router.replace(user ? '/change-password' : '/(auth)/login')}
            fullWidth
            testID="verify-recovery-back"
          />
        </AuthShell>
      );
    }
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
