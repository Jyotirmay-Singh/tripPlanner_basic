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
  const { user, emailFeaturesEnabled } = useAuth();
  // Prefill restored sessions too, without overwriting an address the user has edited.
  const [emailInput, setEmailInput] = useState<string | null>(null);
  const email = emailInput ?? user?.email ?? '';
  const emailUnavailable = emailFeaturesEnabled === false;
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
        subtitle="If an account exists for that address, we've sent a link to reset your password."
      >
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
      title="Forgot password"
      subtitle="Enter your email and we'll send you a link to reset your password."
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
      {emailUnavailable ? (
        <T variant="caption" muted testID="forgot-pw-unavailable">
          Email password recovery is temporarily unavailable. Please try again later.
        </T>
      ) : null}
      <Button
        label={busy ? 'Sending…' : 'Send reset link'}
        icon="mail"
        onPress={submit}
        loading={busy}
        disabled={emailUnavailable}
        fullWidth
        size="lg"
        testID="forgot-pw-submit"
      />
    </AuthShell>
  );
}
