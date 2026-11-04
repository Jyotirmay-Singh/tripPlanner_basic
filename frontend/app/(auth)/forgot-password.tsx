import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { api } from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import T from '../../src/T';
import { isGmail, GMAIL_ONLY_MESSAGE } from '../../src/validation';
import { AuthShell, Input, Button, useToast } from '../../src/ui';

// Forgot-password email flow. The generic confirmation never reveals whether an account exists.
export default function ForgotPassword() {
  const router = useRouter();
  const toast = useToast();
  const { user, savedEmail, emailFeaturesEnabled, sessionMode } = useAuth();
  // Prefill restored sessions too, without overwriting an address the user has edited.
  const [emailInput, setEmailInput] = useState<string | null>(null);
  const email = emailInput ?? user?.email ?? savedEmail ?? '';
  const offline = sessionMode === 'offline';
  const emailUnavailable = emailFeaturesEnabled === false || offline;
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const emailError = submitError || (!!email && !isGmail(email) ? GMAIL_ONLY_MESSAGE : null);

  const submit = async () => {
    if (busy || emailUnavailable) return;
    if (!email.trim()) {
      setSubmitError('Enter your email');
      return toast.show('Enter your email', 'error');
    }
    if (!isGmail(email)) {
      setSubmitError(GMAIL_ONLY_MESSAGE);
      return toast.show(GMAIL_ONLY_MESSAGE, 'error');
    }
    setSubmitError(null);
    setBusy(true);
    try {
      await api('/auth/request-password-reset', { method: 'POST', body: { email: email.trim() }, auth: false });
      setSent(true);
    } catch (e: any) {
      toast.show(e.message || 'Something went wrong. Try again.', 'error');
    } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <AuthShell
        nativeHeader
        brandIcon="mail"
        title="Check your email"
        subtitle="If an account exists for that address, you'll receive an email with your next step."
      >
        <T testID="forgot-pw-next-steps">Already verified? Follow the password reset link. Otherwise, verify your email first, then continue to request your reset link.</T>
        <T muted variant="caption">Check your spam folder too. If you recently requested an email, use the latest link or wait a minute before trying again.</T>
        <Button
          label={user ? 'Back to password settings' : 'Back to sign in'}
          icon="chevron-left"
          onPress={() => router.replace(user ? '/change-password' : '/(auth)/login')}
          fullWidth
          size="lg"
          testID="forgot-pw-back"
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      nativeHeader
      brandIcon="lock"
      title="Reset your password"
      subtitle="Enter your account email to recover access."
    >
      <Input
        testID="forgot-pw-email"
        label="Email"
        value={email}
        onChangeText={(value) => { setEmailInput(value); setSubmitError(null); }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        placeholder="you@gmail.com"
        icon="mail"
        error={emailError}
        focusOnError={!!submitError}
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <T muted variant="caption" testID="forgot-pw-verification-note">For your security, an unverified email must be verified before you can reset your password.</T>
      {emailUnavailable ? (
        <T variant="caption" muted testID="forgot-pw-unavailable">
          {offline ? 'Connect to the internet to recover your password.'
            : 'Email password recovery is temporarily unavailable. Please try again later.'}
        </T>
      ) : null}
      <Button
        label={busy ? 'Sending…' : 'Send recovery email'}
        icon="mail"
        onPress={submit}
        loading={busy}
        disabled={emailUnavailable}
        fullWidth
        size="lg"
        testID="forgot-pw-submit"
      />
      <Button
        label={user ? 'Back to password settings' : 'Back to sign in'}
        variant="ghost"
        onPress={() => router.replace(user ? '/change-password' : '/(auth)/login')}
        fullWidth
        testID="forgot-pw-cancel"
      />
    </AuthShell>
  );
}
